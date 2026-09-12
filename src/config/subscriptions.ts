/**
 * 订阅清单（subscriptions.json）的读取、校验与原子写入。
 *
 *  - URL 含 token：错误信息只报 name，绝不把 URL 拼进异常文本；
 *  - 原子写：先写 <path>.tmp 再 rename，任何失败都清理临时文件；
 *  - 读取时逐条校验并按名称排序，保证后续骨架生成幂等。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Subscription, SubscriptionsFile } from './types.js'

export const SUBS_PATH = join(homedir(), '.config', 'mihomo-tui', 'subscriptions.json')

export type SubscriptionValidation =
  | { ok: true; data: Subscription }
  | { ok: false; error: string }

const NAME_RE = /^[a-z0-9_-]+$/i
const MAX_NAME = 32
const MAX_URL = 2048
const MAX_PREFIX = 10

/**
 * 单条订阅的完整校验（设计稿 4.1 实现要点）。
 * name：字母数字与 -_，1–32 位；url：http(s) 且可解析，≤2048；prefix：≤10 字符。
 */
export function validateSubscription(sub: Partial<Subscription>): SubscriptionValidation {
  const name = typeof sub.name === 'string' ? sub.name.trim() : ''
  if (!name) return { ok: false, error: '订阅名称不能为空' }
  if (name.length > MAX_NAME) return { ok: false, error: `订阅名称不能超过 ${MAX_NAME} 个字符` }
  if (!NAME_RE.test(name)) return { ok: false, error: '名称只能包含字母数字与 -_（要用作文件名）' }

  const url = typeof sub.url === 'string' ? sub.url.trim() : ''
  if (!url) return { ok: false, error: '订阅 URL 不能为空' }
  if (url.length > MAX_URL) return { ok: false, error: `订阅 URL 不能超过 ${MAX_URL} 个字符` }
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'URL 必须以 http:// 或 https:// 开头' }
  try {
    new URL(url)
  } catch {
    return { ok: false, error: 'URL 格式错误' }
  }

  const prefix = sub.prefix
  if (prefix !== undefined && typeof prefix !== 'string') {
    return { ok: false, error: '前缀格式错误' }
  }
  if (prefix !== undefined && prefix.length > MAX_PREFIX) {
    return { ok: false, error: `节点名前缀不能超过 ${MAX_PREFIX} 个字符` }
  }

  return { ok: true, data: prefix ? { name, url, prefix } : { name, url } }
}

/** 重名判断（大小写不敏感：name 要用作文件名，不能只差大小写） */
export function isDuplicateName(name: string, existing: Subscription[]): boolean {
  const lower = name.toLowerCase()
  return existing.some((sub) => sub.name.toLowerCase() === lower)
}

/** 读取订阅清单。文件缺失 / JSON 坏 / 条目不合法 / 空清单都直接抛错。 */
export function loadSubscriptions(path: string = SUBS_PATH): Subscription[] {
  if (!existsSync(path)) {
    throw new Error(
      `找不到订阅清单：${path}\n` +
        '请创建该文件，格式：\n' +
        '{ "subscriptions": [ { "name": "xxx", "prefix": "[X] ", "url": "https://..." } ] }',
    )
  }
  let data: unknown
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`订阅清单不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
  }
  const subs = (data as Partial<SubscriptionsFile> | null)?.subscriptions
  if (!Array.isArray(subs) || subs.length === 0) {
    throw new Error('订阅清单为空')
  }
  const validated: Subscription[] = []
  for (const raw of subs) {
    // 报错只带 name，防止 token 随 URL 泄进日志
    const result = validateSubscription((raw ?? {}) as Partial<Subscription>)
    const name = typeof (raw as Subscription | undefined)?.name === 'string'
      ? (raw as Subscription).name
      : '（未知）'
    if (!result.ok) throw new Error(`订阅条目不合法（name=${name}）：${result.error}`)
    validated.push(result.data)
  }
  // 按名称排序保证幂等
  return validated.sort((a, b) => a.name.localeCompare(b.name))
}

/** 原子保存订阅清单：写 .tmp 再 rename，失败清理临时文件 */
export function saveSubscriptions(subs: Subscription[], path: string = SUBS_PATH): void {
  const file: SubscriptionsFile = { subscriptions: subs }
  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 清理失败不影响上抛原始错误
    }
    throw new Error(`保存订阅清单失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 订阅 URL 含 token，任何展示都必须脱敏。
 * 按键名与按值形态双重判断 —— 机场用的参数名五花八门，只看键名会漏。
 */
function looksLikeSecret(value: string): boolean {
  return (
    /^[0-9a-f]{16,}$/i.test(value) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
    /^[A-Za-z0-9_-]{24,}$/.test(value)
  )
}

export function redactUrl(url: string): string {
  if (!url) return url
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  // 手工拼接而非用 searchParams.set —— 后者会把 <REDACTED> 的尖括号转义成 %3C%3E
  const query = [...parsed.searchParams.entries()]
    .map(([key, value]) =>
      /token|secret|key|password|auth|uuid|sub/i.test(key) || looksLikeSecret(value)
        ? `${key}=<REDACTED>`
        : `${key}=${value}`,
    )
    .join('&')
  // 形如 /api/v1/client/subscribe/<32位以上十六进制或 uuid> 的路径段
  const path = parsed.pathname.replace(
    /\/[0-9a-f]{16,}(?=\/|$)|\/[0-9a-f-]{32,}(?=\/|$)/gi,
    '/<REDACTED>',
  )
  return `${parsed.origin}${path}${query ? `?${query}` : ''}`
}
