/**
 * 通用列表选择对话框（设置页的日志级别 / 内核版本 / 下载源共用）。
 * 边框内嵌标题（Panel 同款顶线语言）+ 不可选的 dim 分组头 + ❯ 光标行。
 *
 * 键位：↑↓ 移动（自动跳过分组头）、Enter 选中、ESC 取消。
 * 条目超过 maxVisible 时按光标位置开窗，不折行不撑破布局。
 */
import { Box, Text, useInput } from 'ink'
import { FooterLine } from '../ui/FooterLine.js'
import { TOP_PREFIX, panelTopParts } from '../ui/Panel.js'
import { colors, styles } from '../ui/theme.js'
import { useKeyCapture } from '../ui/keyCapture.js'
import { displayWidth, padDisplay } from '../commands/output.js'
import { useRef, useState } from 'react'

export interface ListItem {
  /** 选中后 onSubmit 返回的值；分组头不设 */
  value?: string
  label: string
  /** 右侧 dim 提示（如 发布日期、「当前」、「已下载」） */
  hint?: string
  /** true 时渲染为不可选的分组头 */
  section?: boolean
}

export interface ListDialogProps {
  /** 内嵌边框标题（Panel 同款顶线语言） */
  borderTitle: string
  items: ListItem[]
  width?: number
  /** 可视行数上限，超过后按光标开窗（默认 12） */
  maxVisible?: number
  onSubmit: (value: string) => void
  onCancel: () => void
}

/** 纯函数：从任意下标出发，找到下一个可选条目（跳过分组头）；无则 null */
export function nextSelectable(items: ListItem[], from: number, step: 1 | -1): number | null {
  let index = from + step
  while (index >= 0 && index < items.length) {
    if (!items[index]!.section && items[index]!.value !== undefined) return index
    index += step
  }
  return null
}

/** 纯函数：窗口起始下标，保证 active 落在 [start, start + maxVisible) 内 */
export function windowStart(active: number, items: ListItem[], maxVisible: number): number {
  if (items.length <= maxVisible) return 0
  return Math.min(Math.max(0, active - Math.floor(maxVisible / 2)), items.length - maxVisible)
}

export function ListDialog({
  borderTitle,
  items,
  width = 56,
  maxVisible = 12,
  onSubmit,
  onCancel,
}: ListDialogProps) {
  const first = nextSelectable(items, -1, 1) ?? -1
  const [active, setActive] = useState(first)
  const activeRef = useRef(first)

  const move = (step: 1 | -1): void => {
    const next = nextSelectable(items, activeRef.current, step)
    if (next === null) return
    activeRef.current = next
    setActive(next)
  }

  // 对话框存活期间捕获全部按键：App 全局 handler（含 ESC 退出）一律让路
  useKeyCapture(true)
  useInput((_input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.upArrow) {
      move(-1)
      return
    }
    if (key.downArrow) {
      move(1)
      return
    }
    if (key.return) {
      const item = items[activeRef.current]
      if (item && !item.section && item.value !== undefined) onSubmit(item.value)
    }
  })

  const parts = panelTopParts(borderTitle, width)
  const innerWidth = Math.max(10, width - 4)
  const start = windowStart(Math.max(0, active), items, Math.max(1, maxVisible))
  const visible = items.slice(start, start + Math.max(1, maxVisible))
  return (
    <Box flexDirection="column" width={width}>
      <Text>
        <Text color={colors.accent}>{TOP_PREFIX}</Text>
        <Text {...styles.panelTitle}>{parts.title}</Text>
        <Text color={colors.accent}>{parts.tail}</Text>
      </Text>
      <Box flexDirection="column" borderStyle="round" borderTop={false} borderColor={colors.accent} paddingX={1}>
        {visible.map((item, offset) => {
          const index = start + offset
          if (item.section) {
            return (
              <Text key={`s-${item.label}`} dimColor>{`  ${item.label}`}</Text>
            )
          }
          const focused = index === active
          const hint = item.hint
          const hintWidth = hint ? displayWidth(hint) : 0
          const labelShown = hint
            ? padDisplay(item.label, Math.max(1, innerWidth - 2 - hintWidth - 1))
            : item.label
          return (
            <Text key={item.value ?? item.label} wrap="truncate-end">
              {focused ? (
                <Text {...styles.rowFocus} bold>{'❯ '}</Text>
              ) : (
                <Text>{'  '}</Text>
              )}
              <Text {...(focused ? styles.rowSelected : {})}>{labelShown}</Text>
              {hint ? <Text dimColor>{` ${hint}`}</Text> : null}
            </Text>
          )
        })}
        <Box marginTop={1}>
          <FooterLine
            hints={[
              { key: '↑↓', label: '选择' },
              { key: 'Enter', label: '确认' },
              { key: 'ESC', label: '取消' },
            ]}
            width={innerWidth}
          />
        </Box>
      </Box>
    </Box>
  )
}
