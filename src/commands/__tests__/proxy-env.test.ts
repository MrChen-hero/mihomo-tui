/**
 * proxy on/off/status/init 的双层测试：纯函数层直接断言 shell 代码内容，
 * CLI 层经 tsx 子进程 + 假内核走完整 emit-eval 契约。
 * --start 不做端到端测试（会触碰 systemd），属已知边界。
 */
import { createServer, type Server } from 'node:http'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildProxyInitScript, buildProxyOffScript, buildProxyOnScript, ON_VARS, OPTIONAL_VARS,
  UNSET_VARS } from '../proxyEnv.js'

describe('shell 代码生成（纯函数）', () => {
  it('on 默认输出固定行集合：无 all_proxy、探针记录端口', () => {
    expect(buildProxyOnScript({ port: 17890 })).toBe(
      [
        "export http_proxy='http://127.0.0.1:17890'",
        "export https_proxy='http://127.0.0.1:17890'",
        "export no_proxy='localhost,127.0.0.1,::1'",
        "export MIHOMO_PROXY_ENV='17890'",
        '',
      ].join('\n'),
    )
  })

  it('on --lan 追加私有网段，--all 追加 all_proxy', () => {
    const lan = buildProxyOnScript({ port: 1, lan: true })
    expect(lan).toContain("no_proxy='localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16'")
    expect(buildProxyOnScript({ port: 1, all: true }).split('\n')[2]).toBe("export all_proxy='http://127.0.0.1:1'")
  })

  it('off 清空全集且全集覆盖 on 的所有变量（改 on 必须同步 off）', () => {
    const unset = buildProxyOffScript().split('\n').filter(Boolean)
    expect(unset).toEqual(UNSET_VARS.map((name) => `unset ${name}`))
    for (const name of [...ON_VARS, ...OPTIONAL_VARS]) expect(UNSET_VARS).toContain(name)
  })

  it('init 输出可被 bash 语法解析且函数齐全', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proxy-init-'))
    try {
      const file = join(dir, 'init.sh')
      writeFileSync(file, buildProxyInitScript())
      execFileSync('bash', ['-n', file])
      const text = buildProxyInitScript()
      for (const piece of ['proxy() {', 'on)     shift;', 'off)    shift;', 'status) shift;', 'tui)    shift;',
        'proxy-on()', 'proxy-off()', 'proxy-tui()']) expect(text).toContain(piece)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const root = fileURLToPath(new URL('../../..', import.meta.url))
let server: Server
let api = ''
let deadApi = ''
let testHome = ''
let mihomoDir = ''
let configsPort: number | null = 17890
let configsRequests = 0

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'proxy-env-'))
  mihomoDir = join(testHome, 'mihomo')
  mkdirSync(mihomoDir, { recursive: true })
  mkdirSync(join(testHome, '.config/mihomo-tui'), { recursive: true })
  writeFileSync(join(testHome, '.config/mihomo-tui/config.json'), JSON.stringify({ mihomoDir }))
  // 先占后放的端口：内核不可达场景的可靠探针
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const deadPort = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  deadApi = `http://127.0.0.1:${deadPort}`
  server = createServer((req, res) => {
    if (req.url === '/configs') {
      configsRequests++
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(configsPort === null ? { mode: 'rule' } : { 'mixed-port': configsPort }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  api = 'http://127.0.0.1:' + (server.address() as { port: number }).port
})
beforeEach(() => {
  configsPort = 17890
  configsRequests = 0
  rmSync(join(mihomoDir, 'config.yaml'), { force: true })
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(testHome, { recursive: true, force: true })
})

interface RunResult { code: number; stdout: string; stderr: string }
function run(args: string[], endpoint = api, extraEnv: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli.tsx', '--api', endpoint, ...args], {
      cwd: root,
      env: { ...process.env, HOME: testHome, ...extraEnv },
      timeout: 15000,
    }, (err, stdout, stderr) => {
      resolve({ code: typeof err?.code === 'number' ? err.code : err ? -1 : 0, stdout, stderr })
    })
  })
}

/**
 * bash 脚本执行必须用异步 execFile：execFileSync 会阻塞本进程的事件循环，
 * 同进程的假内核将无法响应请求（fetch 挂到超时），emit-eval 回环必假失败。
 */
