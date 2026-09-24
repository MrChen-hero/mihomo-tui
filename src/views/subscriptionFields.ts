/**
 * 订阅表单的逐字段校验（设计稿 7.3）。纯函数，与 subscriptions.ts 的
 * validateSubscription 保持同一套规则口径。
 */
import { isDuplicateName, validateSubscription } from '../config/subscriptions.js'
import type { Subscription } from '../config/types.js'

export const MAX_NAME_LENGTH = 32
export const MAX_PREFIX_LENGTH = 10

export function validateNameInput(value: string, existing: Subscription[]): string | undefined {
  if (!value) return '订阅名称不能为空'
  if (value.length > MAX_NAME_LENGTH) return `订阅名称不能超过 ${MAX_NAME_LENGTH} 个字符`
  if (!/^[a-z0-9_-]+$/i.test(value)) return '名称只能包含字母数字与 -_'
  if (isDuplicateName(value, existing)) return `订阅名称 "${value}" 已存在`
  return undefined
}

export function validateUrlInput(value: string): string | undefined {
  if (!value) return '订阅 URL 不能为空'
  const result = validateSubscription({ name: 'x', url: value })
  if (!result.ok) {
    // 只挑出 URL 相关的错误文案，名称规则由 validateNameInput 负责
    if (result.error.includes('URL')) return result.error
    return 'URL 格式错误'
  }
  return undefined
}

export function validatePrefixInput(value: string): string | undefined {
  if (value.length > MAX_PREFIX_LENGTH) return `节点名前缀不能超过 ${MAX_PREFIX_LENGTH} 个字符`
  return undefined
}

export const MAX_GROUP_LENGTH = 16
/** 更新间隔上限（分钟）：30 天 */
export const MAX_INTERVAL_MINUTES = 43_200

export function validateGroupInput(value: string): string | undefined {
  if (!value.trim()) return undefined
  const result = validateSubscription({ name: 'x', url: 'https://x', group: value })
  if (!result.ok && result.error.includes('分组')) return result.error
  return undefined
}

/** 留空表示禁用自动更新；否则必须是 1–43200 的整数分钟 */
export function validateIntervalInput(value: string): string | undefined {
  const text = value.trim()
  if (!text) return undefined
  if (!/^[1-9]\d*$/.test(text)) return '更新间隔必须是正整数（分钟），留空表示禁用自动更新'
  const minutes = Number(text)
  if (minutes > MAX_INTERVAL_MINUTES) return `更新间隔不能超过 ${MAX_INTERVAL_MINUTES} 分钟`
  return undefined
}
