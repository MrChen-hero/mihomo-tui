/** 底部状态栏：内核版本、模式、实时流量、内存、连接状态 */
import { Box, Text } from 'ink'
import { formatBytes } from '../commands/output.js'
import type { StreamState } from '../api/stream.js'

export interface StatusBarProps {
  version: string | undefined
  mode: string | undefined
  port: number | undefined
  up: number
  down: number
  upTotal: number
  downTotal: number
  memory: number
  state: StreamState
  apiPort: string
  currentNode: string
}

function stateLabel(state: StreamState, nodeName: string): { text: string; color: string } {
  const nodeDisplay = nodeName ? `(${nodeName})` : ''
  switch (state) {
    case 'open':
      return { text: `● 已连接${nodeDisplay}`, color: 'green' }
    case 'reconnecting':
      return { text: '● 重连中', color: 'yellow' }
    case 'closed':
      return { text: '● 已断开', color: 'red' }
    default:
      return { text: '● 连接中', color: 'yellow' }
  }
}

export function StatusBar(props: StatusBarProps) {
  const status = stateLabel(props.state, props.currentNode)
  const modeNames: Record<string, string> = {
    rule: '规则',
    global: '全局',
    direct: '直连'
  }
  const modeDisplay = props.mode ? modeNames[props.mode] ?? props.mode : '?'
  return (
    <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
      <Text>
        <Text bold>mihomo {props.version ?? '?'}</Text>
        <Text dimColor> │ </Text>
        <Text>{modeDisplay}</Text>
        <Text dimColor> │ </Text>
        {/* 瞬时速率用箭头，累计量放括号里，一行内看清当下与总量 */}
        <Text color="cyan">↑{formatBytes(props.up)}/s</Text>
        <Text> </Text>
        <Text color="magenta">↓{formatBytes(props.down)}/s</Text>
        <Text dimColor> │ </Text>
        <Text dimColor>
          总 ↑{formatBytes(props.upTotal)} ↓{formatBytes(props.downTotal)}
        </Text>
        <Text dimColor> │ </Text>
        <Text>mem {formatBytes(props.memory)}</Text>
        <Text dimColor> │ </Text>
        <Text>{props.apiPort} </Text>
        <Text color={status.color}>{status.text}</Text>
      </Text>
    </Box>
  )
}
