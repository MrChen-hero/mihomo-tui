/**
 * 表头渲染函数 —— 连接页表头标准（对齐 mihari table header）
 *
 * 用法：
 *   renderTableHeader(['HOST', 'CHAIN', '↑', '↓', 'TIME'], [40, 20, 12, 12, 10])
 */

import { styles } from './theme.js'

/**
 * 渲染表头行（纯函数，可测）
 *
 * @param headers - 表头文本数组
 * @param widths - 各列宽度数组
 * @returns 格式化的表头字符串（dimColor + bold）
 *
 * @example
 * renderTableHeader(['HOST', 'CHAIN'], [40, 20])
 * // => '  HOST                                      CHAIN               '
 */
export function renderTableHeader(headers: string[], widths: number[]): string {
  if (headers.length !== widths.length) {
    throw new Error('renderTableHeader: headers 与 widths 长度不匹配')
  }

  const cells = headers.map((header, i) => {
    const width = widths[i]!
    return header.padEnd(width).slice(0, width)
  })

  return '  ' + cells.join('')
}

/**
 * 表头样式对象（供 <Text> 展开）
 */
export const tableHeaderStyle = styles.tableHeader
