/**
 * 规则匹配纯函数测试：覆盖本地可判定类型与「需内核判定」的提前终止。
 */
import { describe, expect, it } from 'vitest'
import { matchRule, normalizeTarget, isLocallyDecidable, isIpLiteral, buildRulesTestResult } from '../matcher.js'
import type { RuleItem } from '../../api/types.js'

const rule = (type: string, payload: string, proxy = '出口'): RuleItem => ({ type, payload, proxy })

describe('matchRule', () => {
  it('DOMAIN 精确命中，大小写不敏感', () => {
    const rules = [rule('DOMAIN', 'Example.COM')]
    const hit = matchRule(rules, 'example.com')
    expect(hit).toMatchObject({ kind: 'hit', index: 0 })
  })

  it('DOMAIN 不匹配部分域名', () => {
    const rules = [rule('DOMAIN', 'example.com'), rule('MATCH', '')]
    const hit = matchRule(rules, 'sub.example.com')
    expect(hit).toMatchObject({ kind: 'hit', index: 1, rule: { type: 'MATCH' } })
  })

  it('DOMAIN-SUFFIX 命中自身与子域名，不命中后缀拼凑', () => {
    const rules = [rule('DOMAIN-SUFFIX', 'example.com')]
    expect(matchRule(rules, 'a.example.com').kind).toBe('hit')
    expect(matchRule(rules, 'example.com').kind).toBe('hit')
    expect(matchRule(rules, 'notexample.com').kind).toBe('miss')
  })

  it('DOMAIN-KEYWORD 按子串命中', () => {
    const rules = [rule('DOMAIN-KEYWORD', 'google')]
    expect(matchRule(rules, 'www.googlevideo.com').kind).toBe('hit')
    expect(matchRule(rules, 'example.com').kind).toBe('miss')
  })

  it('按顺序命中第一条，不继续向下', () => {
    const rules = [rule('DOMAIN-SUFFIX', 'com', '太宽'), rule('DOMAIN', 'example.com', '精确')]
    const hit = matchRule(rules, 'example.com')
    expect(hit).toMatchObject({ kind: 'hit', index: 0, rule: { proxy: '太宽' } })
  })

  it('IP-CIDR 命中网段内地址，域名需要内核 DNS 数据', () => {
    const rules = [rule('IP-CIDR', '1.2.3.0/24')]
    expect(matchRule(rules, '1.2.3.255').kind).toBe('hit')
    expect(matchRule(rules, '1.2.4.1').kind).toBe('miss')
    expect(matchRule(rules, 'example.com').kind).toBe('unsupported')
  })

  it('IP-CIDR 支持 IPv6', () => {
    const rules = [rule('IP-CIDR', '2001:db8::/32')]
    expect(matchRule(rules, '2001:db8:1::1').kind).toBe('hit')
    expect(matchRule(rules, '2001:db9::1').kind).toBe('miss')
  })

  it('/0 网段命中任意地址', () => {
    const rules = [rule('IP-CIDR', '0.0.0.0/0')]
    expect(matchRule(rules, '8.8.8.8').kind).toBe('hit')
  })

  it('GEOIP 本地无法判定，不能把后续 MATCH 当作命中', () => {
    const rules = [rule('GEOIP', 'CN', '直连'), rule('MATCH', '', '兜底')]
    const hit = matchRule(rules, '1.1.1.1')
    expect(hit).toMatchObject({ kind: 'unsupported', index: 0 })
  })

  it('MATCH 兜底命中', () => {
    const rules = [rule('MATCH', '')]
    expect(matchRule(rules, 'anything.example').kind).toBe('hit')
  })

  it('遇到 RULE-SET 返回 unsupported 并停在该条', () => {
    const rules = [rule('RULE-SET', 'reject-list'), rule('MATCH', '', '兜底')]
    const hit = matchRule(rules, 'example.com')
    expect(hit).toMatchObject({ kind: 'unsupported', index: 0, rule: { type: 'RULE-SET' } })
  })

  it('RULE-SET 之前的规则仍正常命中', () => {
    const rules = [rule('DOMAIN', 'example.com', '命中'), rule('RULE-SET', 'reject-list')]
    expect(matchRule(rules, 'example.com')).toMatchObject({ kind: 'hit', index: 0 })
  })

  it('PROCESS-NAME 同样不可本地判定', () => {
    const rules = [rule('PROCESS-NAME', 'curl')]
    expect(matchRule(rules, 'example.com').kind).toBe('unsupported')
  })

  it('空规则列表返回 miss', () => {
    expect(matchRule([], 'example.com').kind).toBe('miss')
  })

  it('非法 CIDR 无法判断，不能跳过', () => {
    const rules = [rule('IP-CIDR', 'not-a-cidr'), rule('MATCH', '')]
    expect(matchRule(rules, '1.2.3.4')).toMatchObject({ kind: 'unsupported', index: 0 })
  })
})

