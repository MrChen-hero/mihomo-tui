/**
 * kernel 命令层单测：mock fetch（release API + 资产下载按 URL 路由）+ tmpdir +
 * hasService:false 屏蔽服务接管。覆盖 install 全链（下载/校验/引导配置/api 同步/
 * 已有配置零覆盖/--mirror 单源/离线归档复用）与 ls 的本地/远端降级。零生产触碰。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runKernelInstall, runKernelLs, runKernelServiceInstall, makeProgressWriter, type KernelCommandDeps } from '../kernel.js'
import { DEFAULT_CONFIG, loadConfig, type AppConfig } from '../../config.js'
import { assetNamesFor } from '../../kernel/releases.js'
import type { InstallProgress } from '../../kernel/installer.js'

const TAG = 'v1.19.30'
const OLD_TAG = 'v1.18.0'
const VERSION_LINE = `Mihomo Meta ${TAG} linux amd64 with go1.26.2`

let root: string
let binPath: string
let mihomoDir: string
let configPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mihomo-tui-kernel-cmd-'))
  binPath = join(root, 'bin', 'mihomo')
  mihomoDir = join(root, 'mihomo')
  configPath = join(root, 'home', '.config', 'mihomo-tui', 'config.json')
  mkdirSync(dirname(binPath), { recursive: true })
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, '{}\n', 'utf8')
})

const scriptFor = (line: string): string => `#!/bin/sh\necho "${line}"\nexit 0\n`
const gzOf = (content: string): Buffer => gzipSync(Buffer.from(content))

function config(): AppConfig {
  return { ...DEFAULT_CONFIG, mihomoBin: binPath, mihomoDir, downloadSource: { mode: 'direct' } }
}

/** release API JSON：资产名按当前平台生成，digest 对应真实 gz 内容 */
function releaseJson(tag = TAG): unknown {
  const gz = gzOf(scriptFor(`Mihomo Meta ${tag} linux amd64 with go1.26.2`))
  return [
    {
      tag_name: tag,
      published_at: '2026-09-01T00:00:00Z',
      prerelease: false,
      draft: false,
      assets: [
        {
          name: assetNamesFor(tag)[0],
          size: gz.length,
          digest: `sha256:${createHash('sha256').update(gz).digest('hex')}`,
        },
      ],
    },
  ]
}

