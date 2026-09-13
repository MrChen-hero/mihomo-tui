/**
 * 骨架配置生成：从 scripts/migrate-config.mjs 迁移的纯函数集。
 *
 *  - 全部函数不做任何文件 I/O，问题以 warnings 返回而非打印；
 *  - 常量是本机实测得出的，语义变更须先在本机验证（见 migrate-config.mjs 注释）；
 *  - 生成是幂等的：相同输入产出逐字节一致的结果。
 */
import type { ParsedYaml, RegionDef, SkeletonOptions, Subscription } from './types.js'

/** 机场塞进节点列表里的伪装条目（实测三家订阅都有），统一过滤 */
export const EXCLUDE_FILTER =
  '(?i)(剩余|到期|官网|流量|套餐|重置|过期|群组|订阅|邀请|客服|网址|建议|丢失|重置)'

export const TEST_URL = 'https://www.gstatic.com/generate_204'

/**
 * DNS 上游。**这组值是本机实测得出的，不能照搬旧配置。**
 *
 * 本机网络环境实测（2026-08-17）：
 *   - UDP 53 → 223.5.5.5 / 8.8.8.8 / 1.1.1.1 / 114.114.114.114  全部不通
 *   - DoT 853 → 223.5.5.5 / 119.29.29.29                        不通
 *   - UDP 53 → 网关 192.168.200.1                                ✅ 可用
 *   - DoH 443 → 1.12.12.12 / 120.53.53.53（IP 直连）              ✅ 可用
 *
 * 旧配置的致命链条：`nameserver: doh.pub` 需要先解析 `doh.pub`，
 * 而 bootstrap 用的 853 端口在本机不通 → 所有解析失败。
 * 因此 bootstrap 用网关 IP，主上游用 IP 字面量的 DoH，完全绕开域名 bootstrap。
 */
export const DNS_UPSTREAM = {
  // bootstrap 只能填纯 IP，且必须是本机真正可达的
  'default-nameserver': ['192.168.200.1'],
  // IP 字面量 DoH，无需 bootstrap 解析
  nameserver: ['https://1.12.12.12/dns-query', 'https://120.53.53.53/dns-query'],
  'direct-nameserver': ['https://1.12.12.12/dns-query', 'https://120.53.53.53/dns-query'],
  // respect-rules: true 要求此项非空，否则 mihomo -t 直接拒绝
  'proxy-server-nameserver': ['https://1.12.12.12/dns-query', 'https://120.53.53.53/dns-query'],
} as const

/**
 * 区域组定义。filter 为 Go RE2 语法，已用真实 216 个节点名验证过归类结果。
 * 注意：台湾组含 🇨🇳 —— 实测三家订阅把台湾节点标为 🇨🇳，且没有真正的中国大陆节点。
 */
export const REGIONS: RegionDef[] = [
  { name: '香港', filter: '(?i)(香港|hk|hong ?kong|🇭🇰)' },
  { name: '台湾', filter: '(?i)(台湾|台灣|臺灣|taiwan|🇹🇼|🇨🇳)' },
  { name: '日本', filter: '(?i)(日本|jp|japan|东京|大阪|🇯🇵)' },
  { name: '韩国', filter: '(?i)(韩国|韓國|korea|首尔|🇰🇷)' },
  { name: '新加坡', filter: '(?i)(新加坡|狮城|singapore|🇸🇬)' },
  { name: '美国', filter: '(?i)(美国|美國|united ?states|洛杉矶|圣何塞|西雅图|🇺🇸)' },
  { name: '英国', filter: '(?i)(英国|英國|united ?kingdom|britain|伦敦|🇬🇧)' },
  { name: '德国', filter: '(?i)(德国|德國|germany|法兰克福|🇩🇪)' },
  { name: '荷兰', filter: '(?i)(荷兰|荷蘭|netherlands|🇳🇱)' },
]

/** 未归入区域的节点（实测 67 个）走这里 */
export const OTHERS_NAME = '其他地区'

/**
 * 旧配置里的主选择组名是机场品牌名「Yue.to | 悦通」，重命名为 PROXY，
 * rules 里的引用由 rewriteRules 同步改写（实测 61 条）。
 */
export const RENAME_GROUPS = new Map([['Yue.to | 悦通', 'PROXY']])

/** 旧配置中按用途分流的组，保留原名以免动 234 条 rules 的语义 */
export const PURPOSE_GROUPS = [
  'AI',
  'Google',
  'YouTube',
  'TikTok',
  'Telegram',
  '社交媒体',
  '流媒体',
  '游戏平台',
  '兜底分流',
] as const

/**
 * 订阅域名必须直连。
 * 内核拉取订阅时也走自身 rules，若落到 MATCH 指向的代理组，
 * 而该组的节点又来自尚未拉取成功的 provider，就会形成死锁（实测踩到过）。
 */
export function subscriptionDirectRules(subs: Subscription[]): string[] {
  const hosts = new Set<string>()
  for (const sub of subs) {
    try {
      hosts.add(new URL(sub.url).hostname)
    } catch {
      // URL 非法在 loadSubscriptions 已拦，这里兜底忽略
    }
  }
  return [...hosts].sort().map((host) => `DOMAIN,${host},DIRECT`)
}

