/** 延迟着色标签。五状态对应 SPEC 6.2 的表格。 */
import { Text } from 'ink'
import { colors } from '../ui/theme.js'
import type { NodeStatus } from '../api/status.js'

export interface DelayBadgeProps {
  status: NodeStatus
  delay: number | undefined
  testing?: boolean
  /** 右对齐到指定宽度，便于列表对齐 */
  width?: number
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function spinnerFrame(tick: number): string {
  return SPINNER[tick % SPINNER.length] ?? SPINNER[0]!
}

export function DelayBadge({ status, delay, testing, width = 7 }: DelayBadgeProps) {
  if (testing) {
    return (
      <Text color={colors.info}>{'测速中'.padStart(width)}</Text>
    )
  }
  switch (status) {
    case 'good':
      return <Text color={colors.success}>{`${delay}ms`.padStart(width)}</Text>
    case 'fair':
      return <Text color={colors.warning}>{`${delay}ms`.padStart(width)}</Text>
    case 'slow':
      return <Text color={colors.danger}>{`${delay}ms`.padStart(width)}</Text>
    case 'dead':
      return <Text color={colors.danger}>{'超时'.padStart(width - 2)}</Text>
    default:
      // 未测试 ≠ 不可用：lazy 组在被使用前 history 恒为空（SPEC 3.4）
      return <Text dimColor>{'---'.padStart(width)}</Text>
  }
}
