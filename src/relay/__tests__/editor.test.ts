/**
 * 代理链编辑模型测试：校验拒绝路径、成环三种情形、模板占位、骨架合并。
 */
import { describe, expect, it } from 'vitest'
import {
  applyRelayGroups,
  extractRelayGroups,
  relayCandidates,
  relayFromTemplate,
  validateRelay,
  type RelayGroup,
} from '../editor.js'

const group = (name: string, proxies: string[]): RelayGroup => ({ name, type: 'relay', proxies })

const CANDIDATES = ['节点A', '节点B', '节点C', '入口组']

describe('relayCandidates', () => {
  it('剔除保留名与组自身', () => {
    expect(relayCandidates(['节点A', 'DIRECT', 'REJECT', 'GLOBAL', '我的链'], '我的链')).toEqual(['节点A'])
  })
})

describe('validateRelay', () => {
  it('合法的两跳通过', () => {
    expect(validateRelay(group('落地', ['节点A', '节点B']), CANDIDATES).ok).toBe(true)
  })

  it('组名为空被拒', () => {
    expect(validateRelay(group('  ', ['节点A', '节点B']), CANDIDATES).error).toMatch(/组名不能为空/)
  })

  it('保留名作组名被拒', () => {
    expect(validateRelay(group('DIRECT', ['节点A', '节点B']), CANDIDATES).error).toMatch(/保留名/)
  })

  it('与已有代理组重名被拒', () => {
    const result = validateRelay(group('PROXY', ['节点A', '节点B']), CANDIDATES, [], ['PROXY'])
    expect(result.error).toMatch(/重名/)
  })

  it('少于两跳被拒', () => {
    expect(validateRelay(group('落地', ['节点A']), CANDIDATES).error).toMatch(/至少需要 2 跳/)
  })

  it('节点不在候选集被拒', () => {
    const result = validateRelay(group('落地', ['节点A', '不存在']), CANDIDATES)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/不存在/)
  })

  it('链内重复节点被拒', () => {
    expect(validateRelay(group('落地', ['节点A', '节点A']), CANDIDATES).error).toMatch(/重复/)
  })

  it('自环：一跳指向自身', () => {
    const self = group('落地', ['节点A', '落地'])
    const result = validateRelay(self, [...CANDIDATES, '落地'])
    expect(result.error).toMatch(/成环/)
  })

  it('两两互引成环', () => {
    const mine = group('链一', ['节点A', '链二'])
    const other = group('链二', ['节点B', '链一'])
    const result = validateRelay(mine, [...CANDIDATES, '链二'], [other])
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/链一 → 链二 → 链一/)
  })

  it('三层间接成环', () => {
    const mine = group('链一', ['节点A', '链二'])
    const others = [group('链二', ['节点B', '链三']), group('链三', ['节点C', '链一'])]
    const result = validateRelay(mine, [...CANDIDATES, '链二'], others)
    expect(result.error).toMatch(/成环：链一 → 链二 → 链三 → 链一/)
  })

  it('引用另一个不成环的 relay 组通过', () => {
    const mine = group('链一', ['节点A', '链二'])
    const other = group('链二', ['节点B', '节点C'])
    expect(validateRelay(mine, [...CANDIDATES, '链二'], [other]).ok).toBe(true)
  })
})

describe('relayFromTemplate', () => {
  it('落地中转给两跳占位，且占位通不过校验', () => {
    const relay = relayFromTemplate('落地', '落地中转')
    expect(relay.proxies).toHaveLength(2)
    expect(validateRelay(relay, CANDIDATES).ok).toBe(false)
  })

  it('多跳隐私给三跳占位', () => {
    expect(relayFromTemplate('隐私', '多跳隐私').proxies).toHaveLength(3)
  })
})

describe('applyRelayGroups / extractRelayGroups', () => {
  const groups = [
    { name: 'PROXY', type: 'select', proxies: ['AUTO'] },
    { name: '旧链', type: 'relay', proxies: ['节点A', '节点B'] },
  ]

  it('同名替换、新组追加，普通组不动', () => {
    const result = applyRelayGroups(groups, [
      group('旧链', ['节点B', '节点C']),
      group('新链', ['节点A', '节点C']),
    ])
    expect(result.map((g) => g.name)).toEqual(['PROXY', '旧链', '新链'])
    expect(result[1]?.proxies).toEqual(['节点B', '节点C'])
    expect(result[0]?.type).toBe('select')
  })

  it('从 proxy-groups 抽出 relay 组，跳过形态不合法的条目', () => {
    const extracted = extractRelayGroups([
      ...groups,
      { name: '坏链', type: 'relay', proxies: [1, 2] },
      { name: '缺字段', type: 'relay' },
      'not-a-group',
    ])
    expect(extracted).toEqual([group('旧链', ['节点A', '节点B'])])
  })

  it('非数组输入返回空', () => {
    expect(extractRelayGroups(undefined)).toEqual([])
  })
})
