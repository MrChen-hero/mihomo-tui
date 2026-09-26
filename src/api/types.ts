/**
 * REST API 响应类型。字段以本机 mihomo v1.19.24 实测响应为准，
 * 未实测确认的字段一律标为可选，避免类型比现实更乐观。
 */

/** GET /version */
export interface VersionInfo {
  meta: boolean
  version: string
}

/** 单次延迟测试记录 */
export interface DelayHistory {
  time: string
  /** 0 表示该次测试失败 */
  delay: number
}

export type ProxyKind =
  | 'Direct'
  | 'Reject'
  | 'RejectDrop'
  | 'Compatible'
  | 'Pass'
  | 'Selector'
  | 'URLTest'
  | 'Fallback'
  | 'LoadBalance'
  | 'Relay'
  | (string & {})

/** GET /proxies 中的单项：节点与代理组共用一种形状，组多出 all / now */
export interface ProxyItem {
  name: string
  type: ProxyKind
  alive: boolean
  history: DelayHistory[]
  /** 按 testUrl 分组的测速记录，实测 key 为测速地址 */
  extra?: Record<string, { alive: boolean; history: DelayHistory[] }>
  udp?: boolean
  /** 节点所属 provider，直接写在 config.yaml 里的节点为空串 */
  'provider-name'?: string
  /** 仅代理组有：组内成员名列表 */
  all?: string[]
  /** 仅代理组有：当前选中项 */
  now?: string
  /** 仅代理组有：组自身的测速地址 */
  testUrl?: string
  expectedStatus?: string
  hidden?: boolean
  icon?: string
  fixed?: string
  id?: string
}

/** GET /proxies */
export interface ProxiesResponse {
  proxies: Record<string, ProxyItem>
}

/** 订阅流量与到期信息，来自机场响应头 Subscription-Userinfo */
export interface SubscriptionInfo {
  Upload: number
  Download: number
  Total: number
  /** Unix 秒；0 表示无到期信息 */
  Expire: number
}

/** GET /providers/proxies 中的单项 */
export interface ProviderItem {
  name: string
  /** 实测取值：HTTP / File / Compatible（Compatible 是代理组的伪 provider） */
  vehicleType: 'HTTP' | 'File' | 'Compatible' | (string & {})
  /** 实测取值：Proxy */
  type?: string
  proxies: ProxyItem[]
  updatedAt?: string
  subscriptionInfo?: SubscriptionInfo
  expectedStatus?: string
  testUrl?: string
}

/** GET /providers/proxies */
export interface ProvidersResponse {
  providers: Record<string, ProviderItem>
}

/**
 * GET /rules 中的单条规则。字段以 mihari 对 mihomo 的实测响应为准
 * （type / payload / proxy），其余字段未在本机确认，标为可选。
 */
export interface RuleItem {
  /** 内核零基索引；旧内核可能省略，不能用筛选后的行号代替 */
  index?: number
  extra?: { disabled?: boolean }
  type: string
  payload: string
  /** 命中后的出口：代理组名 / DIRECT / REJECT */
  proxy: string
  /** 规则体量（rule-set 类规则才有） */
  size?: number
}

/** GET /rules */
export interface RulesResponse {
  rules: RuleItem[]
}

/** GET /providers/rules 中的单项（字段对齐 mihari 实测响应） */
export interface RuleProviderItem {
  name: string
  /** 实测取值：Rule */
  type?: string
  vehicleType: 'HTTP' | 'File' | (string & {})
  /** 实测取值：Classical / Domain / IPCIDR */
  behavior?: string
  /** 实测取值：YamlRule / Text */
  format?: string
  ruleCount?: number
  updatedAt?: string
}

/** GET /providers/rules */
export interface RuleProvidersResponse {
  providers: Record<string, RuleProviderItem>
}

/** GET /configs 中本项目实际用到的字段 */
export interface ConfigsResponse {
  'mixed-port': number
  port: number
  'socks-port': number
  mode: 'rule' | 'global' | 'direct'
  'log-level': string
  'allow-lan': boolean
  'bind-address': string
  ipv6: boolean
  tun?: { enable: boolean; stack?: string }
  [key: string]: unknown
}

/** GET /proxies/{name}/delay 与 /group/{group}/delay 的成功返回 */
export interface DelayResult {
  delay: number
}

/** 内核返回的业务错误，如延迟测试失败 */
export interface ApiErrorBody {
  message: string
}

/** GET /connections 单条连接 */
export interface ConnectionItem {
  id: string
  upload: number
  download: number
  start: string
  chains: string[]
  rule: string
  rulePayload: string
  metadata: {
    network: string
    type: string
    sourceIP: string
    destinationIP: string
    sourcePort: string
    destinationPort: string
    host: string
    dnsMode?: string
    processPath?: string
    remoteDestination?: string
    sniffHost?: string
  }
}

/** GET /connections（同时也是 WebSocket 推送帧的形状） */
export interface ConnectionsResponse {
  downloadTotal: number
  uploadTotal: number
  /** 无连接时内核返回 null，不是空数组 */
  connections: ConnectionItem[] | null
  memory: number
}

/** WebSocket /traffic 推送帧 */
export interface TrafficFrame {
  up: number
  down: number
  /** v1.19.24 实测带累计值 */
  upTotal?: number
  downTotal?: number
}

/** WebSocket /memory 推送帧 */
export interface MemoryFrame {
  inuse: number
  oslimit?: number
}

export type LogLevel = 'silent' | 'error' | 'warning' | 'info' | 'debug'

/** WebSocket /logs 推送帧 */
export interface LogFrame {
  type: LogLevel | (string & {})
  payload: string
}