/** 生成 proxy-providers 段 */
export function buildProviders(
  subs: Subscription[],
  testUrl: string = TEST_URL,
): Record<string, unknown> {
  const providers: Record<string, unknown> = {}
  for (const sub of subs) {
    providers[sub.name] = {
      type: 'http',
      url: sub.url,
      // 必须是相对路径：mihomo 对 provider path 有安全校验，
      // 配置文件外的绝对路径会被拒绝
      path: `./providers/${sub.name}.yaml`,
      interval: 3600,
      'exclude-filter': EXCLUDE_FILTER,
      ...(sub.prefix ? { override: { 'additional-prefix': sub.prefix } } : {}),
      'health-check': {
        enable: true,
        url: testUrl,
        interval: 300,
        lazy: true,
      },
    }
  }
  return providers
}

/** 生成 proxy-groups 段 */
export function buildGroups(
  subs: Subscription[],
  regions: RegionDef[] = REGIONS,
  testUrl: string = TEST_URL,
): Record<string, unknown>[] {
  const regionNames = regions.map((region) => region.name)
  const airportNames = subs.map((sub) => `机场-${sub.name}`)

  // 主组：手动选择，成员为自动组 + 区域组 + 机场组 + DIRECT
  const main = {
    name: 'PROXY',
    type: 'select',
    proxies: ['AUTO', 'FALLBACK', ...regionNames, OTHERS_NAME, ...airportNames, 'DIRECT'],
  }

  const auto = {
    name: 'AUTO',
    type: 'url-test',
    'include-all-providers': true,
    url: testUrl,
    interval: 300,
    tolerance: 100,
    lazy: true,
  }

  const fallback = {
    name: 'FALLBACK',
    type: 'fallback',
    'include-all-providers': true,
    url: testUrl,
    interval: 300,
    lazy: true,
  }

  // 区域组：跨机场混用
  const regionGroups = regions.map((region) => ({
    name: region.name,
    type: 'url-test',
    'include-all-providers': true,
    filter: region.filter,
    url: testUrl,
    interval: 300,
    tolerance: 100,
    lazy: true,
  }))

  // 其他地区：把不属于上述区域的节点兜起来，用 select 由人工挑
  const others = {
    name: OTHERS_NAME,
    type: 'select',
    'include-all-providers': true,
    'exclude-filter': regions.map((r) => r.filter.replace(/^\(\?i\)/, '')).join('|'),
  }

  // 单机场组：按机场分别列出，便于定位某家机场的问题
  const airports = subs.map((sub) => ({
    name: `机场-${sub.name}`,
    type: 'select',
    use: [sub.name],
  }))

  // 用途组：保留旧配置的组名，使 234 条 rules 无需大改
  const purposes = PURPOSE_GROUPS.map((name) => ({
    name,
    type: 'select',
    proxies:
      name === '游戏平台' || name === '兜底分流'
        ? ['DIRECT', 'PROXY', 'AUTO', ...regionNames, OTHERS_NAME]
        : ['PROXY', 'AUTO', ...regionNames, OTHERS_NAME, 'DIRECT'],
  }))

  return [main, auto, fallback, ...regionGroups, others, ...airports, ...purposes]
}

/**
 * 改写 rules 里对已重命名/已消失组的引用。
 * 只替换规则的「目标」字段（最后一段，或 no-resolve 前一段），不碰域名部分。
 */
