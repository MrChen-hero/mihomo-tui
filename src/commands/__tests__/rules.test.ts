/**
 * 规则测试结论的纯函数测试（不经网络）。
 */
import { describe, expect, it } from 'vitest'
import { buildRulesTestResult } from '../rules.js'
import type { RuleItem } from '../../api/types.js'

const rule = (type: string, payload: string, proxy: string): RuleItem => ({ type, payload, proxy })

describe('buildRulesTestResult', () => {
  const rules = [
    rule('DOMAIN-SUFFIX', 'example.com', '代理'),
    rule('RULE-SET', 'reject-list', '拒绝'),
    rule('MATCH', '', '兜底'),
  ]

  it('命中时给出序号与出口', () => {
    expect(buildRulesTestResult(rules, 'a.example.com')).toEqual({
      target: 'a.example.com',
      outcome: 'hit',
      rule: rules[0],
      index: 1,
    })
  })

  it('受阻于不可判定规则时标注 unsupported 且不给出误导出', () => {
    const result = buildRulesTestResult(rules, 'other.com')
    expect(result.outcome).toBe('unsupported')
    expect(result.index).toBe(2)
    expect(result.rule?.proxy).toBe('拒绝')
  })
})