/** 按 URL 路由的 mock fetch：release 查询 vs 资产下载 */
function fetchFor(options: { gz?: Buffer; releaseBody?: unknown; urls?: string[] } = {}): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url)
    options.urls?.push(u)
    if (u.endsWith('/version')) {
      // 控制口探活（收尾防呆用）：模拟已有内核实例在响应
      return new Response(JSON.stringify({ meta: true, version: 'v1.19.24' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (u.includes('/repos/MetaCubeX/mihomo/releases')) {
      return new Response(JSON.stringify(options.releaseBody ?? releaseJson()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (u.includes('/releases/download/')) {
      const gz = options.gz
      if (!gz) throw new TypeError('fetch failed (stub)')
      return new Response(gz, { status: 200, headers: { 'content-length': String(gz.length) } })
    }
    throw new TypeError(`unexpected url ${u}`)
  }) as unknown as typeof fetch
}

const fetchFailing = (): typeof fetch =>
  (async () => {
    throw new TypeError('fetch failed (stub)')
  }) as unknown as typeof fetch

function baseDeps(over: Partial<KernelCommandDeps> = {}): KernelCommandDeps {
  return { configPath, kernelsDir: join(root, 'kernels'), hasService: false, ...over }
}

function captureStdout(): { lines: () => string; out: string[]; restore: () => void } {
  const out: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    out.push(String(chunk))
    return true
  }) as never)
  return { out, lines: () => out.join(''), restore: () => spy.mockRestore() }
}

describe('runKernelInstall', () => {
  it('缺省安装最新稳定版：二进制就位、引导配置生成、api 保持默认', async () => {
    const cap = captureStdout()
    try {
      await runKernelInstall(config(), undefined, { json: true }, baseDeps({ fetchImpl: fetchFor({ gz: gzOf(scriptFor(VERSION_LINE)) }) }))
    } finally {
      cap.restore()
    }
    expect(existsSync(binPath)).toBe(true)
    const probe = readFileSync(binPath, 'utf8')
    expect(probe).toContain(TAG)
    const summary = JSON.parse(cap.lines()) as { tag: string; bootstrapConfig: { created: boolean; mixedPort: number; controllerPort: number }; api: { state: string } }
    expect(summary.tag).toBe(TAG)
    expect(summary.bootstrapConfig).toMatchObject({ created: true, mixedPort: 17890, controllerPort: 19090 })
    expect(summary.api.state).toBe('already')
    const yaml = readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')
    expect(yaml).toBe(
      'mixed-port: 17890\nexternal-controller: 127.0.0.1:19090\nmode: rule\nlog-level: info\n',
    )
  }, 15000)

  it('--port 非默认端口：引导配置与 config.json api 同步更新', async () => {
    await runKernelInstall(config(), undefined, { port: '19091', json: true }, baseDeps({ fetchImpl: fetchFor({ gz: gzOf(scriptFor(VERSION_LINE)) }) }))
    const yaml = readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')
    expect(yaml).toContain('external-controller: 127.0.0.1:19091')
    expect(loadConfig(configPath).api).toBe('http://127.0.0.1:19091')
  }, 15000)

  it('已有 config.yaml 零覆盖：自定义内容原样保留', async () => {
    mkdirSync(mihomoDir, { recursive: true })
    writeFileSync(join(mihomoDir, 'config.yaml'), 'mixed-port: 7899\n', 'utf8')
    const cap = captureStdout()
    try {
      await runKernelInstall(config(), undefined, { json: true }, baseDeps({ fetchImpl: fetchFor({ gz: gzOf(scriptFor(VERSION_LINE)) }) }))
    } finally {
      cap.restore()
    }
    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe('mixed-port: 7899\n')
    const summary = JSON.parse(cap.lines()) as { bootstrapConfig: { created: boolean } }
    expect(summary.bootstrapConfig.created).toBe(false)
  }, 15000)

  it('已有自定义 api 不覆盖：state=kept-custom', async () => {
    const custom = 'http://10.0.0.5:9090'
    writeFileSync(configPath, JSON.stringify({ api: custom }), 'utf8')
    const cap = captureStdout()
    try {
      await runKernelInstall(config(), undefined, { port: '19091', json: true }, baseDeps({ fetchImpl: fetchFor({ gz: gzOf(scriptFor(VERSION_LINE)) }) }))
    } finally {
      cap.restore()
    }
    expect(loadConfig(configPath).api).toBe(custom)
    const summary = JSON.parse(cap.lines()) as { api: { state: string; desired: string } }
    expect(summary.api).toMatchObject({ state: 'kept-custom', desired: 'http://127.0.0.1:19091' })
  }, 15000)

  it('--mirror 指定后所有请求（API 与下载）都走该前缀，且不再回退其他源', async () => {
    const urls: string[] = []
    await runKernelInstall(config(), undefined, { mirror: 'https://m.test/', json: true }, baseDeps({ fetchImpl: fetchFor({ gz: gzOf(scriptFor(VERSION_LINE)), urls }) }))
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((u) => u.startsWith('https://m.test/'))).toBe(true)
  }, 15000)

  it('第二次安装同版本走离线归档：fromArchive=true 且不再下载', async () => {
    const deps = baseDeps({ fetchImpl: fetchFor({ gz: gzOf(scriptFor(VERSION_LINE)) }) })
    await runKernelInstall(config(), TAG, { json: true }, deps)
    const urls: string[] = []
    const cap = captureStdout()
    try {
      await runKernelInstall(config(), TAG, { json: true }, baseDeps({ fetchImpl: fetchFor({ urls, gz: Buffer.alloc(0) }) }))
    } finally {
      cap.restore()
    }
    const summary = JSON.parse(cap.lines()) as { fromArchive: boolean }
    expect(summary.fromArchive).toBe(true)
    expect(urls.some((u) => u.includes('/releases/download/'))).toBe(false)
  }, 20000)

  it('--port 非法直接 usage 退出（退出码 2），不触网', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await expect(runKernelInstall(config(), undefined, { port: '80' }, baseDeps({ fetchImpl: fetchFailing() }))).rejects.toThrow('exit:2')
      const out = errSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(out).toContain('1024-65535')
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })

  it('显式版本 + 归档已存在：离线直装，全程不触网', async () => {
    const deps = baseDeps({ fetchImpl: fetchFor({ gz: gzOf(scriptFor(VERSION_LINE)) }) })
    await runKernelInstall(config(), TAG, { json: true }, deps)
    const cap = captureStdout()
    try {
      await runKernelInstall(config(), TAG, { json: true }, baseDeps({ fetchImpl: fetchFailing() }))
    } finally {
      cap.restore()
    }
    const summary = JSON.parse(cap.lines()) as { fromArchive: boolean }
    expect(summary.fromArchive).toBe(true)
  }, 20000)

  it('全新机器 ~/bin 不存在：自动创建目标目录后安装成功', async () => {
    rmSync(join(root, 'bin'), { recursive: true, force: true })
    await runKernelInstall(config(), undefined, { json: true }, baseDeps({ fetchImpl: fetchFor({ gz: gzOf(scriptFor(VERSION_LINE)) }) }))
    expect(existsSync(binPath)).toBe(true)
  }, 15000)
})

