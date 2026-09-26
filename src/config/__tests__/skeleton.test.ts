import { describe, expect, it } from 'vitest'
import {
  DNS_UPSTREAM,
  EXCLUDE_FILTER,
  OTHERS_NAME,
  PURPOSE_GROUPS,
  REGIONS,
  buildGroups,
  buildProviders,
  buildSkeleton,
  rewriteRules,
  subscriptionDirectRules,
} from '../skeleton.js'
import type { Subscription } from '../types.js'

const ALPHA: Subscription = { name: 'alpha', type: 'remote', url: 'https://a.example.com/sub?token=aaa' }
const BETA: Subscription = { name: 'beta', type: 'remote', url: 'https://b.example.com/sub?token=bbb', prefix: '[B] ' }

/** 一个最小但合法的旧配置（字段类型混合，考验守卫） */
function oldConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'mixed-port': 17890,
    'allow-lan': false,
    ipv6: true,
    mode: 'rule',
    sniffer: { 'force-dns-mapping': true },
    dns: { enable: false, 'nameserver-policy': { 'claude.ai': '1.1.1.1' } },
    rules: ['DOMAIN-SUFFIX,example.com,DIRECT', 'MATCH,Yue.to | 悦通'],
    ...overrides,
  }
}

describe('subscriptionDirectRules 订阅直连规则', () => {
  it('提取主机名、去重、排序、固定 DIRECT', () => {
    const rules = subscriptionDirectRules([
      ALPHA,
      { name: 'beta2', type: 'remote', url: 'https://b.example.com/other?token=x' },
    ])
    expect(rules).toEqual(['DOMAIN,a.example.com,DIRECT', 'DOMAIN,b.example.com,DIRECT'])
  })

  it('非法 URL 被忽略而不是崩掉', () => {
    const rules = subscriptionDirectRules([{ name: 'bad', type: 'remote', url: 'not-a-url' }])
    expect(rules).toEqual([])
  })
})

describe('rewriteRules 规则改写', () => {
  it('改名组被同步替换，且只动目标字段', () => {
    const { rules } = rewriteRules(
      ['DOMAIN-SUFFIX,foo.com,Yue.to | 悦通', 'IP-CIDR,1.2.3.4/32,Yue.to | 悦通,no-resolve'],
      ['PROXY'],
    )
    expect(rules).toEqual(['DOMAIN-SUFFIX,foo.com,PROXY', 'IP-CIDR,1.2.3.4/32,PROXY,no-resolve'])
  })

  it('未知组改指向兜底分流并按组名计数', () => {
    const { rules, missing } = rewriteRules(
      ['DOMAIN,a.com,GhostA', 'DOMAIN,b.com,GhostA', 'DOMAIN,c.com,GhostB'],
      ['PROXY'],
    )
    expect(rules.every((rule) => rule.endsWith('兜底分流'))).toBe(true)
    expect(missing.get('GhostA')).toBe(2)
    expect(missing.get('GhostB')).toBe(1)
  })

  it('内置目标与已知组原样保留', () => {
    const input = ['DOMAIN,x.com,DIRECT', 'DOMAIN,y.com,REJECT', 'DOMAIN,z.com,PROXY']
    const { rules, missing } = rewriteRules(input, ['PROXY'])
    expect(rules).toEqual(input)
    expect(missing.size).toBe(0)
  })

  it('空目标字段的原规则不动', () => {
    const { rules } = rewriteRules(['AND,((DOMAIN,b.com)),'], ['PROXY'])
    expect(rules).toEqual(['AND,((DOMAIN,b.com)),'])
  })
})

describe('buildProviders', () => {
  it('单个 provider 的字段完整（path 相对、健康检查、过滤）', () => {
    const providers = buildProviders([BETA])
    expect(providers['beta']).toEqual({
      type: 'http',
      url: BETA.url,
      path: './providers/beta.yaml',
      interval: 0,
      'exclude-filter': EXCLUDE_FILTER,
      override: { 'additional-prefix': '[B] ' },
      'health-check': { enable: true, url: 'https://www.gstatic.com/generate_204', interval: 300, lazy: true },
    })
  })

  it('无前缀时不含 override', () => {
    const providers = buildProviders([ALPHA])
    expect(providers['alpha'] && 'override' in providers['alpha']).toBe(false)
  })

  it('自定义 testUrl 生效', () => {
    const providers = buildProviders([ALPHA], 'http://no/204')
    const health = (providers['alpha'] as Record<string, unknown>)['health-check'] as Record<string, unknown>
    expect(health.url).toBe('http://no/204')
  })

  it('interval 以分钟存储、按秒写入；缺省为 0（禁用自动更新）', () => {
    const providers = buildProviders([{ ...ALPHA, interval: 30 }])
    expect((providers['alpha'] as Record<string, unknown>).interval).toBe(1800)
  })

  it('本地订阅生成 file provider，不含 url', () => {
    const providers = buildProviders([{ name: 'mylocal', type: 'local' }])
    expect(providers['mylocal']).toMatchObject({ type: 'file', path: './providers/mylocal.yaml', interval: 0 })
    expect(providers['mylocal'] && 'url' in providers['mylocal']).toBe(false)
  })

  it('锁定的远程订阅改为 file provider 且 interval 为 0，防止拉取覆盖手改', () => {
    const providers = buildProviders([{ ...ALPHA, locked: true, interval: 60 }])
    const provider = providers['alpha'] as Record<string, unknown>
    expect(provider.type).toBe('file')
    expect(provider.interval).toBe(0)
    expect('url' in provider).toBe(false)
  })
})

