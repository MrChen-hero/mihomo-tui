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
import { runKernelInstall, runKernelLs, type KernelCommandDeps } from '../kernel.js'
import { DEFAULT_CONFIG, loadConfig, type AppConfig } from '../../config.js'
import { assetNamesFor } from '../../kernel/releases.js'

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