describe('runKernelLs', () => {
  it('本地生效与归档 + 远端最新稳定版，--json 结构齐全', async () => {
    writeFileSync(binPath, scriptFor(VERSION_LINE), 'utf8')
    chmodSync(binPath, 0o755)
    const archiveDir = join(root, 'kernels', OLD_TAG)
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(join(archiveDir, 'mihomo'), scriptFor(`Mihomo Meta ${OLD_TAG}`), 'utf8')
    chmodSync(join(archiveDir, 'mihomo'), 0o755)

    const cap = captureStdout()
    try {
      await runKernelLs(config(), { json: true }, baseDeps({ fetchImpl: fetchFor({}) }))
    } finally {
      cap.restore()
    }
    const summary = JSON.parse(cap.lines()) as {
      active?: string
      archived: string[]
      remote: { tag: string }[]
    }
    expect(summary.active).toBe(VERSION_LINE)
    expect(summary.archived).toEqual([OLD_TAG])
    expect(summary.remote[0]?.tag).toBe(TAG)
  }, 15000)

  it('远端查询失败降级：不拖垮命令，remoteError 说明原因', async () => {
    const cap = captureStdout()
    try {
      await runKernelLs(config(), { json: true }, baseDeps({ fetchImpl: fetchFailing() }))
    } finally {
      cap.restore()
    }
    const summary = JSON.parse(cap.lines()) as { remoteError?: string; remote: unknown[] }
    expect(summary.remote).toEqual([])
    expect(summary.remoteError).toBeTruthy()
  }, 15000)
})

describe('makeProgressWriter 安装进度', () => {
  const MB = 1048576
  const download = (received: number, total = 80 * MB): InstallProgress =>
    ({ phase: 'download', message: '下载内核', received, total })
  const verify: InstallProgress = { phase: 'verify', message: '校验二进制' }

  it('TTY：\\r 原位刷新进度条，阶段切换补换行且过程行不带 \\n', () => {
    const out: string[] = []
    let t = 0
    const write = makeProgressWriter({ tty: true, columns: 80, write: (s) => out.push(s), now: () => (t += 200) })
    write(download(0))
    write(download(40 * MB))
    write(verify)
    const all = out.join('')
    expect(all).toContain('\r')
    expect(all).toContain('[####')
    expect(all).toContain('50%')
    expect(out[out.length - 1]).toBe('校验二进制\n')
    expect(out.filter((s) => s.startsWith('\r')).every((s) => !s.includes('\n'))).toBe(true)
  })

  it('TTY：100ms 节流——时间未推进时快速连发只画一次', () => {
    const out: string[] = []
    let t = 0
    const write = makeProgressWriter({ tty: true, columns: 80, write: (s) => out.push(s), now: () => t })
    write(download(0))
    write(download(8 * MB))
    write(download(16 * MB))
    expect(out.filter((s) => s.includes('\r')).length).toBe(1)
  })

  it('非 TTY：按 10% 步进分行，每行以换行结尾', () => {
    const out: string[] = []
    const write = makeProgressWriter({ tty: false, write: (s) => out.push(s) })
    for (let pct = 0; pct <= 100; pct += 5) write(download(pct * 0.8 * MB))
    const joined = out.join('')
    expect(joined).toContain('0%\n')
    expect(joined).toContain('50%\n')
    expect(joined).toContain('100%\n')
    expect(out.every((s) => s.endsWith('\n'))).toBe(true)
  })
})

