/**
 * 通用多字段输入对话框（设计稿 5.1，交互参照 cc-switch 的表单样式重做）。
 *
 * 键位：字符输入当前字段；↑↓/Tab 切换字段；Enter 当前字段合法则前进，
 * 到最后一个字段且整表合法时提交；ESC 取消。
 *
 * 粘贴：ink 7 的 usePaste 走 bracketed paste 独立通道，整串插入当前字段；
 * 终端不支持 bracketed paste 时，粘贴会作为多字符 chunk 进入 useInput，
 * 旧实现 `input.length === 1` 会把整串丢弃（新增订阅框贴不进 URL 的根因），
 * 现按「过滤控制字符后整串插入」兜底。
 *
 * 编辑：←→/Home/End 移动光标（含 Ctrl+A/E/B/F），Backspace/Delete 删字符，
 * Ctrl+U 清空、Ctrl+K 删至行尾、Ctrl+W 向前删一个词。光标始终可见（反色块），
 * 超长值（订阅 URL）按显示宽度开窗滚动，不折行不撑破布局。
 *
 * 实现要点：终端一次 read 往往带来一串字符（快速打字/粘贴），同一轮事件里
 * handler 会被连续调用多次 —— 因此按键处理一律读写 valuesRef/activeRef/
 * cursorRef（始终最新的镜像），不能依赖 useState 闭包里的旧值。
 * 光标与增删一律按码点数组操作，emoji 等代理对不会被 slice 切断。
 */
import { Box, Text, useInput, usePaste } from 'ink'
import { colors, styles } from '../ui/theme.js'
import { useRef, useState, type ReactNode } from 'react'
import { displayWidth } from '../commands/output.js'

export interface InputField {
  label: string
  key: string
  placeholder?: string
  /** 空值时不允许提交 */
  required?: boolean
  /** 返回错误文案；undefined 表示通过 */
  validate?: (value: string) => string | undefined
  /** 以 * 回显（token 类字段） */
  secret?: boolean
  /** 只读展示（如编辑时的订阅名）；不接收输入，无错误态 */
  readOnly?: boolean
  /** 初始值 */
  value?: string
}

export function validateField(field: InputField, value: string): string | undefined {
  if (field.readOnly) return undefined
  if (field.required && value === '') return `${field.label}不能为空`
  return field.validate?.(value)
}

/** 逐字段求错误；只读字段恒无错误 */
export function allErrors(
  fields: InputField[],
  values: Record<string, string>,
): Record<string, string | undefined> {
  const errors: Record<string, string | undefined> = {}
  for (const field of fields) {
    errors[field.key] = validateField(field, values[field.key] ?? '')
  }
  return errors
}

export function isFormValid(fields: InputField[], values: Record<string, string>): boolean {
  return Object.values(allErrors(fields, values)).every((error) => error === undefined)
}

/** 丢掉控制字符（换行、制表、0x00-0x1f、DEL），保留可打印内容 */
export function sanitizeInput(raw: string): string {
  return [...raw]
    .filter((char) => char >= ' ' && char !== '\u007f')
    .join('')
}

export interface InputWindowResult {
  /** 开窗后的可见文本（两侧截断时以 … 标记） */
  text: string
  /** 光标字符在 text 中的码点下标 */
  cursorOffset: number
}

/**
 * 把超长单行值按显示宽度开窗，保证光标字符可见。
 * display 是已经过掩码处理的展示串（secret 字段传 * 串）；cursor 是其中的码点下标；
 * max 是可用显示列数。
 */
export function inputWindow(display: string, cursor: number, max: number): InputWindowResult {
  const chars = [...display]
  const clamped = Math.min(Math.max(0, cursor), chars.length)
  const widths = chars.map((char) => displayWidth(char))
  const total = widths.reduce((sum, w) => sum + w, 0)
  if (max <= 0) return { text: '', cursorOffset: 0 }
  if (total <= max) {
    return { text: display, cursorOffset: clamped }
  }

  // 以光标为中心向两侧扩张，指示符 … 各预留 1 列
  const cursorWidth = clamped < chars.length ? widths[clamped] ?? 1 : 1
  let start = clamped // [start, clamped) 是光标左侧片段
  let end = Math.min(clamped + 1, chars.length) // [clamped, end) 含光标字符与其右侧片段
  let used = cursorWidth
  while (true) {
    if (start > 0 && used + widths[start - 1]! + 2 <= max) {
      start -= 1
      used += widths[start]!
      continue
    }
    if (end < chars.length && used + widths[end]! + 2 <= max) {
      used += widths[end]!
      end += 1
      continue
    }
    break
  }
  const markLeft = start > 0
  const markRight = end < chars.length
  // 预算里已含两侧 … 的 2 列，这里直接落位
  const middle = chars.slice(start, end).join('')
  const prefix = markLeft ? '…' : ''
  const suffix = markRight ? '…' : ''
  return {
    text: prefix + middle + suffix,
    cursorOffset: (markLeft ? 1 : 0) + (clamped - start),
  }
}

