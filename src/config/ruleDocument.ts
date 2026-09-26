import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import YAML, { isMap, isScalar, isSeq, Scalar, YAMLSeq } from 'yaml'
import { subscriptionDirectRules } from './skeleton.js'
import { loadSubscriptions, SUBS_PATH } from './subscriptions.js'
import { protectionError, type RuleDraft } from '../rules/editor.js'

export interface FileAttributes { mode: number; uid: number; gid: number }
export const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
export interface RuleSnapshot {
  path: string
  bytes: Buffer
  hash: string
  subscriptionsPath: string
  subscriptionsHash: string
  attributes: FileAttributes
  document: ReturnType<typeof YAML.parseDocument>
  draft: RuleDraft
}

export function readRuleSnapshot(path: string, subscriptionsPath = SUBS_PATH): RuleSnapshot {
  path = resolve(path)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('配置必须是普通文件，不支持符号链接：' + path)
  const bytes = readFileSync(path)
  const document = YAML.parseDocument(bytes.toString('utf8'))
  if (document.errors.length || !isMap(document.contents)) throw new Error('配置 YAML 无效或顶层不是映射：' + path)
  const rules = document.get('rules', true)
  if (document.has('rules') && (!isSeq(rules) || rules.items.some(n => !isScalar(n) || typeof n.value !== 'string'))) {
    throw new Error('rules 必须是字符串列表；不支持别名、映射、null 或混合条目')
  }
  let blocked: string | undefined
  if (isSeq(rules) && (rules.anchor || rules.tag || rules.items.some(n => isScalar(n) && (n.anchor || n.tag)))) {
    blocked = 'rules 的锚点或自定义标签不支持写入'
  }
  // Merged rules cannot be safely localized to a new top-level sequence.
  if (document.contents.items.some(p => isScalar(p.key) && p.key.value === '<<')) blocked = '顶层 YAML 合并来源不支持规则写入'
  const config = document.toJS() as Record<string, unknown>
  let protectedRules: string[] = []
  let subscriptionsHash = ''
  try {
    const before = readFileSync(subscriptionsPath)
    protectedRules = subscriptionDirectRules(loadSubscriptions(subscriptionsPath))
    const after = readFileSync(subscriptionsPath)
    if (!before.equals(after)) throw new Error('读取时订阅清单发生变化，请重新打开')
    subscriptionsHash = digest(after)
  } catch { blocked = '订阅清单缺失、为空、损坏或读取期间变化，禁止写入：' + subscriptionsPath }
  try { accessSync(path, constants.R_OK | constants.W_OK) } catch { blocked = '配置文件不可读写：' + path }
  const names = (value: unknown): string[] => Array.isArray(value)
    ? value.flatMap(v => v && typeof v.name === 'string' ? [v.name] : []) : []
  const rows = isSeq(rules) ? rules.items.map((n, originalIndex) => {
    const raw = (n as Scalar<string>).value
    return { id: randomUUID(), raw, original: raw, originalIndex }
  }) : []
  const draft: RuleDraft = {
    rows, baseline: rows.map(r => ({ ...r })), protectedRules,
    targets: [...new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', ...names(config['proxy-groups']), ...names(config.proxies)])],
    providers: Object.keys((config['rule-providers'] ?? {}) as object), moved: new Set(), blocked,
  }
  draft.blocked ??= protectionError(draft)
  return { path, bytes, hash: digest(bytes), subscriptionsPath: resolve(subscriptionsPath), subscriptionsHash,
    attributes: { mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid }, document, draft }
}

export function renderRuleCandidate(snapshot: RuleSnapshot, draft: RuleDraft): string {
  const document = snapshot.document.clone()
  const original = snapshot.document.get('rules', true)
  const sequence = isSeq(original) ? original.clone() : new YAMLSeq()
  sequence.items = draft.rows.map(row => {
    const prior = row.originalIndex === undefined || !isSeq(original) ? undefined : original.items[row.originalIndex]
    const node = isScalar(prior) ? prior.clone() as Scalar<string> : new Scalar(row.raw)
    node.value = row.raw
    return node
  })
  document.set('rules', sequence)
  const candidate = document.toString({ lineWidth: 0 })
  if (YAML.parseDocument(candidate).errors.length) throw new Error('候选 YAML 无法解析')
  return candidate
}

export function assertSnapshot(snapshot: RuleSnapshot, hash = snapshot.hash): void {
  const stat = lstatSync(snapshot.path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== snapshot.attributes.uid || stat.gid !== snapshot.attributes.gid ||
      (stat.mode & 0o7777) !== snapshot.attributes.mode || digest(readFileSync(snapshot.path)) !== hash ||
      digest(readFileSync(snapshot.subscriptionsPath)) !== snapshot.subscriptionsHash) {
    throw new Error('配置或订阅清单已被其他操作修改；请重新打开编辑器')
  }
}