describe('buildGroups', () => {
  const groups = buildGroups([ALPHA, BETA])
  const byName = new Map(groups.map((group) => [group.name, group]))

  it('组名覆盖：主组/自动/兜底/区域/其他/机场/用途', () => {
    expect(byName.get('PROXY')).toBeTruthy()
    expect(byName.get('AUTO')).toBeTruthy()
    expect(byName.get('FALLBACK')).toBeTruthy()
    for (const region of REGIONS) expect(byName.get(region.name)).toBeTruthy()
    expect(byName.get(OTHERS_NAME)).toBeTruthy()
    expect(byName.get('机场-alpha')).toBeTruthy()
    expect(byName.get('机场-beta')).toBeTruthy()
    for (const name of PURPOSE_GROUPS) expect(byName.get(name)).toBeTruthy()
  })

  it('主组成员按固定顺序拼接（幂等的来源之一）', () => {
    const proxies = byName.get('PROXY')?.proxies as string[]
    expect(proxies).toEqual([
      'AUTO',
      'FALLBACK',
      ...REGIONS.map((region) => region.name),
      OTHERS_NAME,
      '机场-alpha',
      '机场-beta',
      'DIRECT',
    ])
  })

  it('机场组用 use 引用 provider', () => {
    expect(byName.get('机场-alpha')?.use).toEqual(['alpha'])
  })

  it('区域组携带 Go RE2 过滤器', () => {
    expect(byName.get('香港')?.filter).toBe(REGIONS[0]?.filter)
  })

  it('游戏平台与兜底分流首选项是 DIRECT', () => {
    expect((byName.get('游戏平台')?.proxies as string[])[0]).toBe('DIRECT')
    expect((byName.get('兜底分流')?.proxies as string[])[0]).toBe('DIRECT')
    expect((byName.get('AI')?.proxies as string[])[0]).toBe('PROXY')
  })

  it('其他地区的排除过滤器合并了全部区域正则', () => {
    const expected = REGIONS.map((region) => region.filter.replace(/^\(\?i\)/, '')).join('|')
    expect(byName.get(OTHERS_NAME)?.['exclude-filter']).toBe(expected)
  })
})

