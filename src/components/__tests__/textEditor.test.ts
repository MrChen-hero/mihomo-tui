import { describe, expect, it } from 'vitest'
import { fromText, reduce, scrollToCursor, toText, visibleLines } from '../textEditor.js'

const doc = (text: string) => fromText(text)

describe('textEditor 文档模型', () => {
  it('往返：文本拆行再拼回，统一换行符', () => {
    expect(toText(doc('a\r\nb\rc'))).toBe('a\nb\nc')
    expect(doc('').lines).toEqual([''])
  })

  it('插入：行内插入并把光标移到末尾', () => {
    const state = reduce(doc('ac'), { type: 'move', dir: 'right' })
    const next = reduce(state, { type: 'insert', text: 'b' })
    expect(toText(next)).toBe('abc')
    expect(next.col).toBe(2)
  })

  it('插入多行（粘贴）：拆成多行，光标落在末段之后', () => {
    const next = reduce(doc(''), { type: 'insert', text: 'proxies:\n  - name: hk' })
    expect(next.lines).toEqual(['proxies:', '  - name: hk'])
    expect(next.row).toBe(1)
    expect(next.col).toBe([...('  - name: hk')].length)
  })

  it('退格：行内删码点；行首把当前行并入上一行', () => {
    let state = doc('ab\ncd')
    state = reduce(state, { type: 'move', dir: 'down' })
    const merged = reduce(state, { type: 'backspace' })
    expect(toText(merged)).toBe('abcd')
    expect(merged.row).toBe(0)
    expect(merged.col).toBe(2)
  })

  it('退格按码点删除，不切断 emoji', () => {
    let state = doc('a😀b')
    state = reduce(state, { type: 'move', dir: 'end' })
    state = reduce(state, { type: 'move', dir: 'left' })
    state = reduce(state, { type: 'backspace' })
    expect(toText(state)).toBe('ab')
  })

  it('向前删除：行尾合并下一行', () => {
    let state = doc('ab\ncd')
    state = reduce(state, { type: 'move', dir: 'end' })
    state = reduce(state, { type: 'delete' })
    expect(toText(state)).toBe('abcd')
  })

  it('上下移动保持列号，目标行更短则落到行尾', () => {
    let state = doc('abcde\nab')
    state = reduce(state, { type: 'move', dir: 'end' })
    const down = reduce(state, { type: 'move', dir: 'down' })
    expect(down.row).toBe(1)
    expect(down.col).toBe(2)
    const up = reduce(down, { type: 'move', dir: 'up' })
    expect(up.col).toBe(2)
  })

  it('左右移动可跨行', () => {
    let state = doc('ab\ncd')
    state = reduce(state, { type: 'move', dir: 'end' })
    const right = reduce(state, { type: 'move', dir: 'right' })
    expect(right).toMatchObject({ row: 1, col: 0 })
    const left = reduce(right, { type: 'move', dir: 'left' })
    expect(left).toMatchObject({ row: 0, col: 2 })
  })

  it('滚动：光标超出窗口时窗口跟随', () => {
    let state = doc(['0', '1', '2', '3', '4'].join('\n'))
    for (let i = 0; i < 4; i++) state = reduce(state, { type: 'move', dir: 'down' }, 3)
    expect(state.row).toBe(4)
    expect(state.scroll).toBe(2)
    const back = scrollToCursor({ ...state, row: 0 }, 3)
    expect(back.scroll).toBe(0)
  })

  it('可视行：只取窗口内的行，光标行带偏移', () => {
    const state = { ...doc('aaaa\nbbbb\ncccc'), row: 1, col: 2, scroll: 0 }
    const lines = visibleLines(state, 2, 80)
    expect(lines.map((line) => line.index)).toEqual([0, 1])
    expect(lines[1]).toMatchObject({ cursor: true, cursorOffset: 2 })
    expect(lines[0]?.cursor).toBe(false)
  })
})
