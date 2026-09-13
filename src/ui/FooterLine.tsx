/**
 * 键帽页脚：快捷键提示的统一组件（键名青色加粗、说明暗色），
 * 主界面各页与对话框共用同一视觉语言。
 *
 * 窄宽降级（对齐 mihari FitFooter）：宽度不足时从中间段开始丢弃，
 * 无条件保底最后一段与右侧全局段；仍放不下再整体截断。
 */
import { Box, Text } from 'ink'
import { colors, styles } from './theme.js'
import { displayWidth, truncateDisplay } from '../commands/output.js'

export interface FooterHint {
  /** 键名（如 ↑↓、Enter） */
  key: string
  /** 说明（如 移动） */
  label: string
}

const SEP = '  '

function segmentWidth(hint: FooterHint): number {
  return displayWidth(hint.key) + 1 + displayWidth(hint.label)
}

/** 全部段渲染后的总显示宽度（纯函数） */
export function footerWidth(hints: FooterHint[], global?: string): number {
  const hintsWidth = hints.reduce((sum, h) => sum + segmentWidth(h), 0) + Math.max(0, hints.length - 1) * displayWidth(SEP)
  const globalWidth = global === undefined ? 0 : displayWidth(global) + (hints.length > 0 ? displayWidth(SEP) : 0)
  return hintsWidth + globalWidth
}

/**
 * 宽度不足时的丢段策略（纯函数）：
 * 从最靠近中部的段开始丢，保底最后一段；只剩两段时丢首段；
 * 仍超宽时对保底段做显示宽硬截断（截最后一段的 label）。
 */
export function fitFooterHints(hints: FooterHint[], width: number): FooterHint[] {
  if (hints.length === 0) return hints
  const kept = [...hints]
  while (footerWidth(kept, undefined) > width && kept.length > 2) {
    const middle = Math.floor(kept.length / 2)
    kept.splice(middle - (kept.length % 2 === 0 ? 1 : 0), 1)
  }
  while (footerWidth(kept, undefined) > width && kept.length > 1) {
    kept.shift() // 只剩两段时丢首段，永远保底最后一段
  }
  const last = kept[0]
  if (last && footerWidth(kept, undefined) > width) {
    // 保底段也放不下：截 label，键名保留
    const labelWidth = width - displayWidth(last.key) - 1
    kept[0] = { key: last.key, label: truncateDisplay(last.label, Math.max(1, labelWidth)) }
  }
  return kept
}

export interface FooterLineProps {
  hints: FooterHint[]
  /** 右侧全局段（如 spinner/退出提示），最后被丢弃前优先保留语义上更重要的是全局段 */
  global?: string
  /** 可用宽度；缺省不限宽 */
  width?: number
}

export function FooterLine({ hints, global, width }: FooterLineProps) {
  let kept = hints
  let globalText = global
  if (width !== undefined) {
    // 全局段优先保留：先按「全部段 + 全局」尝试，放不下则逐段丢 hint
    kept = fitFooterHints(hints, Math.max(0, width - (global ? displayWidth(global) + displayWidth(SEP) : 0)))
    if (footerWidth(kept, global) > width) {
      globalText = truncateDisplay(global ?? '', width - footerWidth(kept, undefined))
    }
  }
  return (
    <Text>
      {kept.map((hint, index) => (
        <Text key={hint.key + String(index)}>
          {index > 0 ? <Text dimColor>{SEP}</Text> : null}
          <Text {...styles.keyCap}>{hint.key}</Text>
          <Text {...styles.keyHint}>{` ${hint.label}`}</Text>
        </Text>
      ))}
      {globalText && kept.length > 0 ? <Text dimColor>{SEP}</Text> : null}
      {globalText ? <Text color={colors.muted}>{globalText}</Text> : null}
    </Text>
  )
}

/** 单个键帽（对话框等处单独使用） */
export function KeyCap({ children }: { children: string }) {
  return <Text {...styles.keyCap}>{children}</Text>
}
