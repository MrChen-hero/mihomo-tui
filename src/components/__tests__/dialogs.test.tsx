import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InputDialog,
  allErrors,
  isFormValid,
  validateField,
  type InputField,
} from '../InputDialog.js'
import { ConfirmDialog } from '../ConfirmDialog.js'
import {
  ProgressDialog,
  progressBar,
  progressPercent,
} from '../ProgressDialog.js'
import { createTerminal, delay, textOf } from './harness.js'

// 键位原始字节：ESC / TAB / 回车 / 退格 / 上下箭头
const ESC = '\x1B'
const TAB = '\t'
const RETURN = '\r'
const BACKSPACE = '\u007F'
const UP = '\x1B[A'
const DOWN = '\x1B[B'

const rendered: { cleanup: () => void }[] = []
afterEach(() => {
  for (const item of rendered.splice(0)) item.cleanup()
})

function mount(element: React.ReactElement) {
  const terminal = createTerminal(element)
  rendered.push({ cleanup: () => terminal.instance.unmount() })
  return terminal
}

const NAME_FIELD: InputField = {
  label: '订阅名称',
  key: 'name',
  required: true,
  validate: (value) => (/^[a-z0-9_-]+$/i.test(value) ? undefined : '名称只能包含字母数字与 -_'),
}
const URL_FIELD: InputField = { label: '订阅 URL', key: 'url', required: true }

describe('InputDialog 纯逻辑', () => {
  it('validateField：required 空值报错、validate 报错、readOnly 恒通过', () => {
    expect(validateField(NAME_FIELD, '')).toContain('不能为空')
    expect(validateField(NAME_FIELD, 'a b')).toBe('名称只能包含字母数字与 -_')
    expect(validateField(NAME_FIELD, 'alpha')).toBeUndefined()
    expect(validateField({ label: 'x', key: 'x' }, '')).toBeUndefined()
    expect(validateField({ label: 'x', key: 'x', readOnly: true }, 'whatever')).toBeUndefined()
  })

  it('allErrors / isFormValid', () => {
    const fields = [NAME_FIELD, URL_FIELD]
    const errors = allErrors(fields, { name: 'a b', url: '' })
    expect(errors['name']).toBeTruthy()
    expect(errors['url']).toContain('不能为空')
    expect(isFormValid(fields, { name: 'alpha', url: 'https://x' })).toBe(true)
    expect(isFormValid(fields, { name: 'alpha', url: '' })).toBe(false)
  })
})

