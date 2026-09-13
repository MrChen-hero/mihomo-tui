/**
 * 确认对话框（设计稿 5.2）。y/Y 确认，n/N/ESC 取消；
 * danger 模式整体红色，用于不可撤销的删除类操作。
 */
import { Box, Text, useInput } from 'ink'

export interface ConfirmDialogProps {
  title: string
  /** 单段或多行说明 */
  message: string | string[]
  danger?: boolean
  width?: number
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  danger = false,
  width = 56,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useInput((input, key) => {
    if (key.escape || input === 'n' || input === 'N') {
      onCancel()
      return
    }
    if (input === 'y' || input === 'Y') {
      onConfirm()
    }
  })

  const lines = Array.isArray(message) ? message : [message]
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={danger ? 'red' : 'cyan'}
      paddingX={1}
      width={width}
    >
      <Text>
        <Text bold color={danger ? 'red' : 'cyan'}>{`${danger ? '⚠' : '◆'} `}</Text>
        <Text bold color={danger ? 'red' : undefined}>{title}</Text>
      </Text>
      {lines.map((line, index) => (
        <Text key={index} color={danger ? 'red' : undefined}>
          {` ${line}`}
        </Text>
      ))}
      <Text>
        <Text bold color={danger ? 'red' : 'green'}>{'y'}</Text>
        <Text dimColor>{' 确认  '}</Text>
        <Text bold>{'n'}</Text>
        <Text dimColor>{'/Esc 取消'}</Text>
      </Text>
    </Box>
  )
}
