/**
 * mihomo release 数据（spec 2026-09-13 settings-kernel §3.4）：
 * 稳定版列表 + Alpha 滚动 tag（Prerelease-Alpha）；资产按
 * mihomo-<goos>-<goarch>-<tag>.gz 规则选择（amd64 命中 404 时回退 -compatible）。
 */
import { fetchJsonThrough, type FetchJsonOptions } from './sources.js'

export interface ReleaseAsset {
  name: string
  size: number
  /** GitHub 提供的资产摘要，形如 sha256:<hex>；镜像下载时可能拿不到 */
  digest?: string
}

export interface ReleaseInfo {
  tag: string
  /** 发布时间（ISO 字符串） */
  publishedAt?: string
  assets: ReleaseAsset[]
}

interface RawRelease {
  tag_name?: unknown
  published_at?: unknown
  prerelease?: unknown
  draft?: unknown
  assets?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toRelease(raw: unknown): ReleaseInfo | undefined {
  if (!isRecord(raw) || typeof raw.tag_name !== 'string') return undefined
  const assets: ReleaseAsset[] = Array.isArray(raw.assets)
    ? raw.assets
        .map((item) => {
          if (!isRecord(item) || typeof item.name !== 'string') return undefined
          const digest = typeof item.digest === 'string' ? item.digest : undefined
          return {
            name: item.name,
            size: typeof item.size === 'number' ? item.size : 0,
            ...(digest ? { digest } : {}),
          }
        })
        .filter((item): item is ReleaseAsset => item !== undefined)
    : []
  return {
    tag: raw.tag_name,
    ...(typeof raw.published_at === 'string' ? { publishedAt: raw.published_at } : {}),
    assets,
  }
}

/** 稳定版列表（过滤 prerelease/draft，按 API 返回顺序即新到旧；per_page=12 供过滤后取前 10） */
export async function listStableReleases(options: FetchJsonOptions = {}): Promise<ReleaseInfo[]> {
  const { data } = await fetchJsonThrough<unknown>('/releases?per_page=12', options)
  if (!Array.isArray(data)) return []
  return data
    .filter(
      (raw) =>
        isRecord(raw) && raw.prerelease !== true && raw.draft !== true && typeof raw.tag_name === 'string',
    )
    .map(toRelease)
    .filter((release): release is ReleaseInfo => release !== undefined)
}

/** Alpha 滚动 tag 的最新 release（不存在或请求失败由调用方处理） */
export async function fetchAlphaRelease(options: FetchJsonOptions = {}): Promise<ReleaseInfo> {
  const { data } = await fetchJsonThrough<unknown>('/releases/tags/Prerelease-Alpha', options)
  const release = toRelease(data)
  if (!release) {
    throw new Error('Prerelease-Alpha 响应缺少 tag_name')
  }
  return release
}

function goArch(arch: string): string {
  switch (arch) {
    case 'x64':
      return 'amd64'
    case 'arm':
      return 'armv7'
    default:
      return arch // arm64 / armv6 / armv7 / riscv64 / loong64 等直接沿用
  }
}

/** 资产命名规则：mihomo-<goos>-<goarch>-<tag>.gz（Windows .zip 不支持，本项目 Linux/macOS only） */
export function assetNamesFor(tag: string, platform: string = process.platform, arch: string = process.arch): string[] {
  const goarch = goArch(arch)
  const names = [`mihomo-${platform}-${goarch}-${tag}.gz`]
  // amd64 直连性能版对 CPU 指令集有要求，老 CPU 用 compatible 通用版
  if (goarch === 'amd64') {
    names.push(`mihomo-${platform}-amd64-compatible-${tag}.gz`)
  }
  return names
}

/**
 * 从 release 资产里选出目标平台的 .gz：按 assetNamesFor 顺序精确匹配。
 * alpha 版资产名形如 mihomo-linux-amd64-alpha-<hexsha>.gz——tag 不是
 * Prerelease-Alpha 时才按 tag 匹配；alpha 走 alphaAssetName。
 */
export function selectAsset(release: ReleaseInfo, tag: string, platform = process.platform, arch = process.arch): ReleaseAsset | undefined {
  for (const name of assetNamesFor(tag, platform, arch)) {
    const found = release.assets.find((asset) => asset.name === name)
    if (found) return found
  }
  return undefined
}

/** alpha 资产名：mihomo-<goos>-<goarch>-alpha-<sha>.gz（取 release 资产里第一个匹配 goos/goarch 的） */
export function selectAlphaAsset(release: ReleaseInfo, platform = process.platform, arch = process.arch): ReleaseAsset | undefined {
  const goarch = goArch(arch)
  return release.assets.find(
    (asset) => asset.name.startsWith(`mihomo-${platform}-${goarch}-alpha-`) && asset.name.endsWith('.gz'),
  )
}

/** 从 alpha 资产名解析短 sha（-v 输出验证用） */
export function alphaShaFromAssetName(name: string): string | undefined {
  const match = /-alpha-([0-9a-f]+)\.gz$/.exec(name)
  return match?.[1]
}

/** 语义化版本比较：v1.19.30 > v1.19.9；无法解析时按字符串不等判定 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (tag: string): number[] | undefined => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag)
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
  }
  const a = parse(candidate)
  const b = parse(current)
  if (!a || !b) return candidate !== current
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}
