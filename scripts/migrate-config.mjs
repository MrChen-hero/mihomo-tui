#!/usr/bin/env node
/**
 * scripts/migrate-config.mjs —— 一次性配置迁移脚本
 *
 * 把 config.yaml 从「整份 proxies 列表」改造为「骨架 + proxy-providers」架构。
 *
 * 这是本项目**唯一**允许写 config.yaml 的代码，因此：
 *   - 默认 --dry-run，只打印不落盘；写入必须显式 --apply；
 *   - --apply 先备份为 config.yaml.bak.<时间戳>；
 *   - 写入前在临时目录用 `mihomo -t` 校验，校验失败拒绝写入；
 *   - 写入后再校验一次，失败则从备份自动回滚；
 *   - 幂等：重复运行结果一致（provider 与组按固定顺序生成）；
 *   - 打印时订阅 URL 一律脱敏，写入文件时才是真实 URL。
 *
 * 用法：
 *   node scripts/migrate-config.mjs --dry-run           # 预览骨架
 *   node scripts/migrate-config.mjs --dry-run --diff     # 预览并显示与现有配置的差异摘要
 *   node scripts/migrate-config.mjs --apply             # 备份 + 校验 + 写入
 *   node scripts/migrate-config.mjs --apply --no-dns    # 写入但保持 dns.enable 原值
 */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'

const HOME = homedir()
const MIHOMO_DIR = join(HOME, '.config', 'mihomo')
const CONFIG_PATH = join(MIHOMO_DIR, 'config.yaml')
const SUBS_PATH = join(HOME, '.config', 'mihomo-tui', 'subscriptions.json')
const MIHOMO_BIN = join(HOME, 'bin', 'mihomo')

/** 机场塞进节点列表里的伪装条目（实测三家订阅都有），统一过滤 */
const EXCLUDE_FILTER =
  '(?i)(剩余|到期|官网|流量|套餐|重置|过期|群组|订阅|邀请|客服|网址|建议|丢失|重置)'

const TEST_URL = 'https://www.gstatic.com/generate_204'

/**
 * DNS 上游。**这组值是本机实测得出的，不能照搬旧配置。**
 *
 * 本机网络环境实测（2026-08-17）：
 *   - UDP 53 → 223.5.5.5 / 8.8.8.8 / 1.1.1.1 / 114.114.114.114  全部不通
 *   - DoT 853 → 223.5.5.5 / 119.29.29.29                        不通
 *   - UDP 53 → 网关 192.168.200.1                                ✅ 可用
 *   - DoH 443 → 1.12.12.12 / 120.53.53.53（IP 直连）              ✅ 可用
 *   - DoH 域名 doh.pub / dns.alidns.com                          需先解析域名
 *
 * 旧配置的致命链条：`nameserver: doh.pub` 需要先解析 `doh.pub`，
 * 而 `default-nameserver: tls://223.5.5.5`（853 端口）在本机不通，
 * bootstrap 失败 → 所有解析失败。这正是 `dns.enable` 一直只能是 `false` 的原因。
 *
 * 因此：bootstrap 用网关 IP，主上游用 IP 字面量的 DoH，完全绕开域名 bootstrap。
 */
const DNS_UPSTREAM = {
  // bootstrap 只能填纯 IP，且必须是本机真正可达的
  'default-nameserver': ['192.168.200.1'],
  // IP 字面量 DoH，无需 bootstrap 解析
  nameserver: ['https://1.12.12.12/dns-query', 'https://120.53.53.53/dns-query'],
  'direct-nameserver': ['https://1.12.12.12/dns-query', 'https://120.53.53.53/dns-query'],
  // respect-rules: true 要求此项非空，否则 mihomo -t 直接拒绝
  'proxy-server-nameserver': ['https://1.12.12.12/dns-query', 'https://120.53.53.53/dns-query'],
}

