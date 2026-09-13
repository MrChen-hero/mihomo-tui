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
  const gap = topBarGap(tabs, active, modeLabel, apiPort, Math.max(0, width - 4))
  return (
    <Panel title="◆ mihomo-tui" width={width}>
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
    </Panel>
  )
}