describe('真实内核类型与输入边界', () => {
  it.each(['Domain', 'DOMAIN', 'domain'])('识别 %s，保留原始响应', (type) => {
    const item = { ...rule(type, 'example.com'), index: 7, extra: { disabled: false } }
    expect(matchRule([item], 'EXAMPLE.COM.')).toMatchObject({ kind: 'hit', rule: item })
  })
  it('识别 DomainSuffix / DomainKeyword / IPCIDR / Match', () => {
    expect(matchRule([rule('DomainSuffix', 'example.com')], 'a.example.com').kind).toBe('hit')
    expect(matchRule([rule('DomainKeyword', 'example')], 'example.net').kind).toBe('hit')
    expect(matchRule([rule('IPCIDR', '10.0.0.0/8')], '10.0.0.1').kind).toBe('hit')
    expect(matchRule([rule('Match', '')], '10.0.0.1').kind).toBe('hit')
  })
  it.each(['RuleSet', 'GeoIP', 'GEOSITE', 'ProcessName', 'FutureRule'])('%s 阻止假命中', (type) => {
    expect(matchRule([rule(type, 'x'), rule('Match', '')], 'x.example').kind).toBe('unsupported')
  })
  it('跳过已禁用的未知规则，序号不变', () => {
    const rules = [{ ...rule('RuleSet', 'x'), extra: { disabled: true } }, rule('Match', '')]
    expect(buildRulesTestResult(rules, 'example.com')).toMatchObject({ outcome: 'hit', index: 2 })
  })
  it.each(['', 'https://example.com', 'example.com:443', 'a/b', '-bad.com', 'a..com', 'a_.com',
    '999.1.1.1', '1.2.3', ':::', '1:2:3', '::1::1', '[::1]', 'fe80::1%lo', 'a'.repeat(64) + '.com',
    Array(5).fill('a'.repeat(60)).join('.')])('拒绝非法目标 %s', (target) => {
    expect(() => matchRule([rule('Match', '')], target)).toThrow('有效域名或 IP')
  })
  it('规范化 Unicode 域名与 localhost；IP 不当作域名', () => {
    expect(normalizeTarget(' 例子.测试. ')).toBe('xn--fsqu00a.xn--0zwm56d')
    expect(normalizeTarget('LOCALHOST')).toBe('localhost')
    for (const type of ['Domain', 'DomainSuffix', 'DomainKeyword']) {
      expect(matchRule([rule(type, '1.1.1.1')], '1.1.1.1').kind).toBe('miss')
    }
  })
  it.each([
    ['192.0.2.5/32', '192.0.2.5', 'hit'], ['192.0.2.5/32', '192.0.2.6', 'miss'],
    ['::/0', '2001:db8::1', 'hit'], ['::1/128', '::1', 'hit'], ['::1/128', '::2', 'miss'],
    ['2001:db8::/33', '2001:db8:8000::1', 'miss'],
    ['2001:db8:0000:0000:0000:0000:0000:0001/128', '2001:db8::1', 'hit'],
    ['::ffff:192.0.2.0/120', '::ffff:192.0.2.8', 'hit'],
    ['1.2.3.0/24', '::1', 'miss'], ['::/0', '1.2.3.4', 'miss'],
    ['1.2.3.4/33', '1.2.3.4', 'unsupported'], ['::/129', '::1', 'unsupported'],
    ['::/-1', '::1', 'unsupported'], ['::/', '::1', 'unsupported'],
    ['::/1/2', '::1', 'unsupported'], ['fe80::1%lo/64', '::1', 'unsupported'],
  ])('CIDR %s / %s => %s', (cidr, host, outcome) => {
    expect(matchRule([rule('IP-CIDR6', cidr)], host).kind).toBe(outcome)
  })
  it('辅助函数与未命中结果', () => {
    expect(isLocallyDecidable('DomainSuffix')).toBe(true)
    expect(isLocallyDecidable('GEOIP')).toBe(false)
    expect(isIpLiteral('::1')).toBe(true)
    expect(isIpLiteral('example.com')).toBe(false)
    expect(buildRulesTestResult([], 'example.com')).toEqual({ target: 'example.com', outcome: 'miss', rule: null, index: null })
  })
})