/** 恒定响应的 fetch（模拟控制口有实例在运行） */
const responding = (): typeof fetch =>
  (async () => new Response('{"version":"v1.19.24"}', { status: 200 })) as unknown as typeof fetch
/** 控制口空闲（/version 探活失败）、但 release API 与资产下载正常放行 */
const offline = (): typeof fetch => (async (url: RequestInfo | URL) => {
  const u = String(url)
  if (u.endsWith('/version')) throw new TypeError('fetch failed (控制口空闲)')
  return fetchFor({ gz: gzOf(scriptFor(VERSION_LINE)) })(url)
}) as unknown as typeof fetch

describe('kernel service install 冲突防呆', () => {
  it('控制口被非服务实例占用：拒绝安装并给出处理指引', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const unitPath = join(root, 'home', '.config', 'systemd', 'user', 'mihomo.service')
    try {
      await expect(
        runKernelServiceInstall(config(), {}, {
          configPath, home: root, flavor: 'systemd', user: 'ubuntu',
          fetchImpl: responding(), isServiceActive: false, hasSystemdUnit: true,
        }),
      ).rejects.toThrow('exit:1')
      const out = errSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(out).toContain('已被其他 mihomo 实例占用')
      expect(out).toContain('pkill')
      expect(existsSync(unitPath)).toBe(false) // 未写服务定义
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })

  it('控制口无实例：正常安装并写入服务定义', async () => {
    const cap = captureStdout()
    try {
      await runKernelServiceInstall(config(), {}, {
        configPath, home: root, flavor: 'systemd', user: 'ubuntu',
        exec: (() => ({ status: 0, stdout: 'active' })) as never,
        fetchImpl: offline(), isServiceActive: false,
      })
    } finally {
      cap.restore()
    }
    expect(cap.lines()).toContain('服务已启动并设为开机自启')
    expect(existsSync(join(root, '.config', 'systemd', 'user', 'mihomo.service'))).toBe(true)
  })

  it('服务已启用但控制口未响应：给出排查提示', async () => {
    let calls = 0
    const flaky = (): typeof fetch => (async () => {
      calls += 1
      if (calls === 1) return new Response('{"version":"v1.19.24"}', { status: 200 }) // 前置探活：旧实例在
      throw new TypeError('fetch failed') // 后置探活：服务起后仍无响应
    }) as unknown as typeof fetch
    const cap = captureStdout()
    try {
      await runKernelServiceInstall(config(), {}, {
        configPath, home: root, flavor: 'systemd', user: 'ubuntu',
        exec: (() => ({ status: 0, stdout: 'active' })) as never,
        fetchImpl: flaky(), isServiceActive: true,
      })
    } finally {
      cap.restore()
    }
    expect(cap.lines()).toContain('控制口 19090 未响应')
  })
})

describe('kernel install 收尾防呆', () => {
  it('控制口已有旧实例在运行：提示重启它而不是再起一个', async () => {
    const cap = captureStdout()
    try {
      await runKernelInstall(config(), undefined, {}, baseDeps({ fetchImpl: fetchFor({ gz: gzOf(scriptFor(VERSION_LINE)) }), hasService: false }))
    } finally {
      cap.restore()
    }
    const out = cap.lines()
    expect(out).toContain('重启它以加载新装的内核')
    expect(out).not.toContain('下一步：')
  })

  it('控制口空闲（全新机器）：给出前台启动与自启两条路径', async () => {
    const cap = captureStdout()
    try {
      await runKernelInstall(config(), undefined, {}, baseDeps({ fetchImpl: offline(), hasService: false }))
    } finally {
      cap.restore()
    }
    const out = cap.lines()
    expect(out).toContain('下一步：')
    expect(out).toContain('或配置开机自启：mihomo-tui kernel service install')
  })
})
