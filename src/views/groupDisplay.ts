/**
 * 节点页左侧的分组展示（v0.3.0 §9）。
 *
 * 机场组（`机场-<订阅名>`）按订阅的 group 归拢，显示为 `分组名 - 订阅名`；
 * 只影响显示，选中与切换仍按组的真实 name 操作。
 */
import { AIRPORT_GROUP_PREFIX } from '../config/skeleton.js'
import type { Subscription } from '../config/types.js'
import type { GroupRow } from '../hooks/useProxies.js'

/** 没有分组的订阅归入此标签，并固定排在最后 */
export const UNGROUPED_LABEL = '未分组'

export interface DisplayRow {
  /** 组头行时为分组标签；组行时为组的真实 name */
  key: string
  /** 渲染文本 */
  label: string
  /** 组头行不可选中，只作分隔 */
  header: boolean
  /** 组行对应的真实代理组；组头行为 undefined */
  group: GroupRow | undefined
}

/**
 * 把代理组列表按订阅分组归拢成「组头 + 组行」的展示序列。
 * AUTO 固定排最前；有分组的按组名排序；未分组排最后。
 */
export function buildGroupDisplay(groups: GroupRow[], subs: Subscription[]): DisplayRow[] {
  const groupOf = new Map(subs.map((sub) => [sub.name, sub.group]))
  const auto = groups.filter((group) => group.name === 'AUTO')
  const airports = groups.filter((group) => group.name.startsWith(AIRPORT_GROUP_PREFIX))

  const buckets = new Map<string, GroupRow[]>()
  for (const group of airports) {
    const subName = group.name.slice(AIRPORT_GROUP_PREFIX.length)
    const label = groupOf.get(subName) ?? UNGROUPED_LABEL
    const bucket = buckets.get(label) ?? []
    bucket.push(group)
    buckets.set(label, bucket)
  }

  const labels = [...buckets.keys()].sort((a, b) => {
    if (a === UNGROUPED_LABEL) return 1
    if (b === UNGROUPED_LABEL) return -1
    return a.localeCompare(b)
  })

  const rows: DisplayRow[] = auto.map((group) => ({
    key: group.name,
    label: group.name,
    header: false,
    group,
  }))
  for (const label of labels) {
    rows.push({ key: `header:${label}`, label, header: true, group: undefined })
    for (const group of buckets.get(label) ?? []) {
      const subName = group.name.slice(AIRPORT_GROUP_PREFIX.length)
      rows.push({
        key: group.name,
        label: label === UNGROUPED_LABEL ? subName : `${label} - ${subName}`,
        header: false,
        group,
      })
    }
  }
  return rows
}
