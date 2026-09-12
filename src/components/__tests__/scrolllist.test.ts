import { describe, expect, it } from 'vitest'
import { windowStart } from '../ScrollList.js'

describe('windowStart 视口起始下标', () => {
  it('列表不超视口时从 0 开始', () => {
    expect(windowStart(0, 5, 10)).toBe(0)
    expect(windowStart(4, 5, 10)).toBe(0)
    expect(windowStart(3, 0, 3)).toBe(0)
  })

  it('选中项靠前时贴顶', () => {
    expect(windowStart(0, 10, 3)).toBe(0)
    expect(windowStart(1, 10, 3)).toBe(0)
  })

  it('选中项尽量居中', () => {
    // height 3 → half 1；selected 4 → start 3，选中项落在视口第 2 行
    expect(windowStart(4, 10, 3)).toBe(3)
    expect(windowStart(7, 10, 5)).toBe(5)
  })

  it('选中项靠后时贴底，不越界', () => {
    expect(windowStart(9, 10, 3)).toBe(7)
    expect(windowStart(100, 10, 3)).toBe(7)
  })

  it('负下标安全', () => {
    expect(windowStart(-5, 10, 3)).toBe(0)
  })
})
