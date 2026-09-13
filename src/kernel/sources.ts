/**
 * 内核下载源（spec 2026-09-13 settings-kernel §3.3）。
 *
 * 实测（2026-09-13）：api.github.com 直连可达；gh-proxy.com 可代理 API 与
 * 资产下载；ghfast.top 只代理资产下载（API 403）。因此源定义按角色声明能力，
 * auto 模式按请求角色跳过无该能力的源。
 */
import type { DownloadSourceConfig } from '../config.js'

export interface DownloadSource {
  id: string
  label: string
  /** 是否可用于 release API 请求 */
  api: boolean
  /** 是否可用于 release 资产下载 */
  dl: boolean
  /** URL 前缀；'' 表示直连 */
  prefix: string
}

export const SOURCES: DownloadSource[] = [
  { id: 'direct', label: '直连 GitHub', api: true, dl: true, prefix: '' },
  {
    id: 'gh-proxy.com',
    label: 'gh-proxy.com',
    api: true,
    dl: true,
    prefix: 'https://gh-proxy.com/',
  },
  {
    id: 'ghfast.top',
    label: 'ghfast.top',
    api: false,
    dl: true,
    prefix: 'https://ghfast.top/',
  },
]

export const REPO_API = 'https://api.github.com/repos/MetaCubeX/mihomo'
export const REPO_DOWNLOAD = 'https://github.com/MetaCubeX/mihomo/releases/download'

/** JSON 响应上限：releases 列表带巨大 changelog（实测单 release ~156KB），4MB 封顶 */
export const MAX_JSON_BYTES = 4 * 1024 * 1024
/** 资产下载上限 */
export const MAX_ASSET_BYTES = 128 * 1024 * 1024

export class SourceError extends Error {
  constructor(
    message: string,
    readonly attempts: string[],
  ) {
    super(message)
    this.name = 'SourceError'
  }
}

/**
 * 按配置解析请求源列表（顺序即回退顺序）：
 *   auto   → 全部具备该角色能力的源，直连优先；
 *   direct / 具名源 → 锁定单一源，失败不静默回退（用户意图优先）；
 *   custom → 仅用户自定义前缀（同时用于 API 与下载）。
 */
export function resolveSources(
  config: DownloadSourceConfig | undefined,
  role: 'api' | 'dl',
): DownloadSource[] {
  const mode = config?.mode ?? 'auto'
  if (mode === 'auto') {
    return SOURCES.filter((source) => (role === 'api' ? source.api : source.dl))
  }
  if (mode === 'direct') {
    return SOURCES.filter((source) => source.id === 'direct')
  }
  if (mode === 'custom') {
    const prefix = config?.customPrefix
    if (!prefix) {
      throw new SourceError('自定义下载源前缀未配置', [])
    }
    return [{ id: 'custom', label: '自定义', api: true, dl: true, prefix }]
  }
  const locked = SOURCES.filter((source) => source.id === mode && (role === 'api' ? source.api : source.dl))
  if (locked.length === 0) {
    throw new SourceError(`下载源 ${mode} 不支持${role === 'api' ? 'API 请求' : '资产下载'}`, [])
  }
  return locked
}

export interface FetchJsonOptions {
  /** 注入 fetch（测试用）；缺省全局 fetch */
  fetchImpl?: typeof fetch
  /** 覆盖下载源配置（测试用） */
  sourceConfig?: DownloadSourceConfig
  /** 单源超时毫秒数，默认 8000 */
  timeoutMs?: number
}

/** GitHub API 要求显式 UA；Accept 固定到 vnd.github+json */
function githubHeaders(): Record<string, string> {
  return { 'User-Agent': 'mihomo-tui', Accept: 'application/vnd.github+json' }
}

/**
 * 经镜像回退请求 GitHub API：按 resolveSources 顺序尝试，全部失败抛
 * SourceError（attempts 记录每个源的失败原因）。响应超过 MAX_JSON_BYTES 视为该源失败。
 */
export async function fetchJsonThrough<T>(
  path: string,
  options: FetchJsonOptions = {},
): Promise<{ data: T; source: string }> {
  const { fetchImpl = fetch, sourceConfig, timeoutMs = 8000 } = options
  const sources = resolveSources(sourceConfig, 'api')
  const attempts: string[] = []
  for (const source of sources) {
    try {
      const response = await fetchImpl(`${source.prefix}${REPO_API}${path}`, {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        attempts.push(`${source.id}: HTTP ${response.status}`)
        continue
      }
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > MAX_JSON_BYTES) {
        attempts.push(`${source.id}: 响应超过 ${MAX_JSON_BYTES} 字节上限`)
        continue
      }
      return { data: JSON.parse(new TextDecoder().decode(buffer)) as T, source: source.id }
    } catch (err) {
      attempts.push(`${source.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new SourceError(`获取 GitHub 数据失败（已尝试 ${sources.length} 个源）`, attempts)
}

/** release 资产下载 URL：tag + 资产名（浏览器下载地址可从 API 响应取，这里按规则拼装） */
export function assetDownloadUrl(tag: string, assetName: string): string {
  return `${REPO_DOWNLOAD}/${tag}/${assetName}`
}
