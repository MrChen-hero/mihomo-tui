/**
 * 确认对话框（cc-switch 确认卡片语言，spec 2026-09-13 dialogs-topbar-polish §3.1）。
 * 键帽反色块居中、问题文案居中、大留白；无内部标题行——问题文案即内容。
 * y/Y 确认，n/N/ESC 取消；danger 模式红色边框与文案，用于不可撤销的删除类操作。
 *
 * borderTitle：内嵌边框标题形态（如退出确认的「退出」，Panel 同款顶线）——
 * 键帽紧贴顶线、与文案间隔三行、底部三行留白；缺省保持紧凑确认卡形态。
 */
import { Box, Text, useInput } from 'ink'
import { colors, styles } from '../ui/theme.js'
import { TOP_PREFIX, panelTopParts } from '../ui/Panel.js'
import { useKeyCapture } from '../ui/keyCapture.js'

export interface ConfirmDialogProps {
  /** 单段或多行说明：首行主文案（默认色），后续行 dim */
  message: string | string[]
  danger?: boolean
  width?: number
  /** Enter 也确认；默认关——删除类确认保持 y 显式确认，退出确认用 */
  enterConfirms?: boolean
  /** 内嵌边框标题（Panel 同款顶线语言） */
  borderTitle?: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  message,
  danger = false,
  width = 56,
  enterConfirms = false,
  borderTitle,
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
  const borderColor = danger ? colors.danger : colors.accent
  const titleStyle = danger ? { color: colors.danger, bold: true } : styles.panelTitle
  const parts = borderTitle !== undefined ? panelTopParts(borderTitle, width) : null
  return (
    <Box flexDirection="column" width={width}>
      {parts ? (
        <Text>
          <Text color={borderColor}>{TOP_PREFIX}</Text>
          <Text {...titleStyle}>{parts.title}</Text>
          <Text color={borderColor}>{parts.tail}</Text>
        </Text>
      ) : null}
      <Box
        flexDirection="column"
        alignItems="center"
        borderStyle="round"
        borderTop={parts ? false : undefined}
        borderColor={borderColor}
        paddingX={1}
        paddingTop={parts ? 0 : 1}
        paddingBottom={parts ? 3 : 2}
      >
        {/* 键帽行：中性 inverse 块（不引入色相），块间两空格正常底色 */}
        <Text>
          <Text inverse>{enterConfirms ? 'Enter 确认' : 'y 确认'}</Text>
          <Text>{'  '}</Text>
          <Text inverse>{enterConfirms ? 'Esc 取消' : 'n/Esc 取消'}</Text>
        </Text>
        <Box flexDirection="column" alignItems="center" marginTop={parts ? 3 : 1}>
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
    </Box>
  )
}
