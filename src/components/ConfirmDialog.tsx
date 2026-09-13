/**
 * 确认对话框（设计稿 5.2）。y/Y 确认，n/N/ESC 取消；
 * danger 模式整体红色，用于不可撤销的删除类操作。
 */
import { Box, Text, useInput } from 'ink'
import { colors } from '../ui/theme.js'
import { useKeyCapture } from '../ui/keyCapture.js'

export interface ConfirmDialogProps {
  title: string
  /** 单段或多行说明 */
  message: string | string[]
  danger?: boolean
  width?: number
  /** Enter 也确认；默认关——删除类确认保持 y 显式确认，退出确认用 */
  enterConfirms?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  danger = false,
  width = 56,
  enterConfirms = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useKeyCapture(true)
  useInput((input, key) => {
    if (key.escape || input === 'n' || input === 'N') {
      onCancel()
      return
    }
    if (input === 'y' || input === 'Y' || (enterConfirms && key.return)) {
      onConfirm()
    }
  })

  const lines = Array.isArray(message) ? message : [message]
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={danger ? colors.danger : colors.accent}
      paddingX={1}
      width={width}
    >
      <Text>
        <Text bold color={danger ? colors.danger : colors.accent}>{`${danger ? '⚠' : '◆'} `}</Text>
        <Text bold color={danger ? colors.danger : undefined}>{title}</Text>
      </Text>
      {lines.map((line, index) => (
        <Text key={index} color={danger ? colors.danger : undefined}>
          {` ${line}`}
        </Text>
      ))}
      <Text>
        <Text bold color={danger ? colors.danger : colors.success}>
          {enterConfirms ? 'Enter/y' : 'y'}
        </Text>
        <Text dimColor>{' 确认  '}</Text>
        <Text bold>{'n'}</Text>
        <Text dimColor>{'/Esc 取消'}</Text>
      </Text>
    </Box>
  )
}
