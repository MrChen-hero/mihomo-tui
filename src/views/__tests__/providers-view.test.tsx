/**
 * [2] 订阅页（CP4）渲染契约：Panel 化、使用率条、到期语义色、danger 错误面板。
 * 增删改流程的集成测试在 providers-flows.test.tsx，这里只锁渲染。
 */
import { describe, expect, it, vi } from 'vitest'
import { ProvidersView, expireInfo, usageBar } from '../Providers.js'
import type { UseProvidersResult, ProviderRow } from '../../hooks/useProviders.js'
import type { AppConfig } from '../../config.js'
import type { ServiceDeps } from '../../config/subscriptionService.js'
import { createTerminal, delay, textOf } from '../../components/__tests__/harness.js'

const DAY = 86_400_000

const row = (over: Partial<ProviderRow> = {}): ProviderRow => ({
  name: 'jkun',
  type: 'HTTP',
  nodes: 110,
  alive: 96,
  remaining: 500 * 1024 ** 3,
  usage: { used: 500 * 1024 ** 3, total: 1000 * 1024 ** 3 },
  expire: undefined,
  updatedAt: undefined,
  updating: false,
  error: undefined,
  ...over,
})

function fakeProviders(rows: ProviderRow[]): UseProvidersResult {
  return {
    providers: rows,
    loading: false,
    error: undefined,
    refresh: vi.fn(),
    update: vi.fn(async () => {}),
    updateAll: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    nodesOf: () => [],
  }
}

const deps: ServiceDeps = {
  manager: {} as ServiceDeps['manager'],
  service: {} as ServiceDeps['service'],
  sleep: async () => {},
  graceMs: 0,
  subscriptionsPath: '/dev/null',
}

function mount(rows: ProviderRow[], width = 110) {
  return createTerminal(
    <ProvidersView
      providers={fakeProviders(rows)}
      height={24}
      width={width}
      tick={0}
      active
      onMessage={() => {}}
      config={{} as AppConfig}
      serviceDeps={deps}
    />,
    { columns: width },
  )
}

describe('expireInfo / usageBar 纯函数', () => {
  it('到期：未下发=长期；已过期=红；7 天内=黄；普通=灰字天数', () => {
    const now = 1_000_000_000_000
    expect(expireInfo(undefined, now)).toEqual({ text: '长期', tone: undefined })
    expect(expireInfo(now - DAY, now)).toEqual({ text: '已过期', tone: 'negative' })
    expect(expireInfo(now + 3 * DAY, now)).toEqual({ text: '3天', tone: 'caution' })
    expect(expireInfo(now + 7 * DAY, now)).toEqual({ text: '7天', tone: undefined })
    expect(expireInfo(now + 30 * DAY, now)).toEqual({ text: '30天', tone: undefined })
  })

  it('使用率条：无总量不渲染；剩余 <10% 转红；其余绿色', () => {
    expect(usageBar({ remaining: undefined })).toBeUndefined()
    expect(usageBar({ remaining: 99, usage: { used: 901, total: 1000 } })?.tone).toBe('negative')
    expect(usageBar({ remaining: 100, usage: { used: 900, total: 1000 } })?.tone).toBe('positive')
    expect(usageBar({ remaining: 500, usage: { used: 500, total: 1000 } })?.tone).toBe('positive')
    const half = usageBar({ remaining: 500, usage: { used: 500, total: 1000 } })
    expect(half?.text).toMatch(/^\[#{5,7}-+\]$/)
  })
})

describe('[2] 订阅页渲染', () => {
  it('全宽 Panel：标题含数量，表头与行渲染，使用率条出现', async () => {
    const term = mount([row(), row({ name: 'liangxin', remaining: 40 * 1024 ** 3, usage: { used: 960 * 1024 ** 3, total: 1000 * 1024 ** 3 } })])
    await delay()
    const text = textOf(term.frames())
    expect(text).toContain('╭─ 订阅 · 2')
    expect(text).toContain('NAME')
    expect(text).toContain('jkun')
    expect(text).toMatch(/\[#+-*\]/)
    term.instance.unmount()
  })

  it('到期与错误语义：error 行出现 danger 错误面板（⚠ 标题）', async () => {
    const term = mount([row({ error: 'dial tcp: connection refused', expire: Date.now() - DAY })])
    await delay()
    const text = textOf(term.frames())
    expect(text).toContain('⚠ jkun 更新失败')
    expect(text).toContain('connection refused')
    expect(text).toContain('已过期')
    // 色值本身由 pty 截屏（TERM=xterm-256color）人工验收；无头装置的 stdout
    // 会被 ink 降级到基础 16 色，断言具体 SGR 序列在装置里不成立。
    term.instance.unmount()
  })

  it('空订阅列表：标题 订阅 · 0 + 空态文案', async () => {
    const term = mount([])
    await delay()
    const text = textOf(term.frames())
    expect(text).toContain('订阅 · 0')
    expect(text).toContain('当前配置没有 proxy-providers')
    term.instance.unmount()
  })

  it('更新中行显示 spinner', async () => {
    const term = mount([row({ updating: true })])
    await delay()
    expect(textOf(term.frames())).toContain('更新中')
    term.instance.unmount()
  })
})
