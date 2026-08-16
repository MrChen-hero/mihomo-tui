/**
 * 节点状态判定 —— 对应 SPEC 3.4 节的设计含义与 6.2 节的五状态表。
 * 关键：`lazy: true` 的组在被使用前 history 为空，「未测试」绝不能等同「不可用」。
 */
import type { DelayThresholds } from '../config.js'
import type { ProxyItem } from './types.js'

export type NodeStatus = 'good' | 'fair' | 'slow' | 'untested' | 'dead'

export interface NodeDelay {
  status: NodeStatus
  /** 有延迟值时为毫秒数，未测试或失败时为 undefined */
  delay: number | undefined
}

/**
 * 取节点最近一次延迟。
 * 优先用 extra[testUrl] 下的记录（同一节点在不同测速地址下有独立历史），
 * 无对应记录时回退到顶层 history。
 */
export function latestDelay(proxy: ProxyItem, testUrl?: string): number | undefined {
  const scoped = testUrl ? proxy.extra?.[testUrl]?.history : undefined
  const history = scoped && scoped.length > 0 ? scoped : proxy.history
  return history?.at(-1)?.delay
}

export function classify(
  proxy: ProxyItem,
  thresholds: DelayThresholds,
  testUrl?: string,
): NodeDelay {
  const delay = latestDelay(proxy, testUrl)
  // 从未测过：history 为空，与「测过但失败」是两件事
  if (delay === undefined) return { status: 'untested', delay: undefined }
  // 内核用 delay=0 表示该次测试失败
  if (delay <= 0) return { status: 'dead', delay: undefined }
  if (delay < thresholds.good) return { status: 'good', delay }
  if (delay < thresholds.fair) return { status: 'fair', delay }
  return { status: 'slow', delay }
}

/** 纯文本渲染（CLI 用）。TUI 里由 DelayBadge 负责着色 */
export function formatDelay(result: NodeDelay): string {
  switch (result.status) {
    case 'untested':
      return '---'
    case 'dead':
      return '错误'
    default:
      return `${result.delay}ms`
  }
}

export const STATUS_LABEL: Record<NodeStatus, string> = {
  good: '正常',
  fair: '一般',
  slow: '缓慢',
  untested: '未测试',
  dead: '错误',
}
