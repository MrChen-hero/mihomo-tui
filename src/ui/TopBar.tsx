/**
 * 顶栏卡片条（App 外壳）：品牌标题嵌边框，左侧标签页胶囊、右侧模式与内核状态。
 * 纯展示组件 —— 键盘处理仍在 App（ui 层不碰输入与 API）。
 *
 * 左右分组间距用纯函数计算（topBarGap），不依赖 flex 布局的 space-between，
 * 保证任何终端下右侧状态都精确贴齐面板右缘。
 *
 * 响应式布局（2026-09-22 标准化美化）：
 * - Full（≥100列）：tab 均布居中，无数字，选中 accent 加粗
 * - Compact（72~99列）：tab 紧凑排布，无数字
 * - TooSmall（<72列）：显示降级提示
 */
import { Box, Text } from 'ink'
import { Panel } from './Panel.js'
import { StatusDot } from './StatusDot.js'
import { colors, styles, type Tone } from './theme.js'
import { displayWidth } from '../commands/output.js'
import { classifySize, type SizeClass } from './layout.js'

export interface TopBarProps {
  tabs: readonly string[]
  /** 当前选中标签下标 */
  active: number
  /** 模式显示名（如 规则/全局/直连），未知时为 ? */
  modeLabel: string
  apiPort: string
  /** 内核连接状态语义色 */
  statusTone: Tone
  width: number
}

/** 标签行的纯文本（宽度计算用）：选中加粗，无数字，2 空格分隔 */
export function tabRowText(tabs: readonly string[], active: number): string {
  return tabs.map((name, index) => (index === active ? name : name)).join('  ')
}

/** 右侧状态的纯文本（宽度计算用；● 按一列计） */
export function statusText(modeLabel: string, apiPort: string): string {
  return `${modeLabel} · ${apiPort} ●`
}

export interface TabCell {
  /** 恰好占满一格宽的文本（标签在格内居中） */
  text: string
  active: boolean
}

/** 单格宽度上限：宽终端封顶，标签块整体居中（spec 2026-09-13 dialogs-topbar-polish §3.3） */
export const TAB_CELL_CAP = 12

/** 标签均布（纯函数）：availWidth 均分成 count 格（封顶 TAB_CELL_CAP），标签在格内居中；
 * 格宽装不下最宽标签（含 2 列间隙）时返回 null，调用方回退紧凑布局。
 * 标签数量增减 → 格宽自动重算，未来顶栏扩展无需改渲染。
 * 2026-09-22：去掉数字，选中不加前缀箭头。 */
export function tabCells(
  tabs: readonly string[],
  active: number,
  availWidth: number,
): TabCell[] | null {
  const count = tabs.length
  if (count === 0) return null // 空标签表走紧凑回退，避免调用方除零
  const cellWidth = Math.min(Math.floor(availWidth / count), TAB_CELL_CAP)
  const labelWidths = tabs.map((name) => displayWidth(name))
  const minNeeded = Math.max(...labelWidths) + 2
  if (cellWidth < minNeeded) return null
  return tabs.map((name, index) => {
    const labelWidth = labelWidths[index] ?? 0
    const pad = Math.max(0, cellWidth - labelWidth)
    const left = Math.floor(pad / 2)
    return {
      text: ' '.repeat(left) + name + ' '.repeat(pad - left),
      active: index === active,
    }
  })
}

/** 左右分组之间的填充空格数（纯函数，至少 1） */
export function topBarGap(
  tabs: readonly string[],
  active: number,
  modeLabel: string,
  apiPort: string,
  innerWidth: number,
): number {
  const left = displayWidth(tabRowText(tabs, active))
  const right = displayWidth(statusText(modeLabel, apiPort))
  return Math.max(1, innerWidth - left - right)
}

export function TopBar({ tabs, active, modeLabel, apiPort, statusTone, width }: TopBarProps) {
  const sizeClass = classifySize(width)

  // TooSmall：显示降级提示
  if (sizeClass === 'TooSmall') {
    return (
      <Panel title="◆ mihomo-tui" width={width}>
        <Box flexDirection="column" alignItems="center" paddingY={1}>
          <Text color={colors.muted}>mihomo-tui 需要至少 72 列宽终端</Text>
          <Text color={colors.muted}>请调整窗口大小后继续</Text>
        </Box>
      </Panel>
    )
  }

  const innerWidth = Math.max(0, width - 4)
  const statusWidth = displayWidth(`${modeLabel} · ${apiPort} `) + 1 // StatusDot 占 1 列
  const availWidth = Math.max(0, innerWidth - statusWidth)
  const cells = sizeClass === 'Full' ? tabCells(tabs, active, availWidth) : null
  const gap = topBarGap(tabs, active, modeLabel, apiPort, innerWidth)

  // Full 布局：标签均布居中
  if (cells) {
    const cellWidth = displayWidth(cells[0]!.text)
    const extra = Math.max(0, availWidth - cellWidth * cells.length)
    const leftPad = Math.floor(extra / 2)
    const rightGap = extra - leftPad
    return (
      <Panel title="◆ mihomo-tui" width={width}>
        <Text>
          <Text>{' '.repeat(leftPad)}</Text>
          {cells.map((cell, index) => (
            <Text key={tabs[index] ?? index}>
              {cell.active ? (
                <Text {...styles.rowFocus} bold>
                  {cell.text}
                </Text>
              ) : (
                <Text color={colors.muted}>{cell.text}</Text>
              )}
            </Text>
          ))}
          <Text>{' '.repeat(rightGap)}</Text>
          <Text color={colors.muted}>{`${modeLabel} · ${apiPort} `}</Text>
          <StatusDot tone={statusTone} />
        </Text>
      </Panel>
    )
  }

  // Compact 布局：紧凑排布，2 空格分隔
  return (
    <Panel title="◆ mihomo-tui" width={width}>
      <Text>
        {tabs.map((name, index) => (
          <Text key={name}>
            {index > 0 ? <Text>{'  '}</Text> : null}
            {index === active ? (
              <Text {...styles.rowFocus} bold>
                {name}
              </Text>
            ) : (
              <Text color={colors.muted}>{name}</Text>
            )}
          </Text>
        ))}
        <Text>{' '.repeat(gap)}</Text>
        <Text color={colors.muted}>{`${modeLabel} · ${apiPort} `}</Text>
        <StatusDot tone={statusTone} />
      </Text>
    </Panel>
  )
}
