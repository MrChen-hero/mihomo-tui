import { describe, expect, it } from 'vitest'
import { AIRPORT_GROUP_PREFIX } from '../../config/skeleton.js'
import type { Subscription } from '../../config/types.js'
import type { GroupRow } from '../../hooks/useProxies.js'
import { UNGROUPED_LABEL, buildGroupDisplay } from '../groupDisplay.js'

function group(name: string): GroupRow {
  return { name, type: 'select', now: '', fixed: '', size: 1, nodeCount: 1, aliveCount: 1 }
}

const SUBS: Subscription[] = [
  { name: 'yuetoto', type: 'remote', url: 'https://a.example/s', group: '香港专线' },
  { name: 'ax-hk', type: 'remote', url: 'https://b.example/s', group: '香港专线' },
  { name: 'backup', type: 'remote', url: 'https://c.example/s' },
]

describe('buildGroupDisplay 分组展示', () => {
  const rows = buildGroupDisplay(
    [
      group('AUTO'),
      group(`${AIRPORT_GROUP_PREFIX}backup`),
      group(`${AIRPORT_GROUP_PREFIX}ax-hk`),
      group(`${AIRPORT_GROUP_PREFIX}yuetoto`),
    ],
    SUBS,
  )

  it('AUTO 排最前，随后按分组归拢，未分组在最后', () => {
    expect(rows.map((row) => row.label)).toEqual([
      'AUTO',
      '香港专线',
      '香港专线 - ax-hk',
      '香港专线 - yuetoto',
      UNGROUPED_LABEL,
      'backup',
    ])
  })

  it('组头行不可选，组行携带真实代理组', () => {
    const header = rows.find((row) => row.label === '香港专线')
    expect(header?.header).toBe(true)
    expect(header?.group).toBeUndefined()
    const item = rows.find((row) => row.label === '香港专线 - yuetoto')
    expect(item?.header).toBe(false)
    expect(item?.group?.name).toBe(`${AIRPORT_GROUP_PREFIX}yuetoto`)
  })

  it('组内按订阅名排序', () => {
    const labels = rows.filter((row) => row.label.startsWith('香港专线 -')).map((row) => row.label)
    expect(labels).toEqual(['香港专线 - ax-hk', '香港专线 - yuetoto'])
  })
})
