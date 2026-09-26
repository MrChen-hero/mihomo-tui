/**
 * 规则展示模型测试：过滤、序号保持、provider 分区、标题行不可选。
 */
import { describe, expect, it } from 'vitest'
import { buildRuleRows, isSelectableRow, ruleTypes } from '../model.js'
import type { RuleItem, RuleProviderItem } from '../../api/types.js'

const rule = (type: string, payload: string, proxy = '出口'): RuleItem => ({ type, payload, proxy })
const provider = (name: string): RuleProviderItem => ({ name, vehicleType: 'HTTP', ruleCount: 3 })

describe('buildRuleRows', () => {
  const rules = [rule('DOMAIN', 'a.com'), rule('DOMAIN-SUFFIX', 'google.com', '媒体'), rule('MATCH', '')]

  it('按类型与关键字过滤，序号保持为原列表位置', () => {
    const rows = buildRuleRows(rules, [], { type: 'DOMAIN-SUFFIX', keyword: 'GOOGLE' })
    expect(rows).toEqual([{ kind: 'rule', rule: rules[1], index: 2 }])
  })

  it('关键字同时匹配出口组', () => {
    const rows = buildRuleRows(rules, [], { type: '', keyword: '媒体' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'rule', index: 2 })
  })

  it('规则集分区始终附在末尾，不受过滤影响', () => {
    const rows = buildRuleRows(rules, [provider('reject')], { type: 'MATCH', keyword: '' })
    expect(rows.map((row) => row.kind)).toEqual(['rule', 'header', 'provider'])
  })

  it('没有规则集时不出现分区标题', () => {
    const rows = buildRuleRows(rules, [], { type: '', keyword: '' })
    expect(rows.every((row) => row.kind === 'rule')).toBe(true)
  })

  it('标题行不可选中，其余可选', () => {
    const rows = buildRuleRows([], [provider('reject')], { type: '', keyword: '' })
    expect(rows.map(isSelectableRow)).toEqual([false, true])
  })
})

describe('ruleTypes', () => {
  it('去重并保持出现顺序', () => {
    expect(ruleTypes([rule('DOMAIN', 'a'), rule('MATCH', ''), rule('DOMAIN', 'b')])).toEqual([
      'DOMAIN',
      'MATCH',
    ])
  })
})
