/** Pure draft operations. IDs belong to the editing session, never the kernel. */
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'

export const FORM_TYPES = ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6',
  'SRC-IP-CIDR', 'SRC-PORT', 'DST-PORT', 'PROCESS-NAME', 'PROCESS-PATH', 'RULE-SET', 'MATCH'] as const
export interface RuleForm { type: string; value: string; target: string; noResolve: boolean }
export interface DraftRow { id: string; raw: string; original?: string; originalIndex?: number }
export interface RuleDraft {
  rows: DraftRow[]
  baseline: DraftRow[]
  protectedRules: string[]
  targets: string[]
  providers: string[]
  moved: Set<string>
  /** Order before each row's first explicit move, including rows inserted in this draft. */
  moveOrigins?: Map<string, string[]>
  blocked?: string
}
export const ruleType = (raw: string): string => raw.slice(0, raw.indexOf(',')).trim().toUpperCase()
const canonical = (raw: string): string => raw.split(',').length === 3 ? raw.split(',').map(s => s.trim()).join(',') : raw
export const isProtected = (draft: RuleDraft, row: DraftRow): boolean => draft.protectedRules.includes(canonical(row.raw))
export const isDirty = (draft: RuleDraft): boolean => JSON.stringify(draft.rows.map(r => r.raw)) !== JSON.stringify(draft.baseline.map(r => r.raw))

export function protectionError(draft: RuleDraft): string | undefined {
  const found = draft.rows.filter(r => isProtected(draft, r))
  if (found.length !== draft.protectedRules.length || draft.protectedRules.some((raw, i) => canonical(draft.rows[i]?.raw ?? '') !== raw)) {
    return '订阅直连规则缺失、重复或不在有序前缀；请先通过订阅配置流程同步'
  }
}

export function parseForm(raw: string, draft?: Pick<RuleDraft, 'targets' | 'providers'>): RuleForm | undefined {
  const parts = raw.split(',').map(s => s.trim())
  const type = parts[0] ?? ''
  if (!(FORM_TYPES as readonly string[]).includes(type)) return
  const match = type === 'MATCH'
  const flags = ['IP-CIDR', 'IP-CIDR6', 'RULE-SET'].includes(type)
  const length = match ? 2 : 3
  if (parts.length !== length && !(flags && parts.length === length + 1 && parts[length] === 'no-resolve')) return
  const form = { type, value: match ? '' : parts[1] ?? '', target: parts[match ? 1 : 2] ?? '', noResolve: parts[length] === 'no-resolve' }
  try { checkForm(form, draft) } catch { return }
  // Only offer the form when it can reproduce the original without losing formatting or flags.
  if (formatForm(form) !== raw) return
  return form
}

