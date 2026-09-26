/** 内核响应保留原文；只在比较、筛选和展示时使用规范名称。 */
const TYPES: Record<string, string> = {
  domain: 'DOMAIN', domainsuffix: 'DOMAIN-SUFFIX', domainkeyword: 'DOMAIN-KEYWORD',
  ipcidr: 'IP-CIDR', ipcidr6: 'IP-CIDR6', geoip: 'GEOIP', geosite: 'GEOSITE',
  ruleset: 'RULE-SET', processname: 'PROCESS-NAME', processpath: 'PROCESS-PATH', match: 'MATCH',
}

export function normalizeRuleType(type: string): string {
  return TYPES[type.replace(/[-_]/g, '').toLowerCase()] ?? type.toUpperCase()
}
