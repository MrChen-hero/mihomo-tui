/**
 * 内核安装四段式的单测（spec settings-kernel §3.4）：mock fetch（服务真实
 * gzip 过的 stub 脚本）+ stub systemctl 语义 + tmpdir。覆盖正常流、digest/
 * 验证失败、重启/探针失败回滚、归档离线复用、备份保留策略。零生产触碰。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InstallError,
  archivedBinPath,
  installKernel,
  listArchivedTags,
  type InstallProgress,
  type InstallerDeps,
  type InstallKernelInput,
} from '../installer.js'
import type { ReleaseAsset } from '../releases.js'

const TAG = 'v1.19.30'
const NEW_VERSION_LINE = 'Mihomo Meta v1.19.30 linux amd64 with go1.26.2'
const OLD_VERSION_LINE = 'Mihomo Meta v1.19.24 linux amd64 with go1.26.2'

let root: string
let kernelsDir: string
let binPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mihomo-tui-inst-'))
  kernelsDir = join(root, 'kernels')
  binPath = join(root, 'bin', 'mihomo')
  mkdirSync(dirname(binPath), { recursive: true })
})

const scriptFor = (versionLine: string): string => `#!/bin/sh\necho "${versionLine}"\nexit 0\n`

const gzOf = (content: string): Buffer => gzipSync(Buffer.from(content))

/** 恒定返回同一 body 的 mock fetch */
function fetchServing(body: Buffer): typeof fetch {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-length': String(body.length) },
    })) as unknown as typeof fetch
}

/** 恒定抛网络错误的 mock fetch */
function fetchFailing(): typeof fetch {
  return (async () => {
    throw new TypeError('fetch failed (stub)')
  }) as unknown as typeof fetch
}

interface Fixture {
  input: InstallKernelInput
  deps: InstallerDeps
  restart: ReturnType<typeof vi.fn>
  probeVersion: ReturnType<typeof vi.fn>
  onProgress: ReturnType<typeof vi.fn>
}

function harness(options: {
  gzContent?: string
  assetDigest?: string
  fetchImpl?: typeof fetch
  probeVersion?: string
  restartFailsFirst?: boolean
  preExistingTarget?: boolean
  asset?: ReleaseAsset
} = {}): Fixture {
  const gz = gzOf(options.gzContent ?? scriptFor(NEW_VERSION_LINE))
  const digest = `sha256:${createHash('sha256').update(gz).digest('hex')}`
  const asset =
    options.asset ??
    ({
      name: `mihomo-linux-amd64-${TAG}.gz`,
      size: gz.length,
      ...(options.assetDigest === undefined ? { digest } : { digest: options.assetDigest }),
    } as ReleaseAsset)

  if (options.preExistingTarget) {
    writeFileSync(binPath, scriptFor(OLD_VERSION_LINE), 'utf8')
    chmodSync(binPath, 0o755)
  }

  let restartCalls = 0
  const restart = vi.fn(async () => {
    restartCalls += 1
    if (options.restartFailsFirst && restartCalls === 1) {
      throw new Error('Job for mihomo.service failed (stub)')
    }
  })
  const probeVersion = vi.fn(async () => options.probeVersion ?? 'v1.19.30')
  const onProgress = vi.fn<(progress: InstallProgress) => void>()
  const input: InstallKernelInput = { tag: TAG, asset }
  const deps: InstallerDeps = {
    mihomoBin: binPath,
    kernelsDir,
    sourceConfig: { mode: 'direct' },
    fetchImpl: options.fetchImpl ?? fetchServing(gz),
    sleep: async () => {},
    restart: restart as unknown as () => Promise<void>,
    isActive: async () => true,
    probeVersion: probeVersion as unknown as () => Promise<string>,
    onProgress,
  }
  return { input, deps, restart, probeVersion, onProgress }
}

