import { describe, it, expect } from 'vitest'
import { renderTableHeader, tableHeaderStyle } from '../tableHeader'
import { styles } from '../theme'

describe('tableHeader', () => {
  describe('renderTableHeader', () => {
    it('应渲染标准表头', () => {
      const result = renderTableHeader(['HOST', 'CHAIN', 'TIME'], [40, 20, 10])
      expect(result).toBe('  HOST                                    CHAIN               TIME      ')
    })

    it('应处理单列表头', () => {
      const result = renderTableHeader(['NAME'], [20])
      expect(result).toBe('  NAME                ')
    })

    it('应处理空表头', () => {
      const result = renderTableHeader([], [])
      expect(result).toBe('  ')
    })

    it('应截断超长文本', () => {
      const result = renderTableHeader(['很长的表头文本超出宽度'], [10])
      expect(result.length).toBe(12) // '  ' + 10 列
    })

    it('应在长度不匹配时抛错', () => {
      expect(() => renderTableHeader(['A', 'B'], [10])).toThrow('长度不匹配')
    })
  })

  describe('tableHeaderStyle', () => {
    it('应导出正确的样式对象', () => {
      expect(tableHeaderStyle).toEqual(styles.tableHeader)
      expect(tableHeaderStyle).toHaveProperty('dimColor')
      expect(tableHeaderStyle).toHaveProperty('bold')
    })
  })
})
