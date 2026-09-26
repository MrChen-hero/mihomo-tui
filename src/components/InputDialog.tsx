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
import { FooterLine } from '../ui/FooterLine.js'
import { ListDialog } from './ListDialog.js'
import { MIN_PANEL_WIDTH, Panel, TOP_PREFIX, panelTopParts } from '../ui/Panel.js'
import { colors } from '../ui/theme.js'
import { useRef, useState, type ReactNode } from 'react'
import { displayWidth, truncateDisplay } from '../commands/output.js'
import { useKeyCapture } from '../ui/keyCapture.js'

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
  /**
   * 选择型字段：非空时不接受自由输入，Enter 打开选项列表，选中后回填。
   * 用于「类型」这类固定枚举。
   */
  options?: { value: string; label: string }[]
  /**
   * 可输入也可从列表选的字段：照常打字，按 e 打开选项列表回填。
   * 与 options 互斥使用。用于「分组」这类既有候选项又允许新建的字段。
   */
  suggestions?: { value: string; label: string }[]
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
  /** Rule raw input must reject multiline paste instead of silently joining lines. */
  singleLinePaste?: boolean
  onSubmit: (values: Record<string, string>) => void
  onCancel: () => void
}

export function InputDialog({ title, fields, width = 64, singleLinePaste = false, onSubmit, onCancel }: InputDialogProps) {
  const [pasteError, setPasteError] = useState('')
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
  // 选择型字段（options）按下 Enter 时弹出的选项列表；null 表示未打开
  const [picking, setPicking] = useState<InputField | null>(null)

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
    if (singleLinePaste && /[\r\n\0]/.test(raw)) { setPasteError('只能输入单条规则，不允许换行或 NUL'); return }
    setPasteError('')
    const cleaned = sanitizeInput(raw)
    if (!cleaned) return
    editCurrent((chars, cursor) => ({
      chars: [...chars.slice(0, cursor), ...[...cleaned], ...chars.slice(cursor)],
      cursor: cursor + [...cleaned].length,
    }))
  }

  usePaste(insertText)

  // 对话框存活期间捕获全部按键：App 全局 handler（含 ESC 退出）一律让路
  useKeyCapture(true)
  useInput((input, key) => {
    if (picking) return
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
    // Enter 一律提交整表（与列表页「Enter = 确认」一致）。
    // 选择列表统一用 e 打开：options 为纯选择，suggestions 为可输入也可选。
    if (input === 'e' && !key.ctrl) {
      const current = fields[activeRef.current]
      const choices = current?.options ?? current?.suggestions
      if (current && choices && choices.length > 0) {
        setPicking(current)
        return
      }
    }
    if (key.return) {
      if (isFormValid(fields, valuesRef.current)) {
        onSubmit({ ...valuesRef.current })
      } else {
        setAttempted(true)
        // 跳到第一个有错误的字段，让问题就地可见
        const current = allErrors(fields, valuesRef.current)
        const firstInvalid = fields.findIndex((field) => current[field.key] !== undefined)
        if (firstInvalid >= 0) moveTo(firstInvalid)
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
    // 纯选择字段不接受自由输入；带候选项的字段中 e 打开选择列表
    const current = fields[activeRef.current]
    if (current?.options) return
    if (current?.suggestions && input === 'e') {
      setPicking(current)
      return
    }
    // 整串插入（多字符 chunk = 不带 bracketed paste 标记的粘贴 / 快速输入）
    insertText(input)
  })

  const tried = attempted
  // 居中窄卡片（spec 2026-09-13 §5.3）：min(64, max(44, width-8))；
  // 终端窄于 44 列时退化为全宽（无居中），保可用性
  // 字段多时卡片变高，收窄宽度换取纵向空间，避免撑出屏幕
  const cardWidth =
    width < 44 ? width : Math.min(fields.length > 4 ? 56 : 64, Math.max(44, width - 8))
  // 字段槽位宽：卡片 Panel 边框 2 + paddingX 2；输入盒内可用列再减槽位边框 2 + paddingX 2
  const slotWidth = Math.max(0, cardWidth - 4)
  const innerWidth = Math.max(10, cardWidth - 8)

  // 校验错误集中展示：优先当前字段，其次第一个出错字段（替代逐字段错误行）
  let shownError: string | undefined
  if (tried) {
    const activeField = fields[active]
    shownError = (activeField && errors[activeField.key]) || fields.map((f) => errors[f.key]).find(Boolean)
  }

  const renderSlotContent = (field: InputField, value: string, isActive: boolean): ReactNode => {
    if (!isActive) {
      const display = field.secret ? '*'.repeat(value.length) : value
      const optionLabel = field.options?.find((option) => option.value === value)?.label
      // 未聚焦时按显示宽度截断到一行，超长值（订阅 URL）尾部省略，避免撑高槽位
      const shown = truncateDisplay(optionLabel ?? display, innerWidth) || (field.placeholder ?? '—')
      return <Text dimColor wrap="truncate">{shown}</Text>
    }
    const display = field.secret ? '*'.repeat(value.length) : value
    const windowed = value
      ? inputWindow(display, Math.min(cursorRef.current, [...display].length), innerWidth)
      : { text: '', cursorOffset: 0 }
    const windowChars = [...windowed.text]
    const at = value ? (windowChars[windowed.cursorOffset] ?? ' ') : ' '
    const before = value ? windowChars.slice(0, windowed.cursorOffset).join('') : ''
    const after = value ? windowChars.slice(windowed.cursorOffset + 1).join('') : ''
    return (
      <Text>
        {value ? (
          <>
            {before}
            <Text inverse>{at}</Text>
            {after}
          </>
        ) : (
          <>
            <Text inverse>{' '}</Text>
            {field.options || field.suggestions ? (
              <Text dimColor>{field.options ? 'e 选择' : 'e 选择已有'}</Text>
            ) : field.placeholder ? (
              <Text dimColor>{field.placeholder}</Text>
            ) : null}
          </>
        )}
      </Text>
    )
  }

  /** 字段槽位：恒 3 行的内嵌标题 mini-Panel。聚焦 accent 亮起（invalid 转
   * danger），非聚焦/readOnly 退后为 surfaceBorder + dim。顶线复用
   * panelTopParts 的截断/宽度逻辑。marginTop 只加在首个字段之前，字段之间
   * 紧贴，保证多字段时卡片高度一致、不靠字段数撑出参差空白。 */
  const renderSlot = (field: InputField, value: string, index: number): ReactNode => {
    const isActive = index === active && !field.readOnly
    const invalid = tried && isActive && errors[field.key] !== undefined
    const borderColor = invalid ? colors.danger : isActive ? colors.accent : colors.surfaceBorder
    const labelStyle = invalid
      ? { color: colors.danger, bold: true }
      : isActive
        ? { color: colors.accent, bold: true }
        : { color: colors.muted }
    const label = field.readOnly ? `${field.label}（只读）` : field.label
    const fullTitle = field.required ? `${label} *` : label
    const parts = panelTopParts(fullTitle, slotWidth)
    // required 的 * 单独 danger 色；标题被截断（以 … 结尾）时整段按 labelStyle 渲染
    const starSuffix = field.required && parts.title.endsWith(' *')
    const labelShown = starSuffix ? parts.title.replace(/ \*$/, '') : parts.title
    return (
      <Box key={field.key} flexDirection="column" marginTop={index === 0 ? 1 : 0} width={slotWidth}>
        {slotWidth < MIN_PANEL_WIDTH ? (
          <>
            <Text {...labelStyle}>{fullTitle}</Text>
            {renderSlotContent(field, value, isActive)}
          </>
        ) : (
          <>
            <Text>
              <Text color={borderColor}>{TOP_PREFIX}</Text>
              <Text {...labelStyle}>{labelShown}</Text>
              {starSuffix ? <Text color={colors.danger}>{' *'}</Text> : null}
              <Text color={borderColor}>{parts.tail}</Text>
            </Text>
            <Box
              flexDirection="column"
              borderStyle="round"
              borderTop={false}
              borderColor={borderColor}
              paddingX={1}
            >
              {renderSlotContent(field, value, isActive)}
            </Box>
          </>
        )}
      </Box>
    )
  }

  const card = (
    <Panel title={`◆ ${title}`} width={cardWidth}>
      {fields.map((field, index) => renderSlot(field, values[field.key] ?? '', index))}
      <Box marginTop={1} flexDirection="column">
        {shownError || pasteError ? <Text color={colors.danger}>{`⚠ ${shownError || pasteError}`}</Text> : null}
        <FooterLine
          hints={[
            { key: 'Enter', label: '确认' },
            { key: '↑↓', label: '切换' },
            { key: 'ESC', label: '取消' },
          ]}
          width={cardWidth - 4}
        />
      </Box>
    </Panel>
  )

  // 选择型字段：Enter（options）或 e（suggestions）打开选项列表，选中后回填
  const pickingChoices = picking?.options ?? picking?.suggestions
  if (picking && pickingChoices) {
    return (
      <ListDialog
        borderTitle={picking.label}
        items={pickingChoices.map((option) => ({ value: option.value, label: option.label }))}
        width={cardWidth}
        onSubmit={(value) => {
          commitValues({ ...valuesRef.current, [picking.key]: value })
          setPicking(null)
        }}
        onCancel={() => setPicking(null)}
      />
    )
  }

  return width < 44 ? card : <Box justifyContent="center">{card}</Box>
}