/**
 * 区域组定义。filter 为 Go RE2 语法，已用真实 216 个节点名验证过归类结果。
 * 注意：台湾组含 🇨🇳 —— 实测三家订阅把台湾节点标为 🇨🇳（如「[L] 🇨🇳台湾专线01」），
 * 且没有任何真正的中国大陆节点，故并入台湾组不会误收。
 */
const REGIONS = [
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

/** 未归入上述区域的节点（实测 67 个，含欧洲小国、南美、非洲等）走这里 */
const OTHERS_NAME = '其他地区'

/**
 * 旧配置里的主选择组名是机场品牌名「Yue.to | 悦通」。
 * 现在有三家机场，该名已不合适，重命名为 PROXY，并同步改写 rules 里的引用（实测 61 条）。
 */
const RENAME_GROUPS = new Map([['Yue.to | 悦通', 'PROXY']])

/**
 * 订阅域名必须直连。
 * 内核拉取订阅时也走自身的 rules，若落到 MATCH 指向的代理组，
 * 而该组的节点又来自尚未拉取成功的 provider，就会形成死锁（实测踩到过）。
 */
function subscriptionDirectRules(subs) {
  const hosts = new Set()
  for (const sub of subs) {
    try {
      hosts.add(new URL(sub.url).hostname)
    } catch {
      // URL 非法在 loadSubscriptions 已拦，这里兜底忽略
    }
  }
  return [...hosts].sort().map((host) => `DOMAIN,${host},DIRECT`)
}

/** 旧配置中按用途分流的组，保留原名以免动 234 条 rules 的语义 */
const PURPOSE_GROUPS = [
  'AI',
  'Google',
  'YouTube',
  'TikTok',
  'Telegram',
  '社交媒体',
  '流媒体',
  '游戏平台',
  '兜底分流',
]

function parseArgs(argv) {
  const flags = new Set(argv.slice(2))
  const unknown = [...flags].filter(
    (f) => !['--dry-run', '--apply', '--diff', '--no-dns', '-h', '--help'].includes(f),
  )
  return {
    apply: flags.has('--apply'),
    diff: flags.has('--diff'),
    enableDns: !flags.has('--no-dns'),
    help: flags.has('-h') || flags.has('--help'),
    unknown,
  }
}

/** 订阅 URL 含 token，任何打印都必须脱敏（SPEC 8.4） */
function redact(url) {
  try {
    const parsed = new URL(url)
    const query = [...parsed.searchParams.keys()].map((key) => `${key}=<REDACTED>`).join('&')
    const path = parsed.pathname.replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, '/<REDACTED>')
    return `${parsed.origin}${path}${query ? `?${query}` : ''}`
  } catch {
    return '<REDACTED>'
  }
}

function fail(message) {
  process.stderr.write(`错误：${message}\n`)
  process.exit(1)
}

function loadSubscriptions() {
  if (!existsSync(SUBS_PATH)) {
    fail(
      `找不到订阅清单：${SUBS_PATH}\n` +
        '请创建该文件，格式：\n' +
        '{ "subscriptions": [ { "name": "xxx", "prefix": "[X] ", "url": "https://..." } ] }',
    )
  }
  let data
  try {
    data = JSON.parse(readFileSync(SUBS_PATH, 'utf8'))
  } catch (err) {
    fail(`订阅清单不是合法 JSON：${err.message}`)
  }
  const subs = data.subscriptions
  if (!Array.isArray(subs) || subs.length === 0) fail('订阅清单为空')
  for (const sub of subs) {
    if (!sub.name || !sub.url) fail(`订阅条目缺少 name 或 url：${JSON.stringify(sub)}`)
    if (!/^[a-z0-9_-]+$/i.test(sub.name)) {
      fail(`provider 名称只允许字母数字与 -_（因为要用作文件名）：${sub.name}`)
    }
  }
  // 按名称排序保证幂等
  return subs.slice().sort((a, b) => a.name.localeCompare(b.name))
}

