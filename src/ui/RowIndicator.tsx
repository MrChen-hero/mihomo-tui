/**
 * 行焦点指示符（2026-09-22 标准化美化）
 *
 * 统一行级焦点符号（▌），抽离自 Proxies 页，供全部滚动列表复用。
 * 保持单一职责：只负责渲染焦点指示符，不负责行内容本身。
 */

import { Text } from 'ink'
import { styles } from './theme.js'

export interface RowIndicatorProps {
  /** 是否为焦点行 */
  focused: boolean
}

/**
 * 行焦点指示符组件
 *
 * - focused=true：渲染 accent 色 `▌` 符号
 * - focused=false：渲染等宽空格占位，保持对齐
 *
 * @example
 * <Text>
 *   <RowIndicator focused={index === cursor} />
 *   {nodeContent}
 * </Text>
 */
export function RowIndicator({ focused }: RowIndicatorProps) {
  return focused ? (
    <Text {...styles.rowFocus}>{'▌ '}</Text>
  ) : (
    <Text>{'  '}</Text>
  )
}
