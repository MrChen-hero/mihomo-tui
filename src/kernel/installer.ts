/**
 * 内核安装四段式（spec 2026-09-13 settings-kernel §3.4，范式照搬 mihari）：
 * staging 下载（流式 gunzip + sha256）→ 验证（-v 输出比对）→ 原子替换
 * （备份旧二进制 + 同目录 tmp+rename）→ 重启服务并轮询 /version 确认。
 *
 * 任何一步失败都保证目标二进制可用：验证阶段失败只留 staging 残留（finally
 * 清理）；替换后失败从备份恢复并再次重启。已下载过的版本归档在
 * kernelsDir/<tag>/mihomo，切回时离线直换（跳过下载）。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { Readable, Transform } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { MIHOMO_BIN_DEFAULT } from '../config/manager.js'
import type { DownloadSourceConfig } from '../config.js'
import { alphaShaFromAssetName, assetNamesFor, type ReleaseAsset } from './releases.js'
import { MAX_ASSET_BYTES, assetDownloadUrl, resolveSources } from './sources.js'

export const KERNELS_DIR_DEFAULT = join(homedir(), '.local', 'share', 'mihomo-tui', 'kernels')

const execFileAsync = promisify(execFile)
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000
const PROBE_INTERVAL_MS = 500
const PROBE_ATTEMPTS = 20
const BACKUP_KEEP = 2

export type InstallPhase = 'download' | 'verify' | 'replace' | 'restart' | 'confirm'

export interface InstallProgress {
  phase: InstallPhase
  message: string
  /** 下载阶段：已收字节 / 总字节（总未知时不带 total） */
  received?: number
  total?: number
}

export class InstallError extends Error {
  constructor(
    message: string,
    readonly phase: InstallPhase,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'InstallError'
  }
}

export interface InstallKernelInput {
  tag: string
  /** 目标资产（来自 release 列表）；稳定版缺省按命名规则构造（无 digest 校验） */
  asset?: ReleaseAsset
  /** alpha 版：必须携带资产（资产名含验证用 sha） */
  alpha?: boolean
}

export interface InstallerDeps {
  /** 替换目标，默认 ~/bin/mihomo（systemd 单元 ExecStart 指向） */
  mihomoBin?: string
  /** 版本归档目录，默认 ~/.local/share/mihomo-tui/kernels */
  kernelsDir?: string
  sourceConfig?: DownloadSourceConfig
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  onProgress?: (progress: InstallProgress) => void
  restart?: () => Promise<void>
  /** 重启后健康探针（systemctl is-active） */
  isActive?: () => Promise<boolean>
  /** 内核版本探测（GET /version 的 version 字段） */
  probeVersion?: () => Promise<string | undefined>
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 归档键：稳定版用 tag；alpha 滚动 tag 每次构建的 sha 都不同，按 sha 键控避免换上陈旧 alpha */
export function archiveKeyFor(tag: string, alpha: boolean, asset?: ReleaseAsset): string {
  if (!alpha) return tag
  const sha = asset ? alphaShaFromAssetName(asset.name) : undefined
  return sha ? `Prerelease-Alpha-${sha}` : `${tag}-${Date.now()}`
}

/** 归档路径：kernelsDir/<key>/mihomo */
export function archivedBinPath(kernelsDir: string, key: string): string {
  return join(kernelsDir, key, 'mihomo')
}

/** 本机已归档的版本键列表（目录名即键，仅保留含 mihomo 的目录；staging-* 是崩溃残留不是归档） */
export function listArchivedTags(kernelsDir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(kernelsDir)
  } catch {
    return []
  }
  return entries
    .filter((entry) => !entry.startsWith('staging-') && existsSync(join(kernelsDir, entry, 'mihomo')))
    .sort()
}

/** 同盘原子替换：先拷到目标同目录临时名再 rename；跨盘（EXDEV）退化为直接拷贝 */
function replaceFile(src: string, dst: string): void {
  try {
    const tmp = `${dst}.next`
    copyFileSync(src, tmp)
    renameSync(tmp, dst)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    copyFileSync(src, dst)
  }
}

/** 保留最近 keep 份 <bin>.bak.* 备份（含刚创建的那份），其余清理 */
function pruneBackups(binPath: string, keep: number): void {
  const prefix = `${basename(binPath)}.bak.`
  let entries: string[]
  try {
    entries = readdirSync(dirname(binPath))
  } catch {
    return
  }
  const backups = entries
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(dirname(binPath), entry))
    .sort()
    .reverse()
  for (const stale of backups.slice(keep)) {
    rmSync(stale, { force: true })
  }
}

