import { describe, it, expect } from 'vitest'
import { classifySize } from '../layout'

describe('layout', () => {
  describe('classifySize', () => {
    it('应分类 TooSmall（< 72 列）', () => {
      expect(classifySize(71)).toBe('TooSmall')
      expect(classifySize(50)).toBe('TooSmall')
      expect(classifySize(0)).toBe('TooSmall')
    })

    it('应分类 Compact（72~99 列）', () => {
      expect(classifySize(72)).toBe('Compact')
      expect(classifySize(80)).toBe('Compact')
      expect(classifySize(99)).toBe('Compact')
    })

    it('应分类 Full（≥ 100 列）', () => {
      expect(classifySize(100)).toBe('Full')
      expect(classifySize(110)).toBe('Full')
      expect(classifySize(200)).toBe('Full')
    })
  })
})
