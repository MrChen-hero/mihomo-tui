/**
 * 代理链（relay）编辑模型：纯函数，不读不写文件。
 *
 * relay 组是 mihomo proxy-groups 里 type: relay 的条目，流量按 proxies 顺序
 * 逐跳转发。每一跳必须是当前内核已加载的代理（节点或其他组），本模块不产生新节点。
 */
import type { ParsedYaml } from '../config/types.js'

/** mihomo 内置保留名，不能作为一跳，也不能做组名 */
export const RESERVED_NAMES = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']

export interface RelayGroup {
  name: string
  type: 'relay'
  proxies: string[]
}

export interface RelayValidation {
  ok: boolean
  /** 面向用户的错误文案；ok 时为空串 */
  error: string
}

/** 从内核代理列表里剔除保留名与 relay 组自身，得到可选的一跳 */
export function relayCandidates(proxyNames: string[], selfName?: string): string[] {
  const reserved = new Set(RESERVED_NAMES)
  return proxyNames.filter((name) => !reserved.has(name) && name !== selfName)
}

/**
 * 校验一条 relay 定义。
 * existingRelays 是配置里已有的其他 relay 组（不含正在编辑的这条），用于传递成环检测。
 */
export function validateRelay(
  group: RelayGroup,
  candidates: string[],
  existingRelays: RelayGroup[] = [],
  existingGroupNames: string[] = [],
): RelayValidation {
  const name = group.name.trim()
  if (!name) return fail('组名不能为空')
  if (RESERVED_NAMES.includes(name)) return fail(`组名 ${name} 是保留名`)
  if (existingGroupNames.includes(name)) return fail(`组名 ${name} 与已有代理组重名`)

  // 空链是「新建后进入编辑器」的中间态：允许落盘，编辑器里再补跳
  if (group.proxies.length === 0) return { ok: true, error: '' }

  if (group.proxies.length < 2) return fail('代理链至少需要 2 跳')

  const seen = new Set<string>()
  for (const hop of group.proxies) {
    if (!candidates.includes(hop)) return fail(`节点 ${hop} 不存在于当前代理列表`)
    if (seen.has(hop)) return fail(`节点 ${hop} 在链中重复`)
    seen.add(hop)
  }

  const cycle = findCycle(group, existingRelays)
  if (cycle) return fail(`代理链成环：${cycle.join(' → ')}`)

  return { ok: true, error: '' }
}

function fail(error: string): RelayValidation {
  return { ok: false, error }
}

/**
 * 传递成环：从本组出发，沿「一跳指向另一个 relay 组」走，回到已访问的组即成环。
 * 返回成环路径（含回到的起点），无环返回 undefined。
 */
function findCycle(group: RelayGroup, existingRelays: RelayGroup[]): string[] | undefined {
  const byName = new Map<string, RelayGroup>([[group.name, group]])
  for (const relay of existingRelays) byName.set(relay.name, relay)

  const stack: string[] = []
  const visit = (name: string): string[] | undefined => {
    if (stack.includes(name)) return [...stack, name]
    const relay = byName.get(name)
    if (!relay) return undefined
    stack.push(name)
    for (const hop of relay.proxies) {
      const found = visit(hop)
      if (found) return found
    }
    stack.pop()
    return undefined
  }
  return visit(group.name)
}

/** 场景模板：只给跳数占位，每一跳需用户从候选里选定后才能通过校验 */
export type RelayTemplate = '落地中转' | '多跳隐私'

export const RELAY_TEMPLATES: Record<RelayTemplate, number> = {
  落地中转: 2,
  多跳隐私: 3,
}

/** 产出未填的占位链；占位符不在候选集内，提交前会被校验拦住 */
export function relayFromTemplate(name: string, template: RelayTemplate): RelayGroup {
  const count = RELAY_TEMPLATES[template]
  return {
    name,
    type: 'relay',
    proxies: Array.from({ length: count }, (_v, i) => `（未选第 ${i + 1} 跳）`),
  }
}

/**
 * 把 relay 组写进骨架的 proxy-groups。
 * 同名条目替换，新组追加到末尾；非 relay 组一律不动。
 */
export function applyRelayGroups(
  groups: Record<string, unknown>[],
  relays: RelayGroup[],
): Record<string, unknown>[] {
  const relayNames = new Set(relays.map((relay) => relay.name))
  const kept = groups.filter((group) => !relayNames.has(String(group['name'])))
  return [...kept, ...relays.map((relay) => ({ ...relay }))]
}

/** 从一段 proxy-groups（ParsedYaml 形态）里抽出 type 为 relay 的组 */
export function extractRelayGroups(groups: unknown): RelayGroup[] {
  if (!Array.isArray(groups)) return []
  const relays: RelayGroup[] = []
  for (const group of groups) {
    if (!isRecord(group) || group['type'] !== 'relay') continue
    const name = group['name']
    const proxies = group['proxies']
    if (typeof name !== 'string' || !Array.isArray(proxies)) continue
    if (!proxies.every((hop): hop is string => typeof hop === 'string')) continue
    relays.push({ name, type: 'relay', proxies })
  }
  return relays
}

function isRecord(value: unknown): value is ParsedYaml {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