/** 流式下载 .gz：边下边算 sha256，gunzip 落盘到 binFile；字节进度按 ≥512KB 节流上报 */
async function downloadAndGunzip(
  url: string,
  binFile: string,
  total: number | undefined,
  deps: InstallerDeps,
): Promise<{ sha256: string; received: number }> {
  const { fetchImpl = fetch } = deps
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'mihomo-tui' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })
  if (!response.ok || !response.body) {
    throw new InstallError(`下载失败：HTTP ${response.status}`, 'download')
  }
  const declared = Number(response.headers.get('content-length'))
  const totalBytes = total ?? (Number.isFinite(declared) && declared > 0 ? declared : undefined)
  const hash = createHash('sha256')
  let received = 0
  let lastEmit = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      received += chunk.length
      hash.update(chunk)
      if (received - lastEmit >= 512 * 1024) {
        lastEmit = received
        deps.onProgress?.({
          phase: 'download',
          message: '下载内核',
          received,
          ...(totalBytes !== undefined ? { total: totalBytes } : {}),
        })
      }
      callback(null, chunk)
    },
  })
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeWebReadableStream),
    counter,
    createGunzip(),
    createWriteStream(binFile, { mode: 0o700 }),
  )
  return { sha256: hash.digest('hex'), received }
}

