/**
 * 订阅清单与骨架配置的共享类型（设计稿 4.1 / 4.2 / 4.3）。
 */

export interface Subscription {
  /** 字母数字与 -_；同时用作 provider 名与缓存文件名 */
  name: string
  /** 订阅地址，含 token，任何展示与日志必须经 redactUrl 脱敏 */
  url: string
  /** 节点名统一前缀，如 '[Y] ' */
  prefix?: string
}

export interface SubscriptionsFile {
  subscriptions: Subscription[]
}

/** YAML.parse 的产物：字段类型未知，使用前逐个收敛 */
export type ParsedYaml = Record<string, unknown>

export interface RegionDef {
  name: string
  /** Go RE2 语法，作用于节点名 */
  filter: string
}

export interface SkeletonOptions {
  /** 默认 true：翻开 dns.enable 并写入本机实测可达的上游 */
  enableDns?: boolean
  /** 延迟测试地址 */
  testUrl?: string
  /** 区域组定义，默认内置 9 组 */
  regions?: RegionDef[]
}

export type ValidateResult = { ok: true; output: string } | { ok: false; output: string }

/** applyConfig 各阶段的失败定位（设计稿 4.3） */
export type ErrorPhase = 'generate' | 'backup' | 'validate' | 'write'

export interface ApplySuccess {
  ok: true
  backupPath: string
  warnings: string[]
}
export interface ApplyFailure {
  ok: false
  error: string
  phase: ErrorPhase
}
export type ApplyResult = ApplySuccess | ApplyFailure