/** 生成 proxy-providers 段 */
function buildProviders(subs) {
  const providers = {}
  for (const sub of subs) {
    providers[sub.name] = {
      type: 'http',
      url: sub.url,
      // 必须是相对路径：mihomo 对 provider path 有安全校验，
      // 配置文件外的绝对路径会被拒绝（SPEC 4.1 的 PoC 踩坑记录）
      path: `./providers/${sub.name}.yaml`,
      interval: 3600,
      'exclude-filter': EXCLUDE_FILTER,
      ...(sub.prefix ? { override: { 'additional-prefix': sub.prefix } } : {}),
      'health-check': {
        enable: true,
        url: TEST_URL,
        interval: 300,
        lazy: true,
      },
    }
  }
  return providers
}

/** 生成 proxy-groups 段 */
function buildGroups(subs) {
  const regionNames = REGIONS.map((r) => r.name)
  const airportNames = subs.map((s) => `机场-${s.name}`)

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
    url: TEST_URL,
    interval: 300,
    tolerance: 100,
    lazy: true,
  }

  const fallback = {
    name: 'FALLBACK',
    type: 'fallback',
    'include-all-providers': true,
    url: TEST_URL,
    interval: 300,
    lazy: true,
  }

  // 区域组：跨机场混用（解决 P3）
  const regions = REGIONS.map((region) => ({
    name: region.name,
    type: 'url-test',
    'include-all-providers': true,
    filter: region.filter,
    url: TEST_URL,
    interval: 300,
    tolerance: 100,
    lazy: true,
  }))

  // 其他地区：把不属于上述区域的节点兜起来，用 select 由人工挑
  const others = {
    name: OTHERS_NAME,
    type: 'select',
    'include-all-providers': true,
    'exclude-filter': REGIONS.map((r) => r.filter.replace(/^\(\?i\)/, '')).join('|'),
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

  return [main, auto, fallback, ...regions, others, ...airports, ...purposes]
}

/**
 * 改写 rules 里对已重命名组的引用。
 * 只替换规则的「目标」字段（最后一段，或 no-resolve 前一段），不碰域名部分。
 */
