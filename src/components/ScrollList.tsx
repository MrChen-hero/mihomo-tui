/**
 * 可滚动列表。终端行数有限，几百个节点必须按视口裁剪，
 * 否则 Ink 会把整个列表都画出来把屏幕顶飞。
 */
import { Box, Text } from 'ink'
import type { ReactNode } from 'react'

export interface ScrollListProps<T> {
  items: T[]
  selected: number
  /** 视口可容纳的行数 */
  height: number
  renderItem: (item: T, index: number, isSelected: boolean) => ReactNode
  emptyText?: string
}

/** 计算视口起始下标，让选中项尽量居中，且不越界 */
export function windowStart(selected: number, total: number, height: number): number {
  if (total <= height) return 0
  const half = Math.floor(height / 2)
  return Math.max(0, Math.min(selected - half, total - height))
}

export function ScrollList<T>({
  items,
  selected,
  height,
  renderItem,
  emptyText = '（空）',
}: ScrollListProps<T>) {
  if (items.length === 0) {
    return (
      <Box>
        <Text dimColor>{emptyText}</Text>
      </Box>
    )
  }

  const rows = Math.max(1, height)
  const start = windowStart(selected, items.length, rows)
  const visible = items.slice(start, start + rows)

  return (
    <Box flexDirection="column">
      {visible.map((item, offset) => {
        const index = start + offset
        return (
          <Box key={index}>{renderItem(item, index, index === selected)}</Box>
        )
      })}
      {items.length > rows && (
        <Text dimColor>
          {`  ${start + 1}-${Math.min(start + rows, items.length)} / ${items.length}`}
        </Text>
      )}
    </Box>
  )
}
