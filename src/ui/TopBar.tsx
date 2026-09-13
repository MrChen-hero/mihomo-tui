/**
 * 顶栏卡片条（App 外壳）：品牌标题嵌边框，左侧标签页胶囊、右侧模式与内核状态。
 * 纯展示组件 —— 键盘处理仍在 App（ui 层不碰输入与 API）。
 *
 * 左右分组间距用纯函数计算（topBarGap），不依赖 flex 布局的 space-between，
 * 保证任何终端下右侧状态都精确贴齐面板右缘。
 */
import { Box, Text } from 'ink'
import { Panel } from './Panel.js'
import { StatusDot } from './StatusDot.js'
import { colors, styles, type Tone } from './theme.js'
import { displayWidth } from '../commands/output.js'

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

/** 标签行的纯文本（宽度计算用）：选中 `❯ N 名`，非选中 `  N 名`，两空格分隔 */
export function tabRowText(tabs: readonly string[], active: number): string {
  return tabs
    .map((name, index) => (index === active ? `❯ ${index + 1} ${name}` : `  ${index + 1} ${name}`))
    .join('  ')
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

/** 标签均布（纯函数）：availWidth 均分成 count 格，标签在格内居中；
 * 格宽装不下最宽标签（含 1 列间隙）时返回 null，调用方回退紧凑布局。
 * 标签数量增减 → 格宽自动重算，未来顶栏扩展无需改渲染。 */
export function tabCells(
  tabs: readonly string[],
  active: number,
  availWidth: number,
): TabCell[] | null {
  const count = tabs.length
  if (count === 0) return null // 空标签表走紧凑回退，避免调用方除零
  const cellWidth = Math.floor(availWidth / count)
  const labelWidths = tabs.map((name, index) =>
    displayWidth(index === active ? `❯ ${index + 1} ${name}` : `${index + 1} ${name}`),
  )
  const minNeeded = Math.max(...labelWidths) + 1
  if (cellWidth < minNeeded) return null
  return tabs.map((name, index) => {
    const label = index === active ? `❯ ${index + 1} ${name}` : `${index + 1} ${name}`
    const labelWidth = labelWidths[index] ?? 0
    const pad = Math.max(0, cellWidth - labelWidth)
    const left = Math.floor(pad / 2)
    return {
      text: ' '.repeat(left) + label + ' '.repeat(pad - left),
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
  const innerWidth = Math.max(0, width - 4)
  const statusWidth = displayWidth(`${modeLabel} · ${apiPort} `) + 1 // StatusDot 占 1 列
  // 标签均布居中；格宽不足（极窄终端）回退紧凑布局
  const availWidth = Math.max(0, innerWidth - statusWidth)
  const cells = tabCells(tabs, active, availWidth)
  // 均分余数（每格 floor 后的剩余列）补在标签区与状态段之间
  const leftover = cells ? availWidth - Math.floor(availWidth / tabs.length) * tabs.length : 0
  const gap = topBarGap(tabs, active, modeLabel, apiPort, innerWidth)
  return (
    <Panel title="◆ mihomo-tui" width={width}>
      {cells ? (
        <Text>
          {cells.map((cell, index) => (
            <Text key={tabs[index] ?? index}>
              {cell.active ? (
                <Text {...styles.rowFocus} bold>{cell.text}</Text>
              ) : (
                <Text color={colors.muted}>{cell.text}</Text>
              )}
            </Text>
          ))}
          <Text>{' '.repeat(leftover)}</Text>
          <Text color={colors.muted}>{`${modeLabel} · ${apiPort} `}</Text>
          <StatusDot tone={statusTone} />
        </Text>
      ) : (
        <Text>
          {tabs.map((name, index) => (
            <Text key={name}>
              {index > 0 ? <Text color={colors.surfaceBorder}>{'  '}</Text> : null}
              {index === active ? (
                <Text {...styles.rowFocus} bold>{`❯ ${index + 1} ${name}`}</Text>
              ) : (
                <Text color={colors.muted}>{`  ${index + 1} ${name}`}</Text>
              )}
            </Text>
          ))}
          <Text>{' '.repeat(gap)}</Text>
          <Text color={colors.muted}>{`${modeLabel} · ${apiPort} `}</Text>
          <StatusDot tone={statusTone} />
        </Text>
      )}
    </Panel>
  )
}