/** 候选二进制验证：chmod 0700 → `-v` 输出必须含验证标记（稳定版 tag / alpha sha） */
async function verifyBinary(binFile: string, marker: string): Promise<void> {
  chmodSync(binFile, 0o700)
  let output: string
  try {
    const { stdout, stderr } = await execFileAsync(binFile, ['-v'], { timeout: 15_000 })
    output = `${stdout}${stderr}`
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    throw new InstallError('内核二进制无法执行', 'verify', `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || msg(err))
  }
  if (!output.includes(marker)) {
    throw new InstallError(`-v 输出不含目标版本标记 ${marker}`, 'verify', output.trim())
  }
}

/**
 * 从备份恢复目标二进制并尽力恢复服务；返回回滚过程中的问题清单
 * （空数组 = 干净回滚）。恢复失败也仍尝试重启：与其留下一个可能损坏的
 * 目标二进制 + 停摆的服务，不如让服务拉起盘上现存的二进制。
 */
async function restoreBackup(
  binPath: string,
  backupPath: string | undefined,
  restart: (() => Promise<void>) | undefined,
): Promise<string[]> {
  const problems: string[] = []
  if (backupPath && existsSync(backupPath)) {
    try {
      replaceFile(backupPath, binPath)
    } catch (err) {
      problems.push(`恢复备份失败：${msg(err)}`)
    }
  }
  if (restart) {
    try {
      await restart()
    } catch (err) {
      problems.push(`恢复性重启失败：${msg(err)}`)
    }
  }
  return problems
}

/** 把回滚问题并进错误文案：干净回滚注明「已回滚」，失败则如实陈述（绝不静默撒谎） */
function rollbackSuffix(problems: string[]): string {
  return problems.length > 0 ? `；回滚失败：${problems.join('；')}` : '（已回滚旧内核）'
}

/** 安装/切换内核：四段式 + 失败回滚。成功返回 { tag, fromArchive }。 */
export async function installKernel(
  input: InstallKernelInput,
  deps: InstallerDeps = {},
): Promise<{ tag: string; fromArchive: boolean }> {
  const binPath = deps.mihomoBin ?? MIHOMO_BIN_DEFAULT
  const kernelsDir = deps.kernelsDir ?? KERNELS_DIR_DEFAULT
  const sleep = deps.sleep ?? defaultSleep
  const emit = (progress: InstallProgress): void => deps.onProgress?.(progress)
  const { tag } = input

  if (input.alpha && !input.asset) {
    throw new InstallError('Alpha 版需要资产信息才能确定验证标记', 'download')
  }
  // -v 输出验证标记：稳定版为 tag（如 v1.19.30）；alpha 为资产名中的短 sha
  const marker = input.alpha
    ? (input.asset ? alphaShaFromAssetName(input.asset.name) : undefined) ?? tag
    : tag

  mkdirSync(kernelsDir, { recursive: true })
  const archiveKey = archiveKeyFor(tag, Boolean(input.alpha), input.asset)
  const archivedBin = archivedBinPath(kernelsDir, archiveKey)
  const fromArchive = existsSync(archivedBin)

  if (!fromArchive) {
    const staging = mkdtempSync(join(kernelsDir, 'staging-'))
    try {
      const names = input.asset ? [input.asset.name] : assetNamesFor(tag)
      const binFile = join(staging, 'mihomo')
      emit({
        phase: 'download',
        message: '下载内核',
        received: 0,
        ...(input.asset?.size ? { total: input.asset.size } : {}),
      })

      // 源 × 资产名组合逐个尝试：镜像不可达或 404（如无 compatible 变体）都落到下一组合
      let sha256: string | undefined
      let lastError: unknown
      outer: for (const source of resolveSources(deps.sourceConfig, 'dl')) {
        for (const name of names) {
          const url = `${source.prefix}${assetDownloadUrl(tag, name)}`
          try {
            const result = await downloadAndGunzip(url, binFile, input.asset?.size, deps)
            if (result.received > MAX_ASSET_BYTES) {
              throw new InstallError(`下载体积超过 ${MAX_ASSET_BYTES} 字节上限`, 'download')
            }
            sha256 = result.sha256
            break outer
          } catch (err) {
            lastError = err
            rmSync(binFile, { force: true })
          }
        }
      }
      if (sha256 === undefined) {
        throw lastError instanceof InstallError
          ? lastError
          : new InstallError(`下载失败：${msg(lastError)}`, 'download', msg(lastError))
      }

      // digest 校验放在执行候选二进制之前（不可信内容不执行）
      const expectedDigest = input.asset?.digest
      if (expectedDigest && expectedDigest.replace(/^sha256:/, '') !== sha256) {
        throw new InstallError('sha256 校验失败：下载内容与 release 摘要不符', 'verify')
      }

      emit({ phase: 'verify', message: '校验二进制' })
      await verifyBinary(binFile, marker)

      emit({ phase: 'replace', message: '替换二进制' })
      mkdirSync(dirname(archivedBin), { recursive: true })
      renameSync(binFile, archivedBin)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  // 备份 + 原子替换（tmpNext 与目标同目录，rename 原子生效）
  let backupPath: string | undefined
  if (existsSync(binPath)) {
    backupPath = `${binPath}.bak.${Date.now()}`
    copyFileSync(binPath, backupPath)
  }
  emit({ phase: 'replace', message: '替换二进制' })
  try {
    replaceFile(archivedBin, binPath)
    chmodSync(binPath, 0o700)
  } catch (err) {
    const problems = await restoreBackup(binPath, backupPath, deps.restart)
    throw new InstallError(
      `替换二进制失败${rollbackSuffix(problems)}：${msg(err)}`,
      'replace',
      msg(err),
    )
  }

  // 重启 + 轮询 /version 直到出现目标标记；失败恢复备份
  if (deps.restart) {
    emit({ phase: 'restart', message: '重启服务' })
    try {
      await deps.restart()
    } catch (err) {
      const problems = await restoreBackup(binPath, backupPath, deps.restart)
      throw new InstallError(
        `重启服务失败${rollbackSuffix(problems)}：${msg(err)}`,
        'restart',
        msg(err),
      )
    }
  }

  emit({ phase: 'confirm', message: '确认内核状态' })
  const hasProbe = Boolean(deps.probeVersion ?? deps.isActive)
  if (hasProbe) {
    let probeDetail: string | undefined
    let confirmed = false
    for (let attempt = 0; attempt < PROBE_ATTEMPTS && !confirmed; attempt += 1) {
      await sleep(PROBE_INTERVAL_MS)
      if (deps.isActive) {
        try {
          if (!(await deps.isActive())) {
            probeDetail = '服务未处于 active 状态'
            continue
          }
        } catch (err) {
          probeDetail = msg(err)
          continue
        }
      }
      if (deps.probeVersion) {
        try {
          const version = await deps.probeVersion()
          if (version && version.includes(marker)) {
            confirmed = true
          } else {
            probeDetail = version ? `运行版本 ${version} 与目标 ${marker} 不符` : '版本探针无响应'
          }
        } catch (err) {
          probeDetail = msg(err)
        }
      } else {
        confirmed = true
      }
    }
    if (!confirmed) {
      const problems = await restoreBackup(binPath, backupPath, deps.restart)
      throw new InstallError(
        `切换后未确认到内核 ${marker}${rollbackSuffix(problems)}`,
        'confirm',
        probeDetail,
      )
    }
  }

  pruneBackups(binPath, BACKUP_KEEP)
  return { tag, fromArchive }
}