export interface InputDialogProps {
  title: string
  fields: InputField[]
  width?: number
  onSubmit: (values: Record<string, string>) => void
  onCancel: () => void
}

export function InputDialog({ title, fields, width = 64, onSubmit, onCancel }: InputDialogProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const field of fields) initial[field.key] = field.value ?? ''
    return initial
  })
  const valuesRef = useRef(values)
  const [active, setActive] = useState(0)
  const activeRef = useRef(0)
  const cursorRef = useRef<number>(
    Math.min(fields[0]?.value?.length ?? 0, Number.MAX_SAFE_INTEGER),
  )
  const [attempted, setAttempted] = useState(false) // 只有在提交被拦后才开始逐字段标红

  const errors = allErrors(fields, values)

  const commitValues = (next: Record<string, string>): void => {
    valuesRef.current = next
    setValues(next)
  }
  /** 切到某字段时按其当前值末尾落位光标（表单的通行习惯） */
  const moveTo = (index: number): void => {
    const clamped = Math.min(fields.length - 1, Math.max(0, index))
    const field = fields[clamped]
    cursorRef.current = clamped >= 0 && field ? (valuesRef.current[field.key] ?? '').length : 0
    activeRef.current = clamped
    setActive(clamped)
  }
  /** 对当前字段按码点数组做一次原位变换，返回 null 表示不修改 */
  const editCurrent = (
    transform: (chars: string[], cursor: number) => { chars: string[]; cursor: number } | null,
  ): void => {
    const field = fields[activeRef.current]
    if (!field || field.readOnly) return
    const key = field.key
    const chars = [...(valuesRef.current[key] ?? '')]
    const result = transform(chars, Math.min(cursorRef.current, chars.length))
    if (!result) return
    cursorRef.current = result.cursor
    commitValues({ ...valuesRef.current, [key]: result.chars.join('') })
  }

  const insertText = (raw: string): void => {
    const cleaned = sanitizeInput(raw)
    if (!cleaned) return
    editCurrent((chars, cursor) => ({
      chars: [...chars.slice(0, cursor), ...[...cleaned], ...chars.slice(cursor)],
      cursor: cursor + [...cleaned].length,
    }))
  }

  usePaste(insertText)

  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.upArrow) {
      moveTo(activeRef.current - 1)
      return
    }
    if (key.downArrow || key.tab) {
      moveTo(activeRef.current + 1)
      return
    }
    if (key.return) {
      // 当前字段还有错：停在原地（attempted 后错误可见）
      const activeKey = fields[activeRef.current]?.key ?? ''
      if (allErrors(fields, valuesRef.current)[activeKey]) {
        setAttempted(true)
        return
      }
      if (activeRef.current < fields.length - 1) {
        moveTo(activeRef.current + 1)
        return
      }
      // 最后一个字段：整表合法才提交
      if (isFormValid(fields, valuesRef.current)) {
        onSubmit({ ...valuesRef.current })
      } else {
        setAttempted(true)
      }
      return
    }
    if (key.leftArrow) {
      editCurrent((chars, cursor) => ({ chars, cursor: Math.max(0, cursor - 1) }))
      return
    }
    if (key.rightArrow) {
      editCurrent((chars, cursor) => ({ chars, cursor: Math.min(chars.length, cursor + 1) }))
      return
    }
    if (key.home || (key.ctrl && input === 'a')) {
      editCurrent((chars, cursor) => ({ chars, cursor: 0 }))
      return
    }
    if (key.end || (key.ctrl && input === 'e')) {
      editCurrent((chars, cursor) => ({ chars, cursor: chars.length }))
      return
    }
    if (key.backspace) {
      editCurrent((chars, cursor) =>
        cursor === 0 ? null : { chars: [...chars.slice(0, cursor - 1), ...chars.slice(cursor)], cursor: cursor - 1 },
      )
      return
    }
    if (key.delete) {
      editCurrent((chars, cursor) =>
        cursor >= chars.length ? null : { chars: [...chars.slice(0, cursor), ...chars.slice(cursor + 1)], cursor },
      )
      return
    }
    if (key.ctrl) {
      if (input === 'b') {
        editCurrent((chars, cursor) => ({ chars, cursor: Math.max(0, cursor - 1) }))
      } else if (input === 'f') {
        editCurrent((chars, cursor) => ({ chars, cursor: Math.min(chars.length, cursor + 1) }))
      } else if (input === 'u') {
        editCurrent(() => ({ chars: [], cursor: 0 }))
      } else if (input === 'k') {
        editCurrent((chars, cursor) => ({ chars: chars.slice(0, cursor), cursor }))
      } else if (input === 'w') {
        editCurrent((chars, cursor) => {
          let i = cursor
          while (i > 0 && chars[i - 1] === ' ') i -= 1
          while (i > 0 && chars[i - 1] !== ' ') i -= 1
          return { chars: [...chars.slice(0, i), ...chars.slice(cursor)], cursor: i }
        })
      }
      return
    }
    if (key.meta) return
    // 整串插入（多字符 chunk = 不带 bracketed paste 标记的粘贴 / 快速输入）
    insertText(input)
  })

  const tried = attempted
  // 输入盒内可用列：外框 2 + paddingX 2 + 输入盒边框 2 + 输入盒 paddingX 2
  const innerWidth = Math.max(10, width - 6)

  const renderValue = (field: InputField, value: string, isActive: boolean): ReactNode => {
    if (field.readOnly) {
      return (
        <Text dimColor>
          {value || '—'}
          {`（只读）`}
        </Text>
      )
    }
    if (!isActive) {
      const display = field.secret ? '*'.repeat(value.length) : value
      return <Text dimColor>{display || (field.placeholder ? `<${field.placeholder}>` : '—')}</Text>
    }
    const display = field.secret ? '*'.repeat(value.length) : value
    const error = errors[field.key]
    const invalid = tried && error !== undefined
    const windowed = value
      ? inputWindow(display, Math.min(cursorRef.current, [...display].length), innerWidth)
      : { text: '', cursorOffset: 0 }
    const windowChars = [...windowed.text]
    const at = value ? (windowChars[windowed.cursorOffset] ?? ' ') : ' '
    const before = value ? windowChars.slice(0, windowed.cursorOffset).join('') : ''
    const after = value ? windowChars.slice(windowed.cursorOffset + 1).join('') : ''
    return (
      <Box
        borderStyle="round"
        borderColor={invalid ? colors.danger : colors.accent}
        paddingX={1}
        width="100%"
      >
        {value ? (
          <Text>
            {before}
            <Text inverse>{at}</Text>
            {after}
          </Text>
        ) : (
          <Text>
            <Text inverse>{' '}</Text>
            {field.placeholder ? <Text dimColor>{` <${field.placeholder}>`}</Text> : null}
          </Text>
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1} width={width}>
      <Text>
        <Text bold color={colors.accent}>{'◆ '}</Text>
        <Text bold>{title}</Text>
      </Text>
      {fields.map((field, index) => {
        const value = values[field.key] ?? ''
        const error = errors[field.key]
        const showError = tried && error !== undefined
        const isActive = index === active
        return (
          <Box key={field.key} flexDirection="column">
            {isActive ? (
              <Text>
                <Text {...styles.keyCap}>{`❯ ${field.label}`}</Text>
                {field.readOnly ? <Text dimColor>{'（只读）'}</Text> : null}
              </Text>
            ) : (
              <Text>
                <Text dimColor>{`  ${field.label}`}</Text>
              </Text>
            )}
            {renderValue(field, value, isActive)}
            {showError ? (
              <Text color={colors.danger}>{`  ⚠ ${error}`}</Text>
            ) : null}
          </Box>
        )
      })}
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text {...styles.keyCap}>{'↑↓/Tab'}</Text>
          <Text dimColor>{' 切换  '}</Text>
          <Text {...styles.keyCap}>{'Enter'}</Text>
          <Text dimColor>{' 确认  '}</Text>
          <Text {...styles.keyCap}>{'Esc'}</Text>
          <Text dimColor>{' 取消'}</Text>
        </Text>
        <Text dimColor>{' 支持粘贴  ←→ 光标  Ctrl+U 清空'}</Text>
      </Box>
    </Box>
  )
}
