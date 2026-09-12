/**
 * 通用多字段输入对话框（设计稿 5.1）。
 *
 * 键位：普通字符输入当前字段；↑↓/Tab 切换字段；Enter 当前字段合法则前进，
 * 到最后一个字段且整表合法时提交；ESC 取消。
 *
 * 补齐设计稿缺口：InputField 支持 value（初始值）与 readOnly（编辑订阅时
 * name 字段只读展示）。校验与字段推进逻辑抽为纯函数便于测试。
 *
 * 实现要点：终端一次 read 往往带来一串字符（快速打字），同一轮事件里
 * handler 会被连续调用多次 —— 因此按键处理一律读写 valuesRef/activeRef
 * （始终最新的镜像），而不能依赖 useState 闭包里的旧值，否则连环输入
 * 会互相覆盖。
 */
import { Box, Text, useInput } from 'ink'
import { useRef, useState } from 'react'

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
  const [attempted, setAttempted] = useState(false) // 只有在提交被拦后才开始逐字段标红

  const errors = allErrors(fields, values)
  const current = fields[active]

  const commitValues = (next: Record<string, string>): void => {
    valuesRef.current = next
    setValues(next)
  }
  const moveTo = (index: number): void => {
    const clamped = Math.min(fields.length - 1, Math.max(0, index))
    activeRef.current = clamped
    setActive(clamped)
  }
  const editCurrent = (map: (value: string) => string): void => {
    const field = fields[activeRef.current]
    if (!field || field.readOnly) return
    const key = field.key
    commitValues({ ...valuesRef.current, [key]: map(valuesRef.current[key] ?? '') })
  }

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
    if (key.backspace || key.delete) {
      editCurrent((value) => value.slice(0, -1))
      return
    }
    if (key.ctrl || key.meta) return
    if (input.length === 1 && input >= ' ') {
      editCurrent((value) => value + input)
    }
  })

  const tried = attempted
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
      <Text bold>{` ${title}`}</Text>
      {fields.map((field, index) => {
        const value = values[field.key] ?? ''
        const error = errors[field.key]
        const showError = tried && error !== undefined
        const isActive = index === active
        const display = field.secret
          ? '*'.repeat(value.length)
          : value || (field.placeholder ? `<${field.placeholder}>` : '')
        return (
          <Box key={field.key} flexDirection="column">
            <Text>
              <Text color={isActive ? 'cyan' : undefined}>{`${isActive ? '❯ ' : '  '}${field.label}`}</Text>
              <Text dimColor={field.readOnly} color={field.readOnly ? 'gray' : undefined}>
                {`：${display}`}
              </Text>
              {isActive && !field.readOnly ? <Text color="cyan">▏</Text> : null}
              {field.readOnly ? <Text dimColor>（只读）</Text> : null}
            </Text>
            {showError ? <Text color="red">{`    ${error}`}</Text> : null}
          </Box>
        )
      })}
      <Text dimColor>{' ↑↓/Tab 切换  Enter 确认  ESC 取消'}</Text>
    </Box>
  )
}
