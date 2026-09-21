/**
 * 行焦点符号统一 —— 全 app 行首指示符（提升自 Proxies.tsx）
 *
 * 符号语义：
 *   ▌ = 键盘焦点行（accent 色）
 *   ❯ = 驻留光标（muted，仅双栏设置页另一栏无焦点时）
 *   ● = 业务选中标记（accent 加粗，如节点页已选节点）
 *   空格 = 无焦点/未选中
 */

import { colors } from './theme.js'

/**
 * 行焦点符号（纯函数，可测）
 *
 * @param focused - 是否键盘焦点行
 * @param selected - 是否业务选中（如节点页已选节点）
 * @returns 符号字符串（'▌'/'●'/空格）
 */
export function rowBar(focused: boolean, selected: boolean): string {
  if (focused) return '▌'
  if (selected) return '●'
  return ' '
}

/**
 * 行焦点符号颜色（纯函数，可测）
 *
 * @param focused - 是否键盘焦点行
 * @returns ANSI 颜色字符串
 */
export function rowBarColor(focused: boolean): string {
  return focused ? colors.accent : colors.accent
}

/**
 * 驻留光标符号（双栏页面另一栏用）
 *
 * @returns '❯'（muted 色，由调用方着色）
 */
export function cursorBar(): string {
  return '❯'
}