describe('installKernel 正常流', () => {
  it('下载→校验→替换→重启确认全链路：目标更新、归档、备份、进度齐全', async () => {
    writeFileSync(binPath, scriptFor(OLD_VERSION_LINE), 'utf8')
    const { input, deps, restart, onProgress } = harness({ preExistingTarget: true })
    const result = await installKernel(input, deps)

    expect(result).toEqual({ tag: TAG, fromArchive: false })
    expect(readFileSync(binPath, 'utf8')).toBe(scriptFor(NEW_VERSION_LINE))
    // 落盘即可执行
    expect(statSync(binPath).mode & 0o777).toBe(0o700)
    // 归档留档，离线可切回
    expect(existsSync(archivedBinPath(kernelsDir, TAG))).toBe(true)
    // 备份存在且是旧内核
    const backups = readdirSync(dirname(binPath)).filter((entry) => entry.startsWith('mihomo.bak.'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dirname(binPath), backups[0] ?? ''), 'utf8')).toBe(scriptFor(OLD_VERSION_LINE))
    expect(restart).toHaveBeenCalledTimes(1)
    // 进度阶段按序出现
    const phases: InstallProgress['phase'][] = []
    for (const call of onProgress.mock.calls) {
      const phase = call[0]?.phase
      if (phase && phases.at(-1) !== phase) phases.push(phase)
    }
    expect(phases).toEqual(['download', 'verify', 'replace', 'restart', 'confirm'])
  })

  it('目标不存在（首次安装）：无备份直接落位', async () => {
    const { input, deps } = harness()
    await installKernel(input, deps)
    expect(readFileSync(binPath, 'utf8')).toBe(scriptFor(NEW_VERSION_LINE))
    expect(readdirSync(dirname(binPath)).filter((entry) => entry.startsWith('mihomo.bak.'))).toHaveLength(0)
  })

  it('下载内容 gzip 解压后是可执行脚本（sha256 对 .gz 原始字节计算）', async () => {
    const { input, deps } = harness()
    await installKernel(input, deps)
    // 归档里的二进制内容与 gz 解压结果一致
    expect(readFileSync(archivedBinPath(kernelsDir, TAG), 'utf8')).toBe(scriptFor(NEW_VERSION_LINE))
  })
})

describe('installKernel 失败与回滚', () => {
  it('digest 不匹配：拒绝执行候选二进制，目标与归档不动', async () => {
    writeFileSync(binPath, scriptFor(OLD_VERSION_LINE), 'utf8')
    const badDigest = `sha256:${'0'.repeat(64)}`
    const { input, deps } = harness({ preExistingTarget: true, assetDigest: badDigest })
    await expect(installKernel(input, deps)).rejects.toThrow(/sha256/)
    expect(readFileSync(binPath, 'utf8')).toBe(scriptFor(OLD_VERSION_LINE))
    expect(existsSync(archivedBinPath(kernelsDir, TAG))).toBe(false)
    // staging 已清理
    expect(readdirSync(kernelsDir).filter((entry) => entry.startsWith('staging-'))).toHaveLength(0)
  })

  it('-v 验证失败：报 verify 阶段错误，目标不动', async () => {
    writeFileSync(binPath, scriptFor(OLD_VERSION_LINE), 'utf8')
    const { input, deps } = harness({ preExistingTarget: true, gzContent: scriptFor('Mihomo Meta v0.0.1 linux amd64') })
    await expect(installKernel(input, deps)).rejects.toThrow(InstallError)
    await expect(installKernel(input, deps)).rejects.toThrow(/目标版本标记/)
    expect(readFileSync(binPath, 'utf8')).toBe(scriptFor(OLD_VERSION_LINE))
  })

  it('下载失败（全部源）：报 download 阶段错误，staging 清理', async () => {
    const { input, deps } = harness({ fetchImpl: fetchFailing() })
    await expect(installKernel(input, deps)).rejects.toThrow(/下载失败/)
    expect(existsSync(binPath)).toBe(false)
    expect(readdirSync(kernelsDir).filter((entry) => entry.startsWith('staging-'))).toHaveLength(0)
  })

  it('重启失败：从备份恢复旧内核并再次重启', async () => {
    writeFileSync(binPath, scriptFor(OLD_VERSION_LINE), 'utf8')
    const { input, deps, restart } = harness({ preExistingTarget: true, restartFailsFirst: true })
    await expect(installKernel(input, deps)).rejects.toThrow(/重启服务失败（已回滚旧内核）/)
    expect(readFileSync(binPath, 'utf8')).toBe(scriptFor(OLD_VERSION_LINE))
    expect(restart).toHaveBeenCalledTimes(2)
  })

  it('探针始终探不到目标版本：回滚旧内核', async () => {
    writeFileSync(binPath, scriptFor(OLD_VERSION_LINE), 'utf8')
    const { input, deps, restart } = harness({ preExistingTarget: true, probeVersion: 'v0.0.1' })
    await expect(installKernel(input, deps)).rejects.toThrow(/已回滚旧内核/)
    expect(readFileSync(binPath, 'utf8')).toBe(scriptFor(OLD_VERSION_LINE))
    expect(restart).toHaveBeenCalledTimes(2)
  })
})

