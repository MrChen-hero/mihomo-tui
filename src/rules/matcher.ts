/** 保守本地匹配：遇到无法确定的前序规则即停止，不预测最终出口节点。 */
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import type { RuleItem } from '../api/types.js'
import { normalizeRuleType } from './types.js'

export class InvalidTargetError extends Error {
  constructor() { super('请输入有效域名或 IP（不含协议、端口或路径）'); this.name = 'InvalidTargetError' }
}

export function normalizeTarget(target: string): string {
  const value = target.trim().toLowerCase()
  if (isIP(value) && !value.includes('%')) return value
  if (!value || /[\s:/\\@?#%\[\]]/.test(value) || /^[\d.]+$/.test(value)) throw new InvalidTargetError()
  const host = domainToASCII(value.replace(/\.$/, ''))
  if (!host || host.length > 253 || host.split('.').some((label) =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new InvalidTargetError()
  return host
}

export type MatchOutcome =
  | { kind: 'hit'; index: number; rule: RuleItem }
  | { kind: 'miss' }
  | { kind: 'unsupported'; index: number; rule: RuleItem }

const SUPPORTED = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'MATCH'])
export const isLocallyDecidable = (type: string): boolean => SUPPORTED.has(normalizeRuleType(type))
export const isIpLiteral = (value: string): boolean => isIP(value) !== 0

export function matchRule(rules: RuleItem[], target: string): MatchOutcome {
  const host = normalizeTarget(target)
  for (const [index, rule] of rules.entries()) {
    if (rule.extra?.disabled === true) continue
    const matched = ruleMatches(rule, host)
    if (matched === undefined) return { kind: 'unsupported', index, rule }
    if (matched) return { kind: 'hit', index, rule }
  }
  return { kind: 'miss' }
}

function ruleMatches(rule: RuleItem, host: string): boolean | undefined {
  const payload = rule.payload.toLowerCase()
  switch (normalizeRuleType(rule.type)) {
    case 'DOMAIN': return !isIP(host) && host === payload
    case 'DOMAIN-SUFFIX': return !isIP(host) && (host === payload || host.endsWith('.' + payload))
    case 'DOMAIN-KEYWORD': return !isIP(host) && host.includes(payload)
    case 'IP-CIDR':
    case 'IP-CIDR6':
      // 域名可能被内核解析成 IP；无 DNS 数据时不能跳过此规则。
      return isIP(host) ? ipInCidr(host, rule.payload) : undefined
    case 'MATCH': return true
    default: return undefined
  }
}

function ipInteger(ip: string): bigint {
  if (isIP(ip) === 4) return ip.split('.').reduce((value, octet) => (value << 8n) | BigInt(octet), 0n)
  // isIP 已验证 IPv6；将末尾 IPv4 映射地址转为两个十六位段。
  let expanded = ip
  if (ip.includes('.')) {
    const pos = ip.lastIndexOf(':')
    const v4 = ipInteger(ip.slice(pos + 1))
    expanded = ip.slice(0, pos) + ':' + (v4 >> 16n).toString(16) + ':' + (v4 & 65535n).toString(16)
  }
  const [left = '', right = ''] = expanded.split('::')
  const head = left ? left.split(':') : []
  const tail = right ? right.split(':') : []
  const groups = expanded.includes('::') ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail] : head
  return groups.reduce((value, group) => (value << 16n) | BigInt('0x' + group), 0n)
}

function ipInCidr(host: string, cidr: string): boolean | undefined {
  const [base = '', prefix = '', ...extra] = cidr.trim().split('/')
  const family = isIP(base)
  const bits = Number(prefix)
  const width = family === 4 ? 32 : 128
  if (!family || base.includes('%') || extra.length || !/^\d+$/.test(prefix) || bits > width) return undefined
  if (isIP(host) !== family) return false
  const shift = BigInt(width - bits)
  return (ipInteger(host) >> shift) === (ipInteger(base) >> shift)
}

export interface RulesTestResult {
  target: string
  outcome: 'hit' | 'miss' | 'unsupported'
  rule: RuleItem | null
  /** 原始列表中的一基序号，不是 PATCH 使用的内核索引。 */
  index: number | null
}

export function buildRulesTestResult(rules: RuleItem[], target: string): RulesTestResult {
  const result = matchRule(rules, target)
  return result.kind === 'miss'
    ? { target, outcome: 'miss', rule: null, index: null }
    : { target, outcome: result.kind, rule: result.rule, index: result.index + 1 }
}