function rewriteRules(rules, groupNames) {
  const known = new Set([...groupNames, 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'])
  const rewritten = []
  const missing = new Map()

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

    // 目标组在新骨架里不存在 —— 记下来，最后统一改指向兜底组并报告
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

/** 构造完整的新配置对象。保留旧配置里所有需要维护的手工设置。 */
function buildSkeleton(old, subs, enableDns) {
  const providers = buildProviders(subs)
  const groups = buildGroups(subs)
  const groupNames = groups.map((g) => g.name)
  const { rules: rewritten, missing } = rewriteRules(old.rules ?? [], groupNames)

  // 订阅域名的 DIRECT 规则必须在最前面，且去掉旧配置里可能已有的重复条目
  const directRules = subscriptionDirectRules(subs)
  const directSet = new Set(directRules)
  const rules = [...directRules, ...rewritten.filter((rule) => !directSet.has(rule))]

  // dns 段整体保留，只按需翻开 enable 并替换上游。
  // 旧配置 17 行 nameserver-policy（claude.ai/openai.com → 1.1.1.1）此前是死配置，
  // enable: true 后才真正生效（SPEC 3.4 故障 1）。
  const dns = { ...(old.dns ?? {}) }
  const dnsWasDisabled = dns.enable === false
  if (enableDns) {
    dns.enable = true
    // 上游必须换成本机实测可达的，照搬旧值会导致 bootstrap 失败（见 DNS_UPSTREAM 注释）
    Object.assign(dns, DNS_UPSTREAM)
    // respect-rules 让 DNS 查询遵循 rules 分流，配合非空 proxy-server-nameserver 使用
    dns['respect-rules'] = true
  }

  const skeleton = {
    // 通用设置：沿用旧值，端口与控制口保持不变以免破坏现有 proxy_on 与本工具
    'mixed-port': old['mixed-port'] ?? 17890,
    'allow-lan': old['allow-lan'] ?? false,
    'bind-address': old['bind-address'] ?? '127.0.0.1',
    ipv6: old.ipv6 ?? true,
    mode: old.mode ?? 'rule',
    'log-level': old['log-level'] ?? 'info',
    'external-controller': old['external-controller'] ?? '127.0.0.1:19090',
    'tcp-concurrent': old['tcp-concurrent'] ?? true,
    'unified-delay': old['unified-delay'] ?? true,
    'keep-alive-interval': old['keep-alive-interval'] ?? 15,
    'keep-alive-idle': old['keep-alive-idle'] ?? 300,
    ...(old.experimental ? { experimental: old.experimental } : {}),
    ...(old.profile ? { profile: old.profile } : {}),
    ...(old.sniffer ? { sniffer: old.sniffer } : {}),
    dns,
    'proxy-providers': providers,
    'proxy-groups': groups,
    ...(old['rule-providers'] ? { 'rule-providers': old['rule-providers'] } : {}),
    rules,
  }

  return { skeleton, missing, dnsWasDisabled, groupNames, directRules }
}

/**
 * 在临时目录里用 `mihomo -t` 校验配置。
 *
 * 为什么用临时目录：不能让校验过程往真实配置目录写任何东西。
 * 实测确认 -t 不需要 ruleset 缓存与 provider 缓存在场即可通过（rule-providers
 * 与 proxy-providers 都是懒加载），也不会在目录里创建文件。
 *
 * 注意不要放 GEOIP/GEOSITE 规则的配置进来 —— 那会触发 mmdb 联网下载并超时失败。
 * 本项目的 rules 实测全部是 DOMAIN-SUFFIX / RULE-SET / DOMAIN，无 GEO 规则。
 */
function validate(yamlText) {
  if (!existsSync(MIHOMO_BIN)) fail(`找不到 mihomo 二进制：${MIHOMO_BIN}`)
  const dir = mkdtempSync(join(tmpdir(), 'mihomo-migrate-'))
  const file = join(dir, 'config.yaml')
  try {
    writeFileSync(file, yamlText, 'utf8')
    const output = execFileSync(MIHOMO_BIN, ['-t', '-d', dir, '-f', file], {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, output }
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}` || err.message
    return { ok: false, output }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 统计新旧配置的差异，供 --diff 展示 */
function summarize(old, skeleton, subs, missing, directRules) {
  const oldGroups = (old['proxy-groups'] ?? []).map((g) => g.name)
  const newGroups = skeleton['proxy-groups'].map((g) => g.name)
  const oldRules = old.rules ?? []
  // 置顶的直连规则会让后续行整体位移，逐行下标比较会误报；改为按集合比较
  const oldSet = new Set(oldRules)
  return {
    proxiesRemoved: (old.proxies ?? []).length,
    providersAdded: subs.length,
    groupsBefore: oldGroups.length,
    groupsAfter: newGroups.length,
    groupsDropped: oldGroups.filter((g) => !newGroups.includes(g)),
    groupsAdded: newGroups.filter((g) => !oldGroups.includes(g)),
    rulesTotal: skeleton.rules.length,
    rulesAdded: directRules.length,
    rulesChanged: skeleton.rules.filter(
      (rule) => !oldSet.has(rule) && !directRules.includes(rule),
    ).length,
    ruleProviders: Object.keys(skeleton['rule-providers'] ?? {}).length,
    missing,
  }
}

function printHelp() {
  process.stdout.write(`用法：node scripts/migrate-config.mjs [选项]

选项：
  --dry-run     只打印将生成的骨架，不写入任何文件（默认行为）
  --diff        与 --dry-run 搭配，额外打印新旧配置的差异摘要
  --apply       备份原配置、校验、写入。这是唯一会修改 config.yaml 的开关
  --no-dns      保持 dns.enable 的原值（默认会改为 true）
  -h, --help    显示本帮助

订阅清单来自：${SUBS_PATH}
目标配置文件：${CONFIG_PATH}
`)
}

function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    printHelp()
    return
  }
  if (args.unknown.length > 0) {
    process.stderr.write(`未知选项：${args.unknown.join(', ')}\n\n`)
    printHelp()
    process.exit(2)
  }

  if (!existsSync(CONFIG_PATH)) fail(`找不到现有配置：${CONFIG_PATH}`)
  const originalText = readFileSync(CONFIG_PATH, 'utf8')
  let old
  try {
    old = YAML.parse(originalText)
  } catch (err) {
    fail(`现有 config.yaml 解析失败：${err.message}`)
  }

  const subs = loadSubscriptions()
  const { skeleton, missing, dnsWasDisabled, directRules } = buildSkeleton(
    old,
    subs,
    args.enableDns,
  )
  const yamlText = YAML.stringify(skeleton, { lineWidth: 0, singleQuote: true })

  // ---- 预览 ----
  process.stdout.write('=== 将生成的骨架配置 ===\n\n')
  process.stdout.write('provider（订阅作为节点来源）：\n')
  for (const sub of subs) {
    process.stdout.write(
      `  ${sub.name.padEnd(10)} ${redact(sub.url)}\n` +
        `  ${' '.repeat(10)} path=./providers/${sub.name}.yaml  prefix=${JSON.stringify(sub.prefix ?? '')}\n`,
    )
  }

  process.stdout.write('\n代理组：\n')
  for (const group of skeleton['proxy-groups']) {
    const detail = group.filter
      ? `filter=${group.filter}`
      : group.use
        ? `use=[${group.use.join(', ')}]`
        : group['include-all-providers']
          ? 'include-all-providers'
          : `proxies=[${(group.proxies ?? []).join(', ')}]`
    process.stdout.write(`  ${group.name.padEnd(12)} ${group.type.padEnd(9)} ${detail}\n`)
  }

  process.stdout.write('\n置顶的订阅直连规则（防止拉订阅时形成死锁）：\n')
  for (const rule of directRules) process.stdout.write(`  ${rule}\n`)

  process.stdout.write('\n保留的手工配置：\n')
  for (const [label, present] of [
    ['sniffer（嗅探白名单）', Boolean(skeleton.sniffer)],
    ['dns（含 nameserver-policy）', Boolean(skeleton.dns)],
    ['experimental', Boolean(skeleton.experimental)],
    ['profile', Boolean(skeleton.profile)],
    [
      `rule-providers（${Object.keys(skeleton['rule-providers'] ?? {}).length} 个）`,
      Boolean(skeleton['rule-providers']),
    ],
    [`rules（${skeleton.rules.length} 条）`, skeleton.rules.length > 0],
  ]) {
    process.stdout.write(`  ${present ? '✅' : '❌'} ${label}\n`)
  }

  if (dnsWasDisabled) {
    process.stdout.write(
      args.enableDns
        ? '\n⚠️  dns.enable: false → true\n' +
            '   旧配置里 17 行 nameserver-policy（claude.ai/openai.com → 1.1.1.1）此前是死配置，将开始生效。\n' +
            '   同时替换 DNS 上游为本机实测可达的地址（旧值会导致 bootstrap 失败）：\n' +
            `     default-nameserver      ${DNS_UPSTREAM['default-nameserver'].join(', ')}\n` +
            `     nameserver              ${DNS_UPSTREAM.nameserver.join(', ')}\n` +
            `     proxy-server-nameserver ${DNS_UPSTREAM['proxy-server-nameserver'].join(', ')}\n` +
            '     respect-rules           true\n'
        : '\n   dns.enable 保持 false（--no-dns），DNS 上游也不改动\n',
    )
  }

  if (missing.size > 0) {
    process.stdout.write('\n⚠️  以下 rules 目标在新骨架中不存在，已改指向「兜底分流」：\n')
    for (const [name, count] of [...missing].sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`     ${String(count).padStart(4)} 条 → 原目标 ${name}\n`)
    }
  }

  if (args.diff) {
    const summary = summarize(old, skeleton, subs, missing, directRules)
    process.stdout.write('\n=== 差异摘要 ===\n')
    process.stdout.write(`  proxies      ${summary.proxiesRemoved} 个内联节点 → 0（改由 provider 提供）\n`)
    process.stdout.write(`  providers    0 → ${summary.providersAdded}\n`)
    process.stdout.write(`  proxy-groups ${summary.groupsBefore} → ${summary.groupsAfter}\n`)
    if (summary.groupsDropped.length > 0) {
      process.stdout.write(`  删除的组     ${summary.groupsDropped.join(', ')}\n`)
    }
    if (summary.groupsAdded.length > 0) {
      process.stdout.write(`  新增的组     ${summary.groupsAdded.join(', ')}\n`)
    }
    process.stdout.write(
      `  rules        ${summary.rulesTotal} 条 = 原 ${(old.rules ?? []).length} 条 + 新增 ${summary.rulesAdded} 条订阅直连；其中 ${summary.rulesChanged} 条改写了目标组\n`,
    )
  }

  // ---- 校验（dry-run 也校验，让预览有意义）----
  process.stdout.write('\n=== 用 mihomo -t 校验生成结果 ===\n')
  const result = validate(yamlText)
  const lastLine = result.output.trim().split('\n').at(-1) ?? ''
  if (!result.ok) {
    process.stdout.write(`${result.output.trim()}\n`)
    fail('生成的配置未通过校验，已中止（未写入任何文件）')
  }
  process.stdout.write(`✅ ${lastLine}\n`)

  if (!args.apply) {
    process.stdout.write(
      `\n本次为预览模式，未写入任何文件。\n确认无误后执行：node scripts/migrate-config.mjs --apply\n`,
    )
    return
  }

  // ---- 写入 ----
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-')
  const backup = `${CONFIG_PATH}.bak.${stamp}`
  copyFileSync(CONFIG_PATH, backup)
  process.stdout.write(`\n已备份原配置 → ${backup}\n`)

  // provider 缓存目录必须存在，否则内核首次拉取会失败
  const providersDir = join(MIHOMO_DIR, 'providers')
  if (!existsSync(providersDir)) {
    mkdirSync(providersDir, { recursive: true })
    process.stdout.write(`已创建 provider 缓存目录 → ${providersDir}\n`)
  }

  writeFileSync(CONFIG_PATH, yamlText, 'utf8')
  process.stdout.write(`已写入 → ${CONFIG_PATH}\n`)

  // 写入后就地再校验一次（这次带真实的 ruleset 与 provider 目录），失败则回滚
  const after = validate(readFileSync(CONFIG_PATH, 'utf8'))
  if (!after.ok) {
    copyFileSync(backup, CONFIG_PATH)
    process.stderr.write(`${after.output.trim()}\n`)
    fail('写入后校验失败，已从备份回滚，配置未发生实际变化')
  }
  process.stdout.write('✅ 写入后校验通过\n')

  process.stdout.write(
    '\n下一步（本脚本不代管服务，请手动执行）：\n' +
      '  systemctl --user restart mihomo     # 让新骨架生效（首次必须重启，之后更新订阅无需重启）\n' +
      '  proxy_tui status                    # 确认 provider 已加载\n' +
      '  proxy_tui provider ls               # 查看三家订阅的节点数与流量\n' +
      `\n如需回滚：cp ${backup} ${CONFIG_PATH} && systemctl --user restart mihomo\n`,
  )
}

main()