describe('InputDialog 渲染与交互', () => {
  it('渲染标题、字段与占位符', async () => {
    const terminal = mount(
      <InputDialog
        title="添加订阅"
        fields={[
          { label: '订阅名称', key: 'name', placeholder: 'my-airport' },
          { label: '订阅 URL', key: 'url' },
        ]}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    )
    await delay()
    const text = textOf(terminal.frames())
    expect(text).toContain('添加订阅')
    expect(text).toContain('订阅名称')
    expect(text).toContain('<my-airport>')
    expect(text).toContain('ESC 取消')
  })

  it('键入追加到当前字段；secret 字段以 * 回显', async () => {
    const terminal = mount(
      <InputDialog
        title="添加订阅"
        fields={[{ label: 'Token', key: 'token', secret: true }]}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    )
    await delay()
    for (const char of 'abc') terminal.press(char)
    await delay()
    const text = textOf(terminal.frames())
    expect(text).toContain('***')
    expect(text).not.toContain('abc')
  })

  it('退格删除最后一个字符', async () => {
    const terminal = mount(
      <InputDialog
        title="添加订阅"
        fields={[{ label: '订阅名称', key: 'name' }]}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    )
    await delay()
    terminal.press('a')
    terminal.press('b')
    terminal.press(BACKSPACE)
    await delay()
    expect(textOf(terminal.frames())).toContain('：a')
  })

  it('回归：同一轮事件里连续按键不丢字（快速打字/整串粘贴场景）', async () => {
    const onSubmit = vi.fn()
    const terminal = mount(
      <InputDialog
        title="添加订阅"
        fields={[{ label: '订阅名称', key: 'name' }]}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    await delay()
    // 不加任何间隔地连按 —— 真实终端一次 read 常带回一串字符
    for (const char of 'alphabeta') terminal.press(char)
    terminal.press(RETURN)
    await delay()
    expect(onSubmit).toHaveBeenCalledWith({ name: 'alphabeta' })
  })

  it('ESC 取消、Enter 提交合法表单并携带全部值', async () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const terminal = mount(
      <InputDialog
        title="添加订阅"
        fields={[NAME_FIELD, URL_FIELD]}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    )
    await delay()
    for (const char of 'alpha') terminal.press(char)
    terminal.press(RETURN) // name 合法 → 前进
    await delay()
    for (const char of 'https://x.example/sub') terminal.press(char)
    terminal.press(RETURN) // 最后一个字段 → 提交
    await delay()
    expect(onSubmit).toHaveBeenCalledWith({ name: 'alpha', url: 'https://x.example/sub' })

    terminal.press(ESC)
    await delay()
    expect(onCancel).toHaveBeenCalled()
  })

  it('非法值时 Enter 提交被拦且错误可见；箭头键切换字段', async () => {
    const onSubmit = vi.fn()
    const terminal = mount(
      <InputDialog title="添加订阅" fields={[NAME_FIELD, URL_FIELD]} onSubmit={onSubmit} onCancel={() => {}} />,
    )
    await delay()
    terminal.press('a')
    terminal.press('b') // "ab" 合法
    terminal.press(RETURN) // 前进到 url
    await delay()
    expect(textOf(terminal.frames()).indexOf('❯ 订阅 URL')).toBeGreaterThan(-1)

    terminal.press(UP) // 回到 name
    await delay()
    for (const char of 'c d') terminal.press(char) // "abc d" 含空格 → 非法
    terminal.press(RETURN) // 拦截
    await delay()
    expect(textOf(terminal.frames())).toContain('名称只能包含字母数字与 -_')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('readOnly 字段不接收输入，Enter 正常前进', async () => {
    const onSubmit = vi.fn()
    const terminal = mount(
      <InputDialog
        title="编辑订阅"
        fields={[
          { label: '订阅名称', key: 'name', readOnly: true, value: 'alpha' },
          { label: '节点名前缀', key: 'prefix', value: '[A] ' },
        ]}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    await delay()
    terminal.press('X') // 只读字段应忽略
    terminal.press(RETURN) // 从只读字段前进
    await delay()
    terminal.press(RETURN) // 前缀为空 → 提交？前缀无 required → 合法
    await delay()
    expect(onSubmit).toHaveBeenCalledWith({ name: 'alpha', prefix: '[A] ' })
    const text = textOf(terminal.frames())
    expect(text).toContain('（只读）')
    // 只读字段吞掉的 X 不能出现在 name 的值里
    expect(text).not.toContain('alphaX')
  })
})

describe('ConfirmDialog', () => {
  it('y 确认 / n 与 ESC 取消 / 多行消息与 danger 渲染', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const terminal = mount(
      <ConfirmDialog
        title="删除订阅"
        message={['将删除：alpha', '此操作不可撤销！']}
        danger
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    await delay()
    const text = textOf(terminal.frames())
    expect(text).toContain('删除订阅')
    expect(text).toContain('此操作不可撤销！')
    expect(text).toContain('y 确认')

    terminal.press('n')
    await delay()
    expect(onCancel).toHaveBeenCalledTimes(1)

    terminal.press('y')
    await delay()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('ESC 也走取消路径', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const terminal = mount(
      <ConfirmDialog title="确认" message="ok?" onConfirm={onConfirm} onCancel={onCancel} />,
    )
    await delay()
    terminal.press(ESC)
    await delay()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('ProgressDialog', () => {
  it('渲染步骤计数、百分比条与已完成清单', async () => {
    const terminal = mount(
      <ProgressDialog
        title="添加订阅"
        current="重启服务"
        total={7}
        step={5}
        completed={['校验输入', '更新订阅清单']}
      />,
    )
    await delay()
    const text = textOf(terminal.frames())
    expect(text).toContain('[6/7]')
    expect(text).toContain('重启服务')
    expect(text).toContain('✓ 校验输入')
    expect(text).not.toContain('ESC 取消')
  })

  it('cancelable 时 ESC 触发 onCancel，否则忽略', async () => {
    const onCancel = vi.fn()
    const terminal = mount(
      <ProgressDialog
        title="添加订阅"
        current="x"
        total={2}
        step={0}
        cancelable
        onCancel={onCancel}
      />,
    )
    await delay()
    terminal.press(ESC)
    await delay()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('进度条纯函数', () => {
  it('progressBar 按比例填充并可钳制', () => {
    expect(progressBar(0, 10)).toBe('[░░░░░░░░░░]')
    expect(progressBar(0.5, 10)).toBe('[█████░░░░░]')
    expect(progressBar(1, 10)).toBe('[██████████]')
    expect(progressBar(2, 4)).toBe('[████]')
    expect(progressBar(-1, 4)).toBe('[░░░░]')
  })

  it('progressPercent 边界', () => {
    expect(progressPercent(0, 7)).toBe(0)
    expect(progressPercent(3, 7)).toBe(43)
    expect(progressPercent(7, 7)).toBe(100)
    expect(progressPercent(0, 0)).toBe(100)
  })
})
