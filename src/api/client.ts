/**
 * REST 客户端。三条硬约束在这里落地：
 *  1. 只与 external-controller 通信，没有任何写 config.yaml 的能力；
 *  2. 路径段全部 encodeURIComponent（组名含中文与 emoji，如「悦 · 🇭🇰 香港聚合」）；
 *  3. 区分「内核不可达」「HTTP 错误」「业务错误」三类失败。
 */
import type { AppConfig } from '../config.js'
import type {
  ApiErrorBody,
  ConfigsResponse,
  ConnectionsResponse,
  DelayResult,
  LogLevel,
  ProviderItem,
  ProvidersResponse,
  ProxiesResponse,
  ProxyItem,
  RuleItem,
  RuleProviderItem,
  RuleProvidersResponse,
  RulesResponse,
  VersionInfo,
} from './types.js'

/** 内核连不上（服务未启动 / 端口不对），对应退出码 3 */
export class KernelUnreachableError extends Error {
  constructor(
    readonly api: string,
    override readonly cause?: unknown,
  ) {
    super(`无法连接 mihomo 控制口 ${api}`)
    this.name = 'KernelUnreachableError'
  }
}

/** HTTP 状态码错误（401 密钥错误、404 组名不存在等） */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} ${path}${body ? `: ${body}` : ''}`)
    this.name = 'HttpStatusError'
  }
}

/**
 * 内核返回 {"message": "..."} 的业务错误。
 * 典型来源是延迟测试失败 —— 属于「节点不可用」这一正常结果，调用方不得当成崩溃。
 */
export class ApiBusinessError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiBusinessError'
  }
}

const DEFAULT_TIMEOUT = 8000

export interface RequestOptions {
  method?: string
  /** 查询参数，值为 undefined 的键会被跳过 */
  query?: Record<string, string | number | undefined>
  body?: unknown
  timeout?: number
}

export class MihomoClient {
  readonly api: string
  private readonly secret: string
  private readonly testUrl: string
  private readonly testTimeout: number

  constructor(config: AppConfig) {
    this.api = config.api.replace(/\/+$/, '')
    this.secret = config.secret
    this.testUrl = config.testUrl
    this.testTimeout = config.testTimeout
  }

  /** 拼 URL：path 由调用方给出且各段已编码，query 交给 URLSearchParams */
  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(`${this.api}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', query, body, timeout = DEFAULT_TIMEOUT } = options
    const headers: Record<string, string> = {}
    if (this.secret) headers.Authorization = `Bearer ${this.secret}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    let response: Response
    try {
      response = await fetch(this.buildUrl(path, query), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      })
    } catch (err) {
      // fetch 只在网络层失败或超时时抛异常，HTTP 错误状态不抛
      throw new KernelUnreachableError(this.api, err)
    }

    const text = await response.text()
    const parsed = text ? safeJsonParse(text) : undefined

    if (!response.ok) {
      const message = isErrorBody(parsed) ? parsed.message : ''
      // 401 与 404 是调用方用错了（密钥/名称），归入 HTTP 错误。
      // 其余带 message 的状态码是内核对本次操作的明确表态，属业务错误：
      //   503 {"message":"An error occurred in the delay test"} —— 节点不可用（实测）
      //   400 {"message":"Selector update error: proxy not exist"} —— 节点名不在组内（实测）
      if (message && ![401, 403, 404, 405].includes(response.status)) {
        throw new ApiBusinessError(path, message)
      }
      throw new HttpStatusError(response.status, path, message || text.slice(0, 200))
    }

    return parsed as T
  }

  // ---- 只读 ----

  version(): Promise<VersionInfo> {
    return this.request<VersionInfo>('/version')
  }

  configs(): Promise<ConfigsResponse> {
    return this.request<ConfigsResponse>('/configs')
  }

  async proxies(): Promise<Record<string, ProxyItem>> {
    const data = await this.request<ProxiesResponse>('/proxies')
    return data.proxies ?? {}
  }

  proxy(name: string): Promise<ProxyItem> {
    return this.request<ProxyItem>(`/proxies/${encodeURIComponent(name)}`)
  }

  async providers(): Promise<Record<string, ProviderItem>> {
    const data = await this.request<ProvidersResponse>('/providers/proxies')
    return data.providers ?? {}
  }

  connections(): Promise<ConnectionsResponse> {
    return this.request<ConnectionsResponse>('/connections')
  }

  /** 当前生效的规则列表（按匹配优先级排序） */
  async rules(): Promise<RuleItem[]> {
    const data = await this.request<RulesResponse>('/rules')
    return data.rules ?? []
  }

  /** 规则集 provider 列表 */
  async ruleProviders(): Promise<Record<string, RuleProviderItem>> {
    const data = await this.request<RuleProvidersResponse>('/providers/rules')
    return data.providers ?? {}
  }

  /** 触发规则集 provider 重新拉取 */
  updateRuleProvider(name: string): Promise<void> {
    return this.request<void>(`/providers/rules/${encodeURIComponent(name)}`, {
      method: 'PUT',
      timeout: 60_000,
    })
  }

  // ---- 运行时写操作（均不触碰配置文件）----

  /** index 必须来自最新 GET /rules。 */
  setRuleDisabled(index: number, disabled: boolean): Promise<void> {
    if (!Number.isInteger(index) || index < 0) throw new Error('规则索引必须为非负整数')
    return this.request<void>('/rules/disable', {
      method: 'PATCH',
      body: { [index]: disabled },
    })
  }

  /**
   * 切换代理组当前选中节点。
   * 实测：对 Selector 组会改 now；对 URLTest/Fallback 组则写 fixed 字段
   * 把该组钉死在指定节点（now 仍由测速决定，直到用 unfixProxy 解除）。
   */
  selectProxy(group: string, name: string): Promise<void> {
    return this.request<void>(`/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      body: { name },
    })
  }

  /** 解除 URLTest/Fallback 组的 fixed 钉选，恢复自动测速选路 */
  unfixProxy(group: string): Promise<void> {
    return this.request<void>(`/proxies/${encodeURIComponent(group)}`, { method: 'DELETE' })
  }

  /** 单节点延迟测试。节点不可用时内核返回 503 + message，抛 ApiBusinessError */
  testProxyDelay(name: string, url = this.testUrl, timeout = this.testTimeout): Promise<DelayResult> {
    return this.request<DelayResult>(`/proxies/${encodeURIComponent(name)}/delay`, {
      query: { url, timeout },
      timeout: timeout + 2000,
    })
  }

  /** 整组延迟测试，返回 {节点名: 延迟}，失效节点不出现在结果里 */
  testGroupDelay(
    group: string,
    url = this.testUrl,
    timeout = this.testTimeout,
  ): Promise<Record<string, number>> {
    return this.request<Record<string, number>>(`/group/${encodeURIComponent(group)}/delay`, {
      query: { url, timeout },
      timeout: timeout + 2000,
    })
  }

  /** 更新指定订阅（provider） */
  updateProvider(name: string): Promise<void> {
    return this.request<void>(`/providers/proxies/${encodeURIComponent(name)}`, {
      method: 'PUT',
      timeout: 60_000,
    })
  }

  /** 触发 provider 健康检查 */
  healthCheckProvider(name: string): Promise<void> {
    return this.request<void>(`/providers/proxies/${encodeURIComponent(name)}/healthcheck`, {
      timeout: 60_000,
    })
  }

  closeConnection(id: string): Promise<void> {
    return this.request<void>(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  closeAllConnections(): Promise<void> {
    return this.request<void>('/connections', { method: 'DELETE' })
  }

  /**
   * 切换运行模式：rule（规则）、global（全局）、direct（直连）
   */
  setMode(mode: 'rule' | 'global' | 'direct'): Promise<void> {
    return this.request<void>('/configs', {
      method: 'PATCH',
      body: { mode },
    })
  }

  /**
   * 热重载配置。内核自行从磁盘重新读取,本程序不写入任何内容。
   * path 为空时内核用启动时的配置路径。
   */
  reload(path = ''): Promise<void> {
    return this.request<void>('/configs', {
      method: 'PUT',
      query: { force: 'false' },
      body: { path, payload: '' },
      timeout: 30_000,
    })
  }

  /** WebSocket 地址；secret 只能走 query 参数（WebSocket 无法自定义请求头） */
  wsUrl(path: string, query: Record<string, string | number | undefined> = {}): string {
    const url = new URL(`${this.api}${path}`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    if (this.secret) url.searchParams.set('token', this.secret)
    return url.toString()
  }

  logsUrl(level: LogLevel = 'info'): string {
    return this.wsUrl('/logs', { level })
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ApiErrorBody).message === 'string'
  )
}
