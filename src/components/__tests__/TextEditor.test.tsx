import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { TextEditor } from '../TextEditor.js'
import { createTerminal, delay, textOf } from './harness.js'

function mount(props: Partial<React.ComponentProps<typeof TextEditor>> = {}) {
  const onSave = vi.fn()
  const onCancel = vi.fn()
  const terminal = createTerminal(
    createElement(TextEditor, {
      title: 'edit',
      initialText: 'hello',
      height: 12,
      width: 40,
      onSave,
      onCancel,
      ...props,
    }),
    { columns: 60, rows: 20 },
  )
  return { terminal, onSave, onCancel }
}

describe('TextEditor 视图', () => {
  it('渲染初始文本与行号', async () => {
    const { terminal } = mount()
    await delay()
    const text = textOf(terminal.frames())
    expect(text).toContain('hello')
    expect(text).toContain('Ctrl-S 保存')
    terminal.instance.unmount()
  })

  it('Ctrl-S 触发保存并传出编辑后的文本', async () => {
    const { terminal, onSave } = mount()
    await delay()
    terminal.press('!')
    await delay()
    terminal.press('\x13') // Ctrl-S
    await delay()
    expect(onSave).toHaveBeenCalledWith('!hello')
    terminal.instance.unmount()
  })

  it('校验失败时不保存并显示错误', async () => {
    const { terminal, onSave } = mount({ validate: () => '格式错误' })
    await delay()
    terminal.press('\x13')
    await delay()
    expect(onSave).not.toHaveBeenCalled()
    expect(textOf(terminal.frames())).toContain('格式错误')
    terminal.instance.unmount()
  })

  it('ESC 在未修改时直接放弃', async () => {
    const { terminal, onCancel } = mount()
    await delay()
    terminal.press('\x1B')
    await delay()
    expect(onCancel).toHaveBeenCalled()
    terminal.instance.unmount()
  })

  it('ESC 在有未保存修改时先弹确认，n 取消确认回到编辑', async () => {
    const { terminal, onCancel } = mount()
    await delay()
    terminal.press('x')
    await delay()
    terminal.press('\x1B')
    await delay()
    expect(textOf(terminal.frames())).toContain('放弃未保存的修改')
    expect(onCancel).not.toHaveBeenCalled()
    terminal.press('n')
    await delay()
    expect(onCancel).not.toHaveBeenCalled()
    expect(textOf(terminal.frames())).toContain('Ctrl-S 保存')
    terminal.instance.unmount()
  })

  it('确认放弃后才退出', async () => {
    const { terminal, onCancel } = mount()
    await delay()
    terminal.press('x')
    await delay()
    terminal.press('\x1B')
    await delay()
    terminal.press('y')
    await delay()
    expect(onCancel).toHaveBeenCalled()
    terminal.instance.unmount()
  })
})
