/**
 * 状态灯与状态签：● 圆点 + 语义四档着色（theme.toneColor）。
 * 语义对齐 mihari statusdot：关闭/未知是合法中性态（灰），
 * 只有「该开没开/故障」才用红。
 */
import { Text } from 'ink'
import type { ReactNode } from 'react'
import { toneColor, type Tone } from './theme.js'

export function StatusDot({ tone }: { tone: Tone }) {
  return <Text color={toneColor[tone]}>●</Text>
}

export function StatusChip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Text>
      <Text color={toneColor[tone]}>● </Text>
      <Text color={toneColor[tone]}>{children}</Text>
    </Text>
  )
}