export function checkForm(form: RuleForm, draft?: Pick<RuleDraft, 'targets' | 'providers'>): void {
  if (!(FORM_TYPES as readonly string[]).includes(form.type)) throw new Error('不支持的表单类型')
  if (!form.target || /[,\r\n\0]/.test(form.target) || (draft && !draft.targets.includes(form.target))) throw new Error('目标不存在于当前配置')
  if (form.noResolve && !['IP-CIDR', 'IP-CIDR6', 'RULE-SET'].includes(form.type)) throw new Error('该表单不支持 no-resolve')
  if (form.type === 'MATCH') return
  if (!form.value.trim() || /[,\r\n\0]/.test(form.value)) throw new Error('匹配值不能为空或包含逗号、换行')
  if (form.type.includes('CIDR')) {
    const [address, prefix, extra] = form.value.split('/')
    const version = isIP(address ?? '')
    if (!version || extra !== undefined || !/^\d+$/.test(prefix ?? '') || Number(prefix) > (version === 4 ? 32 : 128) ||
        (form.type === 'IP-CIDR6' && version !== 6) || (form.type === 'IP-CIDR' && version !== 4)) throw new Error('网段地址或前缀长度无效')
  }
  if (form.type.endsWith('-PORT')) {
    const [start, end = start] = form.value.split('-').map(Number)
    if (!/^\d+(?:-\d+)?$/.test(form.value) || !start || !end || start > end || end > 65535) throw new Error('端口需为 1–65535 或递增范围')
  }
  if (form.type === 'RULE-SET' && draft && !draft.providers.includes(form.value)) throw new Error('规则集不存在于当前配置')
}
export function formatForm(form: RuleForm): string {
  return [form.type, ...(form.type === 'MATCH' ? [] : [form.value]), form.target, ...(form.noResolve ? ['no-resolve'] : [])].join(',')
}
export function checkRaw(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('只能输入单条规则，不允许换行或 NUL')
  const raw = value.trim()
  if (!/^[A-Za-z][A-Za-z0-9-]*\s*,.+/.test(raw)) throw new Error('请输入完整单条规则，不含 YAML 列表符号或外层引号')
  return raw
}
export function draftErrors(draft: RuleDraft): string[] {
  const errors: string[] = []
  if (draft.blocked) errors.push(draft.blocked)
  const protection = protectionError(draft)
  if (protection) errors.push(protection)
  const matches = draft.rows.flatMap((r, i) => ruleType(r.raw) === 'MATCH' ? [i] : [])
  if (matches.length > 1 || (matches.length === 1 && matches[0] !== draft.rows.length - 1)) errors.push('MATCH 最多一条且必须位于末尾')
  for (const row of draft.rows) {
    try {
      checkRaw(row.raw)
      // Recognize simple syntax for reference checking, without rebuilding raw expressions.
      const form = parseForm(row.raw.trim().split(',').map(s => s.trim()).join(','))
      if (form) checkForm(form, draft)
    } catch (err) { errors.push(err instanceof Error ? err.message : String(err)) }
  }
  return [...new Set(errors)]
}
function writable(draft: RuleDraft, id?: string): void {
  const error = draft.blocked ?? protectionError(draft)
  if (error) throw new Error(error)
  if (id && isProtected(draft, getRow(draft, id))) throw new Error('订阅直连 · 自动维护（按规则内容识别），不可修改')
}
function getRow(draft: RuleDraft, id: string): DraftRow {
  const row = draft.rows.find(r => r.id === id)
  if (!row) throw new Error('所选规则已不存在')
  return row
}
function checkedRaw(draft: RuleDraft, raw: string): string {
  const value = checkRaw(raw)
  if (draft.protectedRules.includes(canonical(value))) throw new Error('此订阅直连规则已由程序维护')
  return value
}
export function addRule(draft: RuleDraft, raw: string, before?: string, filtered = false, formMatch = false): RuleDraft {
  writable(draft)
  if (filtered) throw new Error('清除筛选后可新增或调整顺序')
  const row: DraftRow = { id: randomUUID(), raw: checkedRaw(draft, raw) }
  let at = before ? draft.rows.findIndex(r => r.id === before) : -1
  if (at < 0) at = draft.rows.at(-1) && ruleType(draft.rows.at(-1)!.raw) === 'MATCH' ? draft.rows.length - 1 : draft.rows.length
  at = Math.max(at, draft.protectedRules.length)
  if (formMatch && ruleType(row.raw) === 'MATCH') at = draft.rows.length
  return { ...draft, rows: [...draft.rows.slice(0, at), row, ...draft.rows.slice(at)] }
}
export function editRule(draft: RuleDraft, id: string, raw: string): RuleDraft {
  writable(draft, id)
  const value = checkedRaw(draft, raw)
  return { ...draft, rows: draft.rows.map(r => r.id === id ? { ...r, raw: value } : r) }
}
export function deleteRule(draft: RuleDraft, id: string): RuleDraft {
  writable(draft, id)
  return { ...draft, rows: draft.rows.filter(r => r.id !== id) }
}
export function moveRule(draft: RuleDraft, id: string, direction: 1 | -1, filtered = false): RuleDraft {
  writable(draft, id)
  if (filtered) throw new Error('清除筛选后可新增或调整顺序')
  const at = draft.rows.findIndex(r => r.id === id)
  const to = at + direction
  if (to < draft.protectedRules.length || to >= draft.rows.length) throw new Error('已到可移动边界')
  if ((ruleType(draft.rows[at]!.raw) === 'MATCH' && at === draft.rows.length - 1) ||
      (ruleType(draft.rows[to]!.raw) === 'MATCH' && to === draft.rows.length - 1)) throw new Error('不能越过末尾 MATCH')
  const rows = [...draft.rows]
  ;[rows[at], rows[to]] = [rows[to]!, rows[at]!]
  const moveOrigins = new Map(draft.moveOrigins)
  if (!moveOrigins.has(id)) moveOrigins.set(id, draft.rows.map(r => r.id))
  return { ...draft, rows, moved: new Set([...draft.moved, id]), moveOrigins }
}
export function movedRowIds(draft: RuleDraft): Set<string> {
  if (!isDirty(draft)) return new Set()
  const current = new Map(draft.rows.map((r, i) => [r.id, i]))
  return new Set([...draft.moved].filter(id => {
    const at = current.get(id)
    if (at === undefined) return false
    const origin = draft.moveOrigins?.get(id) ?? draft.baseline.map(r => r.id)
    const before = origin.indexOf(id)
    return origin.some((other, i) => other !== id && current.has(other) &&
      (i < before) !== (current.get(other)! < at))
  }))
}
export function changeSummary(draft: RuleDraft) {
  const present = new Set(draft.rows.map(r => r.id))
  return {
    added: draft.rows.filter(r => r.original === undefined).length,
    edited: draft.rows.filter(r => r.original !== undefined && r.original !== r.raw).length,
    deleted: draft.baseline.filter(r => !present.has(r.id)).length,
    moved: movedRowIds(draft).size,
  }
}
