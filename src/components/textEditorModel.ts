/**
 * 多行文本编辑器的文档模型（v0.3.0 §7.3）。纯逻辑，不依赖 Ink。
 *
 * 行内位置一律按码点（code point）计，emoji 等代理对不会被切断。
 * 滚动语义借鉴 mihari viewport.go 的 EnsureLineVisible：光标行始终
 * 保持在可视窗口内，窗口不越界。
 */
import { inputWindow } from './InputDialog.js'

export interface EditorState {
  /** 每个元素是一行；空文档为 [''] */
  lines: string[]
  /** 光标行，0 基 */
  row: number
  /** 光标列，码点下标（可等于行长，表示行尾之后） */
  col: number
  /** 可视窗口的首行 */
  scroll: number
}

export type EditorAction =
  | { type: 'insert'; text: string }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'move'; dir: 'left' | 'right' | 'up' | 'down' | 'home' | 'end' }

/** 把文本拆成行；空串得到一个空行，便于光标落位 */
export function fromText(text: string): EditorState {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  return { lines: lines.length > 0 ? lines : [''], row: 0, col: 0, scroll: 0 }
}

export function toText(state: EditorState): string {
  return state.lines.join('\n')
}

const chars = (line: string): string[] => [...line]

/**
 * 归约一次编辑动作。viewHeight 是可视行数，用于在动作后把光标行
 * 滚进窗口；传 0 表示不滚动。
 */
export function reduce(state: EditorState, action: EditorAction, viewHeight = 0): EditorState {
  const next = applyAction(state, action)
  return viewHeight > 0 ? scrollToCursor(next, viewHeight) : next
}

function applyAction(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'insert':
      return insertText(state, action.text)
    case 'backspace':
      return backspace(state)
    case 'delete':
      return deleteForward(state)
    case 'move':
      return move(state, action.dir)
  }
}

/** 插入文本，可含换行（粘贴多行一次完成） */
function insertText(state: EditorState, text: string): EditorState {
  const lines = state.lines.slice()
  const current = chars(lines[state.row] ?? '')
  const before = current.slice(0, state.col).join('')
  const after = current.slice(state.col).join('')
  const inserted = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const first = inserted[0] ?? ''
  const last = inserted[inserted.length - 1] ?? ''
  lines.splice(state.row, 1, before + first, ...inserted.slice(1, -1), last + after)
  // 上面在 inserted 只有一段时会重复，收敛掉
  if (inserted.length === 1) {
    lines.splice(state.row, 2, before + first + after)
  }
  return {
    ...state,
    lines,
    row: state.row + inserted.length - 1,
    col: [...(inserted.length === 1 ? before + first : last)].length,
  }
}

/** 退格：行内删一个码点；行首则把当前行并入上一行 */
function backspace(state: EditorState): EditorState {
  const lines = state.lines.slice()
  const current = chars(lines[state.row] ?? '')
  if (state.col > 0) {
    lines[state.row] = [...current.slice(0, state.col - 1), ...current.slice(state.col)].join('')
    return { ...state, lines, col: state.col - 1 }
  }
  if (state.row === 0) return state
  const prev = lines[state.row - 1] ?? ''
  lines.splice(state.row - 1, 2, prev + current.join(''))
  return { ...state, lines, row: state.row - 1, col: [...prev].length }
}

/** 向前删除：行内删光标后一个码点；行尾则合并下一行 */
function deleteForward(state: EditorState): EditorState {
  const lines = state.lines.slice()
  const current = chars(lines[state.row] ?? '')
  if (state.col < current.length) {
    lines[state.row] = [...current.slice(0, state.col), ...current.slice(state.col + 1)].join('')
    return { ...state, lines }
  }
  if (state.row >= lines.length - 1) return state
  lines.splice(state.row, 2, current.join('') + (lines[state.row + 1] ?? ''))
  return { ...state, lines }
}

function move(state: EditorState, dir: EditorAction & { type: 'move' } extends infer _ ? 'left' | 'right' | 'up' | 'down' | 'home' | 'end' : never): EditorState {
  const lineLen = chars(state.lines[state.row] ?? '').length
  switch (dir) {
    case 'left':
      if (state.col > 0) return { ...state, col: state.col - 1 }
      if (state.row === 0) return state
      return { ...state, row: state.row - 1, col: chars(state.lines[state.row - 1] ?? '').length }
    case 'right':
      if (state.col < lineLen) return { ...state, col: state.col + 1 }
      if (state.row >= state.lines.length - 1) return state
      return { ...state, row: state.row + 1, col: 0 }
    case 'up':
      return moveVertical(state, -1)
    case 'down':
      return moveVertical(state, 1)
    case 'home':
      return { ...state, col: 0 }
    case 'end':
      return { ...state, col: lineLen }
  }
}

/** 上下移动时列号尽量保持，目标行更短则落到行尾 */
function moveVertical(state: EditorState, delta: number): EditorState {
  const row = Math.min(Math.max(0, state.row + delta), state.lines.length - 1)
  const len = chars(state.lines[row] ?? '').length
  return { ...state, row, col: Math.min(state.col, len) }
}

/**
 * 让光标行保持在可视窗口内（借鉴 mihari EnsureLineVisible）。
 * 光标在窗口之上 → 窗口上移到光标行；在窗口之下 → 窗口下移使光标落在末行。
 */
export function scrollToCursor(state: EditorState, viewHeight: number): EditorState {
  if (viewHeight <= 0) return state
  const maxScroll = Math.max(0, state.lines.length - viewHeight)
  let scroll = Math.min(state.scroll, maxScroll)
  if (state.row < scroll) scroll = state.row
  if (state.row >= scroll + viewHeight) scroll = state.row - viewHeight + 1
  return { ...state, scroll: Math.min(Math.max(0, scroll), maxScroll) }
}

export interface VisibleLine {
  /** 原始行号，0 基 */
  index: number
  text: string
  /** 光标是否在这一行 */
  cursor: boolean
  /** 光标在该行可视文本中的码点下标；非光标行为 -1 */
  cursorOffset: number
}

/**
 * 取可视窗口内的行。每行按 maxWidth 做横向开窗：光标行以光标为中心，
 * 其余行显示开头。复用 InputDialog 的 inputWindow。
 */
export function visibleLines(state: EditorState, viewHeight: number, maxWidth: number): VisibleLine[] {
  const start = state.scroll
  const end = Math.min(state.lines.length, start + Math.max(0, viewHeight))
  const result: VisibleLine[] = []
  for (let index = start; index < end; index++) {
    const line = state.lines[index] ?? ''
    const isCursor = index === state.row
    const windowed = inputWindow(line, isCursor ? state.col : 0, maxWidth)
    result.push({
      index,
      text: windowed.text,
      cursor: isCursor,
      cursorOffset: isCursor ? windowed.cursorOffset : -1,
    })
  }
  return result
}
