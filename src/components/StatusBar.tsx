/** 底部状态栏：内核版本、实时流量、内存、连接状态（配色全部来自 theme）。
 *
 * 响应式降级（2026-09-22 标准化美化）：
 * - Full（≥100列）：完整指标（版本、模式、瞬时、累计、内存、连接状态）
 * - Compact（72~99列）：精简指标（版本、模式、瞬时、连接状态；隐藏累计与内存）
 * - TooSmall（<72列）：不渲染状态栏（由 TopBar 显示降级提示）
 */
import { Box, Text, useStdout } from 'ink'
import { formatBytes } from '../commands/output.js'
import type { StreamState } from '../api/stream.js'
import { StatusChip } from '../ui/StatusDot.js'
import { colors, type Tone } from '../ui/theme.js'
import { classifySize } from '../ui/layout.js'

export interface StatusBarProps {
  version: string | undefined
  mode: string | undefined
  up: number
  down: number
  upTotal: number
  downTotal: number
  memory: number
  state: StreamState
  currentNode: string
}

/** 连接状态 → 语义四档：断开是故障（红），重连/连接中是注意（黄），已连接是健康（绿） */
export function stateTone(state: StreamState): Tone {
  switch (state) {
    case 'open':
      return 'positive'
    case 'reconnecting':
    case 'connecting':
      return 'caution'
    default:
      return 'negative'
  }
}

export function stateLabel(state: StreamState, nodeName: string): string {
  const nodeDisplay = nodeName ? `(${nodeName})` : ''
  switch (state) {
    case 'open':
      return `已连接${nodeDisplay}`
    case 'reconnecting':
      return '重连中'
    case 'closed':
      return '已断开'
    default:
      return '连接中'
  }
}

export function StatusBar(props: StatusBarProps) {
  const { stdout } = useStdout()
  const columns = stdout?.columns ?? 80
  const sizeClass = classifySize(columns)

  // TooSmall 时不渲染状态栏（TopBar 已显示降级提示）
  if (sizeClass === 'TooSmall') {
    return null
  }

  const showTotals = sizeClass === 'Full'
  const showMem = sizeClass === 'Full'
  const tone = stateTone(props.state)
  const modeNames: Record<string, string> = {
    rule: '规则',
    global: '全局',
    direct: '直连'
  }
  const modeDisplay = props.mode ? modeNames[props.mode] ?? props.mode : '?'

  return (
    <Box
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={colors.surfaceBorder}
      paddingX={1}
    >
      <Text>
        <Text color={colors.muted}>{`mihomo ${props.version ?? '?'} │ ${modeDisplay} │ `}</Text>
        {/* 瞬时速率是健康信号（绿）；累计量与内存是次要信息（灰，Compact 时隐藏） */}
        <Text color={colors.success}>↑{formatBytes(props.up)}/s</Text>
        <Text> </Text>
        <Text color={colors.success}>↓{formatBytes(props.down)}/s</Text>
        {showTotals ? (
          <Text color={colors.muted}>
            {` │ 总 ↑${formatBytes(props.upTotal)} ↓${formatBytes(props.downTotal)}`}
          </Text>
        ) : null}
        {showMem ? <Text color={colors.muted}>{` │ mem ${formatBytes(props.memory)}`}</Text> : null}
        <Text color={colors.muted}>{' │ '}</Text>
        <StatusChip tone={tone}>{stateLabel(props.state, sizeClass === 'Full' ? props.currentNode : '')}</StatusChip>
      </Text>
    </Box>
  )
}
