/**
 * 通用多行文本编辑器（v0.3.0 §7.4）。
 *
 * 与文件、订阅无关：调用方传入初始文本、校验函数与保存/放弃回调，
 * 因此订阅 YAML、规则、本地节点等场景都能复用。
 *
 * 文档模型在 textEditor.ts（纯函数，按码点编辑）；本组件只负责渲染、
 * 键盘与粘贴绑定。ESC 有未保存修改时先弹确认再退出。
 *
 * 键位：方向键/Home/End 移动，字符输入，Backspace/Delete 删除，Enter 换行，
 * Ctrl-S 校验后保存，ESC 放弃。
 */
import { useRef, useState, type ReactNode } from 'react'
import { Box, Text, useInput, usePaste } from 'ink'
import { colors } from '../ui/theme.js'
import { Panel } from '../ui/Panel.js'
import { useKeyCapture } from '../ui/keyCapture.js'
import { ConfirmDialog } from './ConfirmDialog.js'
import {
  fromText,
  reduce,
  toText,
  visibleLines,
  type EditorAction,
  type EditorState,
} from './textEditor.js'

export interface TextEditorProps {
  title: string
  initialText: string
  height: number
  width: number
  /** 保存前校验；返回错误文案则不保存并在状态栏显示 */
  validate?: (text: string) => string | undefined
  onSave: (text: string) => void
  onCancel: () => void
}

export function TextEditor({
  title,
  initialText,
  height,
  width,
  validate,
  onSave,
  onCancel,
}: TextEditorProps) {
  const [state, setState] = useState<EditorState>(() => fromText(initialText))
  const [error, setError] = useState<string | undefined>(undefined)
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const stateRef = useRef(state)
  stateRef.current = state

  // 可视行数：面板顶线 1 + 底栏 1 + 边框余量
  const viewHeight = Math.max(1, height - 4)
  const gutterWidth = String(state.lines.length).length + 1
  const textWidth = Math.max(1, width - gutterWidth - 4)

  const dirty = toText(state) !== initialText.replace(/\r\n/g, '\n')

  useKeyCapture(true)
  usePaste((text) => {
    setState((prev) => reduce(prev, { type: 'insert', text }, viewHeight))
    setError(undefined)
  })
  useInput((input, key) => {
    if (confirmingCancel) return
    if (key.escape) {
      if (dirty) setConfirmingCancel(true)
      else onCancel()
      return
    }
    // Ctrl-S 保存
    if (key.ctrl && input === 's') {
      const text = toText(stateRef.current)
      const problem = validate?.(text)
      if (problem) {
        setError(problem)
        return
      }
      onSave(text)
      return
    }
    const action = keyAction(input, key)
    if (!action) return
    setState((prev) => reduce(prev, action, viewHeight))
    setError(undefined)
  })

  if (confirmingCancel) {
    return (
      <ConfirmDialog
        message={['放弃未保存的修改？', '已编辑的内容将丢失']}
        onConfirm={onCancel}
        onCancel={() => setConfirmingCancel(false)}
      />
    )
  }

  const lines = visibleLines(state, viewHeight, textWidth)
  const status = error
    ? error
    : dirty
      ? `已修改 · ${state.lines.length} 行`
      : `${state.lines.length} 行`

  return (
    <Panel title={title} width={width} fillHeight>
      <Box flexDirection="column">
        {lines.map((line) => (
          <Box key={line.index}>
            <Text dimColor>{`${String(line.index + 1).padStart(gutterWidth - 1)} `}</Text>
            <Text>
              {renderLine(line.text, line.cursor ? line.cursorOffset : -1)}
            </Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text color={error ? colors.danger : colors.muted}>{status}</Text>
          <Text dimColor>{'  Ctrl-S 保存  ESC 放弃'}</Text>
        </Box>
      </Box>
    </Panel>
  )
}

/** 光标位置反色显示；光标在行尾时补一个空块 */
function renderLine(text: string, cursorOffset: number): ReactNode {
  if (cursorOffset < 0) return text
  const chars = [...text]
  const before = chars.slice(0, cursorOffset).join('')
  const at = chars[cursorOffset] ?? ' '
  const after = chars.slice(cursorOffset + 1).join('')
  return (
    <>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </>
  )
}

function keyAction(
  input: string,
  key: { upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; return?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean },
): EditorAction | undefined {
  if (key.upArrow) return { type: 'move', dir: 'up' }
  if (key.downArrow) return { type: 'move', dir: 'down' }
  if (key.leftArrow) return { type: 'move', dir: 'left' }
  if (key.rightArrow) return { type: 'move', dir: 'right' }
  if (key.ctrl && input === 'a') return { type: 'move', dir: 'home' }
  if (key.ctrl && input === 'e') return { type: 'move', dir: 'end' }
  if (key.return) return { type: 'insert', text: '\n' }
  if (key.backspace) return { type: 'backspace' }
  if (key.delete) return { type: 'delete' }
  if (key.ctrl || input.length === 0) return undefined
  // 过滤控制字符，其余（含粘贴兜底的多字符）按插入处理
  const cleaned = [...input].filter((char) => char >= ' ' && char !== '\x7f').join('')
  if (!cleaned) return undefined
  return { type: 'insert', text: cleaned }
}
