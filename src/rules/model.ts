/**
 * 规则列表的过滤与展示模型（纯函数）。
 *
 * 规则页把「生效规则」与「规则集 provider」拼成一份可滚动的行：
 * 规则行可选中，分区标题行不可选中。过滤只作用于规则行，provider 行始终保留。
 */
import type { RuleItem, RuleProviderItem } from '../api/types.js'
import { normalizeRuleType } from './types.js'

export type RuleRow =
  | { kind: 'header'; label: string }
  | { kind: 'rule'; rule: RuleItem; /** 在未过滤列表中的序号（从 1 计） */ index: number }
  | { kind: 'provider'; provider: RuleProviderItem }

export interface RuleFilter {
  /** 规则类型，空串表示不限 */
  type: string
  /** 关键字，匹配 payload 或出口组，大小写不敏感 */
  keyword: string
}

/** 当前规则列表里出现过的类型，供类型过滤循环切换 */
export function ruleTypes(rules: RuleItem[]): string[] {
  return [...new Set(rules.map((rule) => normalizeRuleType(rule.type)))]
}

/** 组装展示行：过滤后的规则在上，规则集分区在下 */
export function buildRuleRows(
  rules: RuleItem[],
  providers: RuleProviderItem[],
  filter: RuleFilter,
): RuleRow[] {
  const needle = filter.keyword.trim().toLowerCase()
  const matched = rules
    .map((rule, position) => ({ rule, index: position + 1 }))
    .filter(({ rule }) => (filter.type ? normalizeRuleType(rule.type) === normalizeRuleType(filter.type) : true))
    .filter(({ rule }) =>
      needle ? `${rule.payload} ${rule.proxy}`.toLowerCase().includes(needle) : true,
    )

  const rows: RuleRow[] = matched.map(({ rule, index }) => ({ kind: 'rule', rule, index }))
  if (providers.length > 0) {
    rows.push({ kind: 'header', label: `规则集 · ${providers.length}` })
    for (const provider of providers) rows.push({ kind: 'provider', provider })
  }
  return rows
}

/** 标题行不可选中 */
export function isSelectableRow(row: RuleRow): boolean {
  return row.kind !== 'header'
}
