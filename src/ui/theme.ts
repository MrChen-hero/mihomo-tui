/**
 * 「终端绿」主题 —— 全项目唯一取色处。
 *
 * 颜色用 ink 的 ansi256(N) 语法精确表达 256 色板索引，由 ink 按终端
 * 能力决定降级；业务代码禁止硬编码色值，一律 import { colors, styles }。
 *
 * 语义（颜色承载含义而非装饰）：
 *   accent 焦点/交互 · success 健康 · warning 注意 · danger 错误 · info 信息
 *   muted 次要/未知（关闭或未知是合法中性态，不用红） · surfaceBorder 边框
 *   onSolid 实底徽标前景（黑色，保证 256 色终端对比度）
 *
 * 角色样式供 <Text {...styles.xxx}> 展开；换主题只改本文件。
 */
export const colors = {
  accent: 'ansi256(40)', // #00d700 亮终端绿
  success: 'ansi256(71)', // #5faf5f 中绿
  warning: 'ansi256(184)', // #d7d75f 橄榄黄
  danger: 'ansi256(160)', // #d70000 正红
  info: 'ansi256(73)', // #5fafaf 青碧
  muted: 'ansi256(244)', // #808080 中灰
  surfaceBorder: 'ansi256(238)', // #444444 暗灰
  onSolid: 'ansi256(0)', // #000000 黑色（实底徽标前景）
} as const

export type ColorToken = keyof typeof colors

/** 角色样式（Text 属性子集），与 colors 同源 */
export const styles = {
  panelTitle: { color: colors.accent, bold: true },
  keyCap: { color: colors.accent, bold: true },
  keyHint: { dimColor: true },
  // ▌/● 等指示字符属 ambiguous 宽度（极端终端 2 列），依赖行内余量吸收
  rowFocus: { color: colors.accent },
  rowSelected: { color: colors.accent, bold: true },
  tableHeader: { dimColor: true, bold: true },
} as const

/** 状态四档语义（对齐 mihari statusdot：关闭/未知是中性，不用红） */
export type Tone = 'neutral' | 'positive' | 'caution' | 'negative'

export const toneColor: Record<Tone, string> = {
  neutral: colors.muted,
  positive: colors.success,
  caution: colors.warning,
  negative: colors.danger,
}

/** 实底徽标背景色映射（供 StatusChip solid 形态使用） */
export const toneBg: Record<Tone, string> = {
  neutral: 'ansi256(244)', // 灰底
  positive: 'ansi256(34)', // 绿底
  caution: 'ansi256(226)', // 黄底
  negative: 'ansi256(196)', // 红底
}