describe('buildSkeleton 骨架组装', () => {
  it('保留旧配置的手工设置并生成 providers/groups/rules', () => {
    const { skeleton, warnings } = buildSkeleton(oldConfig(), [ALPHA, BETA])
    expect(skeleton['mixed-port']).toBe(17890)
    expect(skeleton['external-controller']).toBe('127.0.0.1:19090')
    expect(skeleton.sniffer).toEqual({ 'force-dns-mapping': true })
    expect(skeleton['rule-providers']).toBeUndefined()
    expect(Object.keys(skeleton['proxy-providers'] as object)).toEqual(['alpha', 'beta'])
    expect((skeleton.rules as string[])[0]).toBe('DOMAIN,a.example.com,DIRECT')
    expect((skeleton.rules as string[]).at(-1)).toBe('MATCH,PROXY')
    // 旧 dns.enable=false → 派生为关：dns 段原样保留（设置页关掉后不被翻回来）
    expect((skeleton.dns as Record<string, unknown>)['enable']).toBe(false)
    expect((skeleton.dns as Record<string, unknown>)['nameserver-policy']).toEqual({
      'claude.ai': '1.1.1.1',
    })
    expect(warnings.some((warning) => warning.includes('dns.enable'))).toBe(false)
  })

  it('dns.enable 派生：旧配置开着时上游仍被规范为实测可达地址', () => {
    const old = oldConfig({ dns: { enable: true, 'nameserver-policy': { 'x.com': '1.1.1.1' } } })
    const { skeleton, warnings } = buildSkeleton(old, [ALPHA])
    expect((skeleton.dns as Record<string, unknown>)['enable']).toBe(true)
    expect((skeleton.dns as Record<string, unknown>)['nameserver']).toEqual(DNS_UPSTREAM.nameserver)
    expect(warnings.some((warning) => warning.includes('dns.enable'))).toBe(false)
  })

  it('显式 enableDns:true 覆盖旧配置的关闭态（翻开并替换上游，产 dns 警告）', () => {
    const { skeleton, warnings } = buildSkeleton(oldConfig(), [ALPHA], { enableDns: true })
    expect((skeleton.dns as Record<string, unknown>)['enable']).toBe(true)
    expect((skeleton.dns as Record<string, unknown>)['nameserver']).toEqual(DNS_UPSTREAM.nameserver)
    expect(warnings.some((warning) => warning.includes('dns.enable'))).toBe(true)
  })

  it('直连规则置顶且不与旧规则重复', () => {
    const { skeleton } = buildSkeleton(
      oldConfig({ rules: ['DOMAIN,a.example.com,DIRECT', 'MATCH,PROXY'] }),
      [ALPHA],
    )
    const rules = skeleton.rules as string[]
    expect(rules.filter((rule) => rule === 'DOMAIN,a.example.com,DIRECT')).toHaveLength(1)
  })

  it('enableDns:false 保持 dns 原值且无 dns 警告', () => {
    const { skeleton, warnings } = buildSkeleton(oldConfig(), [ALPHA], { enableDns: false })
    expect((skeleton.dns as Record<string, unknown>)['enable']).toBe(false)
    expect(warnings.some((warning) => warning.includes('dns.enable'))).toBe(false)
  })

  it('旧配置没有 dns 段时创建默认 dns 块', () => {
    const old = oldConfig()
    delete (old as Record<string, unknown>).dns
    const { skeleton } = buildSkeleton(old, [ALPHA])
    expect((skeleton.dns as Record<string, unknown>)['enable']).toBe(true)
  })

  it('缺失组改指向兜底分流时产出 warning', () => {
    const { warnings } = buildSkeleton(
      oldConfig({ rules: ['DOMAIN,x.com,NoSuchGroup', 'MATCH,PROXY'] }),
      [ALPHA],
    )
    expect(warnings.some((warning) => warning.includes('NoSuchGroup'))).toBe(true)
  })

  it('孤儿直连规则剥离：删除订阅后其置顶 DIRECT 规则被移除（冒烟发现）', () => {
    const REMOVED = { name: 'removed', url: 'https://gone.example/sub?token=zzz' }
    const { skeleton } = buildSkeleton(
      oldConfig({
        rules: [
          'DOMAIN,gone.example,DIRECT', // 上一轮订阅遗留
          'DOMAIN,a.example.com,DIRECT',
          'DOMAIN,manual.example,DIRECT', // 手工添加的无关直连
          'MATCH,PROXY',
        ],
      }),
      [ALPHA],
      { previousSubscriptions: [REMOVED, ALPHA] },
    )
    const rules = skeleton.rules as string[]
    expect(rules).not.toContain('DOMAIN,gone.example,DIRECT')
    expect(rules).toContain('DOMAIN,manual.example,DIRECT')
    expect(rules[0]).toBe('DOMAIN,a.example.com,DIRECT')
  })

  it('旧配置字段类型不受信任：垃圾值回退默认', () => {
    const { skeleton } = buildSkeleton(
      { 'mixed-port': 'abc', mode: 42, ipv6: 'yes' },
      [ALPHA],
    )
    expect(skeleton['mixed-port']).toBe(17890)
    expect(skeleton.mode).toBe('rule')
    expect(skeleton.ipv6).toBe(true)
  })

  it('生成幂等：同输入两次结果逐字段一致', () => {
    const first = buildSkeleton(oldConfig(), [ALPHA, BETA])
    const second = buildSkeleton(oldConfig(), [ALPHA, BETA])
    expect(first).toEqual(second)
  })

  it('保留旧配置里的 relay 组，订阅事务重新生成后不丢', () => {
    const old = oldConfig({
      'proxy-groups': [
        { name: 'PROXY', type: 'select', proxies: ['AUTO'] },
        { name: '落地中转', type: 'relay', proxies: ['节点A', '节点B'], hidden: true, 'disable-udp': true },
        { name: '坏链', type: 'relay', proxies: [1, 2] },
      ],
    })
    const { skeleton } = buildSkeleton(old, [ALPHA])
    const groups = skeleton['proxy-groups'] as { name: string; type: string; proxies: string[] }[]
    const relay = groups.find((group) => group.name === '落地中转')
    expect(relay).toEqual({ name: '落地中转', type: 'relay', proxies: ['节点A', '节点B'], hidden: true, 'disable-udp': true })
    // 保留原字段，交给现有事务中的 mihomo -t 拒绝，不能通过静默删组使校验通过。
    expect(groups.find((group) => group.name === '坏链')).toEqual({ name: '坏链', type: 'relay', proxies: [1, 2] })
    // 骨架自己的组仍在
    expect(groups.some((group) => group.name === 'PROXY')).toBe(true)
  })

  it('没有 relay 组时行为不变', () => {
    const { skeleton } = buildSkeleton(oldConfig(), [ALPHA])
    const groups = skeleton['proxy-groups'] as { type: string }[]
    expect(groups.some((group) => group.type === 'relay')).toBe(false)
  })
})