function bash(script: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('bash', ['-c', script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, HOME: testHome, ...extraEnv },
    }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

function writeConfigYaml(text: string | null): void {
  if (text === null) return
  writeFileSync(join(mihomoDir, 'config.yaml'), text)
}

describe('proxy on（CLI 端到端）', () => {
  it('内核可达时输出与纯函数一致的脚本，管道下 stderr 干净', async () => {
    const result = await run(['proxy', 'on'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(buildProxyOnScript({ port: 17890 }))
    expect(result.stderr).toBe('')
    expect(configsRequests).toBe(1)
  })

  it('--port 显式指定时不访问内核', async () => {
    const result = await run(['proxy', 'on', '--port', '12345'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(buildProxyOnScript({ port: 12345 }))
    expect(configsRequests).toBe(0)
  })

  it('--port 非法走参数错误退出码 2 且 stdout 为空', async () => {
    for (const value of ['0', '70000', 'abc']) {
      const result = await run(['proxy', 'on', '--port', value])
      expect(result.code).toBe(2)
      expect(result.stdout).toBe('')
    }
  })

  it('--json 输出端口与脚本本体', async () => {
    const result = await run(['proxy', 'on', '--json'])
    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.stdout) as { port: number; script: string }
    expect(parsed.port).toBe(17890)
    expect(parsed.script).toBe(buildProxyOnScript({ port: 17890 }))
  })

  it('内核可达但 config.yaml 有不同端口：运行时端口优先（spec §6.4 顺序）', async () => {
    writeConfigYaml('mixed-port: 24680\nmode: rule\n')
    const result = await run(['proxy', 'on'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(buildProxyOnScript({ port: 17890 }))
  })

  it('内核不可达但 config.yaml 有 mixed-port 时兜底成功', async () => {
    writeConfigYaml('mixed-port: 24680\nmode: rule\n')
    const result = await run(['proxy', 'on'], deadApi)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(buildProxyOnScript({ port: 24680 }))
  })

  it('内核可达但不报告 mixed-port 时落到 config.yaml 兜底', async () => {
    configsPort = null
    writeConfigYaml('mixed-port: 24680\nmode: rule\n')
    const result = await run(['proxy', 'on'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(buildProxyOnScript({ port: 24680 }))
  })

  it('内核不报告端口且 config.yaml 也没有：普通错误退出码 1、stdout 空', async () => {
    configsPort = null
    writeConfigYaml('mode: rule\n')
    const result = await run(['proxy', 'on'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
  })

  it('内核不可达且 config.yaml 无端口：stdout 空、退出码 3、stderr 有指引', async () => {
    writeConfigYaml('mode: rule\n')
    const result = await run(['proxy', 'on'], deadApi)
    expect(result.code).toBe(3)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toBe('')
  })

  it('eval 回环：bash 真实执行后环境变量生效', async () => {
    const out = await bash(
      'eval "$(node --import tsx src/cli.tsx --api ' + api + ' proxy on)"; printf "%s|%s" "$http_proxy" "$MIHOMO_PROXY_ENV"',
    )
    expect(out).toBe('http://127.0.0.1:17890|17890')
  })
})

describe('proxy off（CLI 端到端）', () => {
  it('离线可用：不访问内核也能输出 unset 全集', async () => {
    const result = await run(['proxy', 'off'], deadApi)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(buildProxyOffScript())
    expect(result.stderr).toBe('')
  })

  it('--json 输出 unset 清单', async () => {
    const result = await run(['proxy', 'off', '--json'])
    expect(JSON.parse(result.stdout)).toEqual({ unset: [...UNSET_VARS] })
  })

  it('eval 回环：off 之后探针变量被清空', async () => {
    const out = await bash(
      'eval "$(node --import tsx src/cli.tsx proxy on --port 1)"; ' +
      'eval "$(node --import tsx src/cli.tsx proxy off)"; ' +
      'printf "%s" "${MIHOMO_PROXY_ENV:-cleared}"',
    )
    expect(out).toBe('cleared')
  })
})

describe('proxy status（CLI 端到端）', () => {
  it('内核可达且 shell 未开启：文本三行，退出码 0', async () => {
    const result = await run(['proxy', 'status'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('mixed-port 17890')
    expect(result.stdout).toContain('本 shell：未开启')
    expect(result.stderr).toBe('')
  })

  it('本 shell 已开启且端口一致', async () => {
    const result = await run(['proxy', 'status'], api, {
      MIHOMO_PROXY_ENV: '17890',
      http_proxy: 'http://127.0.0.1:17890',
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('本 shell：已开启（MIHOMO_PROXY_ENV=17890）')
    expect(result.stdout).not.toContain('端口不一致')
  })

  it('端口漂移给出不一致提示', async () => {
    const result = await run(['proxy', 'status'], api, { MIHOMO_PROXY_ENV: '9999' })
    expect(result.stdout).toContain('端口不一致')
  })

  it('内核不可达也以退出码 0 如实报告', async () => {
    const result = await run(['proxy', 'status'], deadApi, { MIHOMO_PROXY_ENV: undefined })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('内核：不可达')
  })

  it('--json 结构稳定', async () => {
    const result = await run(['proxy', 'status', '--json'], api, { MIHOMO_PROXY_ENV: '17890' })
    expect(JSON.parse(result.stdout)).toEqual({
      kernel: { reachable: true, mixedPort: 17890 },
      shell: { active: true, port: '17890', httpProxy: null, consistent: true },
    })
  })
})

/** PATH 前插 mihomo-tui shim（转发到 tsx 源码），用于 shell 函数全链路测试 */
async function withShim(script: string): Promise<string> {
  const shimDir = join(testHome, 'shim')
  mkdirSync(shimDir, { recursive: true })
  const shim = join(shimDir, 'mihomo-tui')
  writeFileSync(shim, `#!/bin/sh\nexec node --import tsx ${join(root, 'src', 'cli.tsx')} "$@"\n`)
  chmodSync(shim, 0o755)
  const path = shimDir + ':' + dirname(process.execPath) + ':' + (process.env.PATH ?? '')
  return bash(script, { PATH: path })
}

describe('proxy init + shell 函数全链路', () => {
  it('init 输出 eval 后，proxy on 经函数转发（含 --api）生效、proxy off 清空', async () => {
    const out = await withShim(
      'eval "$(mihomo-tui proxy init)"; ' +
      `proxy on --api ${api}; ` +
      'printf "%s|" "$MIHOMO_PROXY_ENV"; ' +
      'proxy off; printf "%s" "${MIHOMO_PROXY_ENV:-cleared}"',
    )
    expect(out).toBe('17890|cleared')
  })

  it('函数转发 --port：显式端口直达，不触碰内核', async () => {
    const out = await withShim(
      'eval "$(mihomo-tui proxy init)"; ' +
      `proxy on --api ${deadApi} --port 5555; ` +
      'printf "%s" "$MIHOMO_PROXY_ENV"',
    )
    expect(out).toBe('5555')
    expect(configsRequests).toBe(0)
  })
})
