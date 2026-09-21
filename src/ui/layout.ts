/**
 * 响应式布局系统（2026-09-22 标准化美化）
 *
 * 对齐 mihari 的三档分级：TooSmall/Compact/Full，
 * 为顶栏、页脚、各页面提供统一的宽度分类与降级策略。
 */

/** 终端宽度分级（对齐 mihari layout.go） */
export type SizeClass = 'TooSmall' | 'Compact' | 'Full'

/** 宽度阈值常量 */
export const SIZE_THRESHOLDS = {
  /** 最小可用宽度：低于此值显示降级提示 */
  MIN_USABLE: 72,
  /** 进入 Full 布局的宽度：≥100 列启用均布居中等高级布局 */
  FULL_LAYOUT: 100,
} as const

/**
 * 根据终端列宽分类布局档位（纯函数）
 *
 * @param columns 终端列数
 * @returns SizeClass 档位
 *
 * @example
 * classifySize(120) // => 'Full'
 * classifySize(80)  // => 'Compact'
 * classifySize(60)  // => 'TooSmall'
 */
export function classifySize(columns: number): SizeClass {
  if (columns < SIZE_THRESHOLDS.MIN_USABLE) return 'TooSmall'
  if (columns < SIZE_THRESHOLDS.FULL_LAYOUT) return 'Compact'
  return 'Full'
}