export function rewriteRules(
  rules: string[],
  groupNames: Iterable<string>,
): { rules: string[]; missing: Map<string, number> } {
  const known = new Set([...groupNames, 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'])
  const rewritten: string[] = []
  const missing = new Map<string, number>()

  for (const rule of rules) {
    const parts = rule.split(',')
    const tailIndex = parts.at(-1)?.trim() === 'no-resolve' ? parts.length - 2 : parts.length - 1
    const target = parts[tailIndex]?.trim()
    if (!target) {
      rewritten.push(rule)
      continue
    }

    const renamed = RENAME_GROUPS.get(target)
    if (renamed) {
      parts[tailIndex] = renamed
      rewritten.push(parts.join(','))
      continue
    }

    // 目标组在新骨架里不存在 —— 改指向兜底组并记录
    if (!known.has(target)) {
      missing.set(target, (missing.get(target) ?? 0) + 1)
      parts[tailIndex] = '兜底分流'
      rewritten.push(parts.join(','))
      continue
    }
    rewritten.push(rule)
  }
  return { rules: rewritten, missing }
}

// ---- 从 ParsedYaml 收敛字段的守卫：旧配置字段类型不受信任 ----
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isString(value: unknown): value is string {
  return typeof value === 'string'
}
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}
function pickString(source: ParsedYaml, key: string, fallback: string): string {
  const value = source[key]
  return isString(value) && value !== '' ? value : fallback
}
function pickBool(source: ParsedYaml, key: string, fallback: boolean): boolean {
  const value = source[key]
  return isBoolean(value) ? value : fallback
}
function pickNumber(source: ParsedYaml, key: string, fallback: number): number {
  const value = source[key]
  return isNumber(value) ? value : fallback
}
function pickRecord(source: ParsedYaml, key: string): ParsedYaml | undefined {
  const value = source[key]
  return isRecord(value) ? (value as ParsedYaml) : undefined
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

/**
 * 构造完整的新配置对象，保留旧配置里所有需要维护的手工设置。
 * 问题不抛异常、不打印，统一进 warnings（设计稿 4.2）。
 */
export function buildSkeleton(
  oldConfig: ParsedYaml,
  subscriptions: Subscription[],
  options: SkeletonOptions = {},
): { skeleton: ParsedYaml; warnings: string[] } {
  const enableDns = options.enableDns ?? true
  const testUrl = options.testUrl ?? TEST_URL
  const regions = options.regions ?? REGIONS

  const groups = buildGroups(subscriptions, regions, testUrl)
  const groupNames = groups.map((group) => String(group.name))
  const oldRules = isStringArray(oldConfig.rules) ? oldConfig.rules : []
  const { rules: rewritten, missing } = rewriteRules(oldRules, groupNames)

  // 订阅域名的 DIRECT 规则必须在最前面。去重之外还要剥离「已删除订阅」
  // 遗留的直连规则：上一轮清单里有、这一轮没有的主机名，其规则是孤儿
  // （手工为无关域名添加的 DIRECT 规则不受影响）。
  const directRules = subscriptionDirectRules(subscriptions)
  const directSet = new Set(directRules)
  const currentHosts = new Set(
    subscriptions.map((sub) => hostOf(sub.url)).filter((host) => host !== undefined),
  )
  const staleRules = new Set(
    (options.previousSubscriptions ?? [])
      .map((sub) => hostOf(sub.url))
      .filter((host): host is string => host !== undefined && !currentHosts.has(host))
      .map((host) => `DOMAIN,${host},DIRECT`),
  )
  const rules = [
    ...directRules,
    ...rewritten.filter((rule) => !directSet.has(rule) && !staleRules.has(rule)),
  ]

  // dns 段整体保留，只按需翻开 enable 并替换上游
  const dns: ParsedYaml = { ...(pickRecord(oldConfig, 'dns') ?? {}) }
  const dnsWasDisabled = dns['enable'] === false
  if (enableDns) {
    dns['enable'] = true
    // 上游必须换成本机实测可达的，照搬旧值会导致 bootstrap 失败
    Object.assign(dns, DNS_UPSTREAM)
    // respect-rules 让 DNS 查询遵循 rules 分流，配合非空 proxy-server-nameserver 使用
    dns['respect-rules'] = true
  }

  const skeleton: ParsedYaml = {
    // 通用设置：沿用旧值，端口与控制口保持不变以免破坏现有 proxy_on 与本工具
    'mixed-port': pickNumber(oldConfig, 'mixed-port', 17890),
    'allow-lan': pickBool(oldConfig, 'allow-lan', false),
    'bind-address': pickString(oldConfig, 'bind-address', '127.0.0.1'),
    ipv6: pickBool(oldConfig, 'ipv6', true),
    mode: pickString(oldConfig, 'mode', 'rule'),
    'log-level': pickString(oldConfig, 'log-level', 'info'),
    'external-controller': pickString(oldConfig, 'external-controller', '127.0.0.1:19090'),
    'tcp-concurrent': pickBool(oldConfig, 'tcp-concurrent', true),
    'unified-delay': pickBool(oldConfig, 'unified-delay', true),
    'keep-alive-interval': pickNumber(oldConfig, 'keep-alive-interval', 15),
    'keep-alive-idle': pickNumber(oldConfig, 'keep-alive-idle', 300),
    ...(pickRecord(oldConfig, 'experimental') ? { experimental: pickRecord(oldConfig, 'experimental') } : {}),
    ...(pickRecord(oldConfig, 'profile') ? { profile: pickRecord(oldConfig, 'profile') } : {}),
    ...(pickRecord(oldConfig, 'sniffer') ? { sniffer: pickRecord(oldConfig, 'sniffer') } : {}),
    dns,
    'proxy-providers': buildProviders(subscriptions, testUrl),
    'proxy-groups': groups,
    ...(pickRecord(oldConfig, 'rule-providers')
      ? { 'rule-providers': pickRecord(oldConfig, 'rule-providers') }
      : {}),
    rules,
  }

  const warnings: string[] = []
  for (const [name, count] of [...missing].sort((a, b) => b[1] - a[1])) {
    warnings.push(`rules 中 ${count} 条指向的组 '${name}' 已不存在，改指向'兜底分流'`)
  }
  if (dnsWasDisabled && enableDns) {
    warnings.push(
      'dns.enable: false → true，旧配置中的 nameserver-policy 将开始生效，DNS 上游已替换为本机实测可达地址',
    )
  }

  return { skeleton, warnings }
}
