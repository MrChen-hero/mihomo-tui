/**
 * 进度对话框（设计稿 5.3）：步骤计数、百分比条、已完成步骤清单。
 * cancelable 时响应 ESC（仅在安全点提供——由调用方决定是否传入 onCancel）。
 */
import { Box, Text, useInput } from 'ink'
import { colors } from '../ui/theme.js'
import { useKeyCapture } from '../ui/keyCapture.js'

export interface ProgressDialogProps {
  title: string
  /** 当前正在执行的步骤文案 */
  current: string
  /** 总步数 */
  total: number
  /** 当前步骤下标（0 起） */
  step: number
  /** 已完成的步骤文案 */
  completed?: string[]
  cancelable?: boolean
  onCancel?: () => void
  width?: number
}

/** 纯函数：生成固定宽度的进度条，如 [#####-----]。
 * 用 ASCII 而非 █░：块元素属 East Asian Ambiguous 宽度，在 ambiguous=wide
 * 配置的真实终端下按 2 列渲染，一整条 10~20 字符的进度条会把行宽撑出
 * 面板导致折行（本机 pyte 工具链测不出，属真机终端风险，保守处理）。
 */
export function progressBar(fraction: number, width = 20): string {
  const clamped = Math.min(1, Math.max(0, fraction))
  const filled = Math.round(clamped * width)
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`
}

/** 纯函数：当前进度百分比（0–100），total 为 0 时按完成计 */
export function progressPercent(step: number, total: number): number {
  if (total <= 0) return 100
  return Math.min(100, Math.round((step / total) * 100))
}

export function ProgressDialog({
  title,
  current,
  total,
  step,
  completed = [],
  cancelable = false,
  onCancel,
  width = 56,
}: ProgressDialogProps) {
  useKeyCapture(true)
  useInput((_input, key) => {
    if (cancelable && key.escape) onCancel?.()
  })

  const percent = progressPercent(step, total)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1} width={width}>
      <Text bold>{` ${title}`}</Text>
      <Text>{` [${Math.min(step + 1, total)}/${total}] ${current}`}</Text>
      <Text color={colors.accent}>{` ${progressBar(percent / 100)} ${percent}%`}</Text>
      {completed.map((label) => (
        <Text key={label} color={colors.success}>{` ✓ ${label}`}</Text>
      ))}
      {cancelable ? <Text dimColor>{' ESC 取消'}</Text> : null}
    </Box>
  )
}