describe('installKernel 归档复用与备份保留', () => {
  it('归档存在时跳过下载直接切换（离线）', async () => {
    mkdirSync(dirname(archivedBinPath(kernelsDir, TAG)), { recursive: true })
    writeFileSync(archivedBinPath(kernelsDir, TAG), scriptFor(NEW_VERSION_LINE), 'utf8')
    chmodSync(archivedBinPath(kernelsDir, TAG), 0o700)
    const { input, deps, restart } = harness({ fetchImpl: fetchFailing(), preExistingTarget: true })
    const result = await installKernel(input, deps)
    expect(result.fromArchive).toBe(true)
    expect(readFileSync(binPath, 'utf8')).toBe(scriptFor(NEW_VERSION_LINE))
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('备份保留最近 2 份，更旧的清理', async () => {
    writeFileSync(binPath, scriptFor(OLD_VERSION_LINE), 'utf8')
    writeFileSync(`${binPath}.bak.1111`, 'old-1', 'utf8')
    writeFileSync(`${binPath}.bak.2222`, 'old-2', 'utf8')
    const { input, deps } = harness({ preExistingTarget: true })
    await installKernel(input, deps)
    const backups = readdirSync(dirname(binPath))
      .filter((entry) => entry.startsWith('mihomo.bak.'))
      .sort()
    expect(backups).toHaveLength(2)
    // 1111 最旧被清掉；2222 与最新备份保留
    expect(backups).not.toContain('mihomo.bak.1111')
    expect(backups).toContain('mihomo.bak.2222')
  })

  it('listArchivedTags 列出归档版本（排序、忽略空目录）', async () => {
    mkdirSync(join(kernelsDir, 'v1.19.30'), { recursive: true })
    writeFileSync(archivedBinPath(kernelsDir, 'v1.19.30'), 'x', 'utf8')
    mkdirSync(join(kernelsDir, 'v1.18.0'), { recursive: true }) // 无 mihomo，忽略
    expect(listArchivedTags(kernelsDir)).toEqual(['v1.19.30'])
    expect(listArchivedTags(join(root, 'missing'))).toEqual([])
  })
})

describe('installKernel alpha 通道', () => {
  it('alpha 资产：以资产名中的 sha 为验证标记', async () => {
    const asset: ReleaseAsset = {
      name: 'mihomo-linux-amd64-alpha-deadbeef.gz',
      size: 1,
    }
    const gz = gzOf(scriptFor('Mihomo Meta v1.19.30-alpha-deadbeef linux amd64'))
    asset.size = gz.length
    const { input, deps } = harness({
      asset,
      gzContent: scriptFor('Mihomo Meta v1.19.30-alpha-deadbeef linux amd64'),
      probeVersion: 'v1.19.30-alpha-deadbeef',
    })
    const alphaInput: InstallKernelInput = { ...input, tag: 'Prerelease-Alpha', alpha: true }
    const result = await installKernel(alphaInput, deps)
    expect(result.tag).toBe('Prerelease-Alpha')
    // alpha 归档按 sha 键控（滚动 tag 每次构建 sha 不同，按 tag 键控会换上陈旧构建）
    expect(existsSync(archivedBinPath(kernelsDir, 'Prerelease-Alpha-deadbeef'))).toBe(true)
    expect(existsSync(archivedBinPath(kernelsDir, 'Prerelease-Alpha'))).toBe(false)
  })

  it('listArchivedTags 忽略崩溃残留的 staging-* 目录', async () => {
    mkdirSync(join(kernelsDir, 'staging-abc'), { recursive: true })
    writeFileSync(join(kernelsDir, 'staging-abc', 'mihomo'), 'x', 'utf8')
    expect(listArchivedTags(kernelsDir)).toEqual([])
  })

  it('alpha 缺资产信息：直接拒绝', async () => {
    const { input, deps } = harness()
    await expect(
      installKernel({ tag: 'Prerelease-Alpha', alpha: true }, deps),
    ).rejects.toThrow(/资产信息/)
  })
})
