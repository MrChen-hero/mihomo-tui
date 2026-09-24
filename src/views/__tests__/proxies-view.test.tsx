/**
 * [1] 节点页（CP3）：双栏 Panel 化与 ▌/❯/● 行标记的测试。
 * 键位行为不归本文件管（useInput 分支零改动），这里只锁渲染契约。
 */
import { describe, expect, it } from 'vitest'
import { ProxiesView, nodePanelTitle, rowBar, rowBarColor } from '../Proxies.js'
import { createTerminal, delay, textOf } from '../../components/__tests__/harness.js'
import { colors } from '../../ui/theme.js'
import type { GroupRow, NodeRow, UseProxiesResult } from '../../hooks/useProxies.js'
import type { ProxyItem } from '../../api/types.js'

const group = (name: string, now: string, nodeCount = 3, aliveCount = 3): GroupRow => ({
  name,
  type: 'Selector',
  now,
  fixed: '',
  size: nodeCount,
  nodeCount,
  aliveCount,
})

const node = (name: string, current: boolean, status: NodeRow['status'] = 'good'): NodeRow => ({
  name,
  type: 'Vless',
  provider: 'p',
  status,
  delay: status === 'good' ? 57 : undefined,
  current,
  testing: false,
})

function mockProxies(): UseProxiesResult {
  return {
    groups: [group('AUTO', '香港01', 2, 2), group('机场-x', '日本01')],
    nodesOf: (g: string) =>
      g === 'AUTO'
        ? [node('香港01', true), node('日本01', false, 'untested')]
        : [node('美国01', false)],
    loading: false,
    error: undefined,
    refresh: () => {},
    select: async () => {},
    unfix: async () => {},
    testGroup: async () => {},
    testNode: async () => {},
    testingGroup: undefined,
    progress: undefined,
    currentNode: '香港01',
    findRegionAndSelect: async () => null,
    rawProxies: {
      PROXY: {
        name: 'PROXY',
        type: 'Selector',
        alive: true,
        history: [],
        now: 'AUTO',
        all: ['AUTO', '机场-x'],
      } as unknown as ProxyItem,
    },
  }
}

function mount(width: number, proxies = mockProxies()) {
  const term = createTerminal(
    <ProxiesView
      proxies={proxies}
      height={24}
      width={width}
      tick={0}
      active
      onMessage={() => {}}
    />,
    { columns: width },
  )
  return term
}

describe('rowBar / nodePanelTitle 纯函数', () => {
  it('rowBar：▌=焦点行、❯=驻留光标、空格=普通行', () => {
    expect(rowBar(true, true)).toBe('▌')
    expect(rowBar(true, false)).toBe('❯')
    expect(rowBar(false, true)).toBe(' ')
    expect(rowBar(false, false)).toBe(' ')
  })

  it('rowBarColor：焦点行 accent、驻留光标 muted、普通行无色', () => {
    expect(rowBarColor(true, true)).toBe(colors.accent)
    expect(rowBarColor(true, false)).toBe(colors.muted)
    expect(rowBarColor(false, true)).toBeUndefined()
  })

  it('nodePanelTitle：按 spec 样稿组合过滤/钉选/计数', () => {
    expect(
      nodePanelTitle({
        groupName: 'AUTO',
        onlyAlive: false,
        sortByDelay: true,
        fixed: false,
        aliveCount: 190,
        nodeCount: 228,
        testing: undefined,
        tick: 0,
      }),
    ).toBe('节点 · AUTO [按延迟] 190/228 可用')
    expect(
      nodePanelTitle({
        groupName: '机场-jkun',
        onlyAlive: true,
        sortByDelay: false,
        fixed: true,
        aliveCount: 9,
        nodeCount: 11,
        testing: { done: 3, total: 11 },
        tick: 0,
      }),
    ).toBe('节点 · 机场-jkun [只看可用] [已钉选] 9/11 可用 ⠋ 测速 3/11')
  })

  it('nodePanelTitle：无组时占位 —', () => {
    expect(
      nodePanelTitle({
        groupName: undefined,
        onlyAlive: false,
        sortByDelay: false,
        fixed: false,
        aliveCount: 0,
        nodeCount: 0,
        testing: undefined,
        tick: 0,
      }),
    ).toBe('节点 · —')
  })
})

describe('[1] 节点页渲染', () => {
  it('宽屏：双栏 Panel 顶线齐全，焦点行 ▌、驻留行 ❯、在用行 ●', async () => {
    const term = mount(110)
    await delay()
    const text = textOf(term.frames())
    expect(text).toContain('╭─ 代理组')
    expect(text).toContain('╭─ 节点 · AUTO [按延迟] 2/2 可用')
    // 初始焦点在组栏：组光标 ▌（AUTO 同时被 PROXY 选中，● 同行出现）；节点栏光标驻留 ❯
    expect(text).toContain('▌● AUTO')
    expect(text).toContain('❯● 香港01')
    // 业务选中：在用节点标 ●；普通行不带任何标记
    expect(text).toContain('  日本01')
    term.instance.unmount()
  })

  it('←→ 切栏后 ▌ 与 ❯ 互换', async () => {
    const term = mount(110)
    await delay()
    term.press('l')
    await delay()
    const text = textOf(term.frames())
    expect(text).toContain('❯● AUTO')
    expect(text).toContain('▌● 香港01')
    term.instance.unmount()
  })

  it('j 下移后焦点条跟随到第二个组', async () => {
    const term = mount(110)
    await delay()
    term.press('j')
    await delay()
    const text = textOf(term.frames())
    expect(text).toContain('▌  x')
    term.instance.unmount()
  })

  it('窄屏（<100 列）单栏降级：只渲染焦点面板', async () => {
    const term = mount(80)
    await delay()
    const text = textOf(term.frames())
    expect(text).toContain('╭─ 代理组')
    expect(text).not.toContain('节点 ·')
    term.instance.unmount()
  })

  it('页脚用 FooterLine：键帽提示渲染且保底最后一段', async () => {
    const term = mount(110)
    await delay()
    const text = textOf(term.frames())
    expect(text).toContain('↑↓ 移动')
    expect(text).toContain('r 刷新')
    term.instance.unmount()
  })

  it('rawProxies 无 PROXY 键时不崩，组行正常渲染', async () => {
    const p = mockProxies()
    p.rawProxies = {}
    const term = mount(110, p)
    await delay()
    const text = textOf(term.frames())
    expect(text).toContain('╭─ 代理组')
    expect(text).toContain('AUTO')
    term.instance.unmount()
  })

  it('组列表为空：双面板空态文案 + 标题占位 —', async () => {
    const p = mockProxies()
    p.groups = []
    const term = mount(110, p)
    await delay()
    const text = textOf(term.frames())
    expect(text).toContain('无可用代理组')
    expect(text).toContain('请先选择代理组')
    expect(text).toContain('节点 · —')
    term.instance.unmount()
  })
})
