import { describe, it, expect } from 'vitest'
import { rowBar, rowBarColor, cursorBar } from '../rowIndicator'
import { colors } from '../theme'

describe('rowIndicator', () => {
  describe('rowBar', () => {
    it('应在键盘焦点时返回 ▌', () => {
      expect(rowBar(true, false)).toBe('▌')
      expect(rowBar(true, true)).toBe('▌') // focused 优先级高于 selected
    })

    it('应在业务选中时返回 ●', () => {
      expect(rowBar(false, true)).toBe('●')
    })

    it('应在无焦点/未选中时返回空格', () => {
      expect(rowBar(false, false)).toBe(' ')
    })
  })

  describe('rowBarColor', () => {
    it('应返回 accent 色', () => {
      expect(rowBarColor(true)).toBe(colors.accent)
      expect(rowBarColor(false)).toBe(colors.accent)
    })
  })

  describe('cursorBar', () => {
    it('应返回 ❯', () => {
      expect(cursorBar()).toBe('❯')
    })
  })
})
