/**
 * 确认对话框（cc-switch 确认卡片语言，spec 2026-09-13 dialogs-topbar-polish §3.1）。
 * 键帽反色块顶部居中、问题文案居中于中下部、上下大留白；无标题行——问题文案即内容。
 * y/Y 确认，n/N/ESC 取消；danger 模式红色边框与文案，用于不可撤销的删除类操作。
 */
import { Box, Text, useInput } from 'ink'
import { colors } from '../ui/theme.js'
import { useKeyCapture } from '../ui/keyCapture.js'

export interface ConfirmDialogProps {
  /** 单段或多行说明：首行主文案（默认色），后续行 dim */
  message: string | string[]
  danger?: boolean
  width?: number
  /** Enter 也确认；默认关——删除类确认保持 y 显式确认，退出确认用 */
  enterConfirms?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
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
      alignItems="center"
      borderStyle="round"
      borderColor={danger ? colors.danger : colors.accent}
      paddingX={1}
      paddingY={2}
      width={width}
    >
      {/* 键帽行：中性 inverse 块（不引入色相），块间两空格正常底色 */}
      <Text>
        <Text inverse>{enterConfirms ? 'Enter 确认' : 'y 确认'}</Text>
        <Text>{'  '}</Text>
        <Text inverse>{enterConfirms ? 'Esc 取消' : 'n/Esc 取消'}</Text>
      </Text>
      <Box flexDirection="column" alignItems="center" marginTop={1}>
        {lines.map((line, index) => (
          <Text
            key={index}
            color={danger ? colors.danger : undefined}
            dimColor={!danger && index > 0}
          >
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  )
}
