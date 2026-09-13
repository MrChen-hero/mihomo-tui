/**
 * 内嵌标题边框面板：标题嵌在顶边框线上（╭─ 标题 ───╮），
 * 正文 Box 关闭顶边（borderTop={false}），左右底边与标题线无缝衔接。
 * 视觉参照 cc-switch / mihari 的卡片语言。
 *
 * 窄于 MIN_PANEL_WIDTH 时退化为无边框（标题行 + 裸内容），避免边框错位。
 * 标题按显示宽度（CJK 占两列）计算补齐，禁止 slice 猜边界。
 */
import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { colors, styles } from './theme.js'
import { displayWidth, truncateDisplay } from '../commands/output.js'

export const MIN_PANEL_WIDTH = 20

const TOP_PREFIX = '╭─ '
/** 尾段 = 「 」空格 + 横线 ×N + 末角 ╮；横线数见 panelTopTail */
const TAIL_FIXED = 2

/** 标题与尾段：标题显示宽超预算时按显示宽截断（…结尾），保证顶线不超 width（纯函数） */
export function panelTopParts(title: string, width: number): { title: string; tail: string } {
  if (width < MIN_PANEL_WIDTH) {
    return { title, tail: '╮' }
  }
  // 预算 = width - 前缀 - 尾段固定列（空格+╮），再留 1 列横线
  const availTitle = width - displayWidth(TOP_PREFIX) - TAIL_FIXED - 1
  const shown = displayWidth(title) > availTitle ? truncateDisplay(title, availTitle) : title
  const dashes = Math.max(1, width - displayWidth(TOP_PREFIX) - displayWidth(shown) - TAIL_FIXED)
  return { title: shown, tail: ' ' + '─'.repeat(dashes) + '╮' }
}

/** 整条顶边框行（纯函数，测试与调试用） */
export function panelTopLine(title: string, width: number): string {
  if (width < MIN_PANEL_WIDTH) {
    return '╭' + '─'.repeat(Math.max(0, width - 2)) + '╮'
  }
  const parts = panelTopParts(title, width)
  return TOP_PREFIX + parts.title + parts.tail
}

export interface PanelProps {
  title: string
  /** 面板总宽度（列），含边框 */
  width: number
  /** danger：边框与标题转正红并加 ⚠ 前缀（错误盒语义） */
  danger?: boolean
  /** fillHeight：内层边框盒纵向撑满父容器（双栏并排时底边齐平用） */
  fillHeight?: boolean
  children: ReactNode
}

export function Panel({ title, width, danger, fillHeight, children }: PanelProps) {
  // danger：边框与标题转正红并加 ⚠ 前缀（错误盒语义）；普通态维持 accent 标题
  const titleStyle = danger ? { color: colors.danger, bold: true } : styles.panelTitle
  const shownTitle = danger ? `⚠ ${title}` : title
  if (width < MIN_PANEL_WIDTH) {
    return (
      <Box flexDirection="column">
        <Text {...titleStyle}>{shownTitle}</Text>
        {children}
      </Box>
    )
  }
  const parts = panelTopParts(shownTitle, width)
  return (
    <Box flexDirection="column" width={width}>
      <Text>
        <Text color={colors.surfaceBorder}>{TOP_PREFIX}</Text>
        <Text {...titleStyle}>{parts.title}</Text>
        <Text color={colors.surfaceBorder}>{parts.tail}</Text>
      </Text>
      {/* ink 的 Box 默认 flexDirection=row，多子元素会被并排压缩换行——
          面板内容必须显式纵向堆叠 */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderTop={false}
        borderColor={danger ? colors.danger : colors.surfaceBorder}
        paddingX={1}
        flexGrow={fillHeight ? 1 : undefined}
      >
        {children}
      </Box>
    </Box>
  )
}
