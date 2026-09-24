import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InputDialog,
  allErrors,
  inputWindow,
  isFormValid,
  sanitizeInput,
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

// 键位原始字节：ESC / TAB / 回车 / 退格 / 上下箭头 / Home / End
const ESC = '\x1B'
const TAB = '\t'
const RETURN = '\r'
const BACKSPACE = '\u007F'
const UP = '\x1B[A'
const DOWN = '\x1B[B'
const LEFT = '\x1B[D'
const HOME = '\x1B[H'
const END = '\x1B[F'
const CTRL_A = '\u0001'
const CTRL_E = '\u0005'
const CTRL_U = '\u0015'
const CTRL_W = '\u0017'
// bracketed paste 标记包裹的整串粘贴
const pasteChunk = (text: string): string => `\x1B[200~${text}\x1B[201~`

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

  it('sanitizeInput 剥离控制字符，保留可打印与中文/emoji', () => {
    expect(sanitizeInput('https://a.com/sub\n\ttoken=1')).toBe('https://a.com/subtoken=1')
    expect(sanitizeInput('前缀 🇭🇰')).toBe('前缀 🇭🇰')
    expect(sanitizeInput('a\u007fb')).toBe('ab')
  })

  it('inputWindow：短值原样返回、光标偏移正确', () => {
    expect(inputWindow('abc', 1, 10)).toEqual({ text: 'abc', cursorOffset: 1 })
    // 光标在末尾（虚拟空位）
    expect(inputWindow('abc', 3, 10)).toEqual({ text: 'abc', cursorOffset: 3 })
  })

  it('inputWindow：超长值开窗后光标始终可见，两侧以 … 标记', () => {
    const url = 'https://example.com/very/long/subscription/path?token=abcdef'
    const max = 20
    // 光标在末尾：末尾可见
    const tail = inputWindow(url, url.length, max)
    expect(tail.text.endsWith('abcdef')).toBe(true)
    expect(tail.text.startsWith('…')).toBe(true)
    expect([...tail.text].reduce((sum, ch) => sum + 1, 0)).toBeLessThanOrEqual(max)
    // 把光标移回行首：开头可见
    const head = inputWindow(url, 0, max)
    expect(head.text.startsWith('https://')).toBe(true)
    expect(head.text.endsWith('…')).toBe(true)
  })

  it('inputWindow：按显示宽度开窗，中文不会被切成两列', () => {
    const value = '一二三四五六七八九十'
    const max = 8
    const result = inputWindow(value, 5, max) // 光标在「六」前
    expect(result.text).toContain('六')
    // 窗口文本的显示宽度不超过 max（不含指示符单独计算时的边界抖动）
    const width = [...result.text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0)
    expect(width).toBeLessThanOrEqual(max + 2)
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
    expect(text).toContain('my-airport')
    expect(text).toContain('ESC 取消')
    // 槽位范式：字段标题内嵌槽位顶线（无 ❯ 前缀），非聚焦字段同样有框
    expect(text).toContain('╭─ 订阅名称')
    expect(text).toContain('╭─ 订阅 URL')
    expect(text).toContain('Enter')
    expect(text).toContain('确认')
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

  it('退格删除光标前一个字符', async () => {
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
    terminal.press('a')
    terminal.press('b')
    terminal.press(BACKSPACE) // "ab" → "a"，光标在末尾
    terminal.press(RETURN)
    await delay()
    expect(onSubmit).toHaveBeenCalledWith({ name: 'a' })
  })

  it('整串粘贴（bracketed paste）插入当前字段，换行被剥离', async () => {
    const onSubmit = vi.fn()
    const terminal = mount(
      <InputDialog
        title="添加订阅"
        fields={[{ label: '订阅 URL', key: 'url', required: true }]}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    await delay()
    terminal.press(pasteChunk('https://example.com/sub?token=xyz'))
    await delay()
    terminal.press(RETURN)
    await delay()
    expect(onSubmit).toHaveBeenCalledWith({ url: 'https://example.com/sub?token=xyz' })
  })

  it('多行粘贴只保留可打印内容（换行/制表剥离）', async () => {
    const onSubmit = vi.fn()
    const terminal = mount(
      <InputDialog
        title="添加订阅"
        fields={[{ label: '订阅 URL', key: 'url', required: true }]}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    await delay()
    terminal.press(pasteChunk('https://a.example/\n\tsub?x=1'))
    await delay()
    terminal.press(RETURN)
    await delay()
    expect(onSubmit).toHaveBeenCalledWith({ url: 'https://a.example/sub?x=1' })
  })

  it('兜底：不支持 bracketed paste 的终端整串到达时也能完整插入', async () => {
    const onSubmit = vi.fn()
    const terminal = mount(
      <InputDialog
        title="添加订阅"
        fields={[{ label: '订阅 URL', key: 'url', required: true }]}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    await delay()
    terminal.press('https://legacy.example/sub') // 无标记的多字符 chunk
    await delay()
    terminal.press(RETURN)
    await delay()
    expect(onSubmit).toHaveBeenCalledWith({ url: 'https://legacy.example/sub' })
  })

  it('←→ 移动光标后插入落在光标处', async () => {
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
    for (const char of 'abcd') terminal.press(char)
    terminal.press(LEFT) // 光标到 d 前
    terminal.press('X') // "abcXd"
    terminal.press(RETURN)
    await delay()
    expect(onSubmit).toHaveBeenCalledWith({ name: 'abcXd' })
  })

  it('Ctrl+W 向前删一个词', async () => {
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
    for (const char of 'foo bar') terminal.press(char)
    terminal.press(CTRL_W) // 删 "bar" → "foo "
    terminal.press(RETURN)
    await delay()
    expect(onSubmit).toHaveBeenCalledWith({ name: 'foo ' })
  })

  it('Ctrl+U 清空整行', async () => {
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
    for (const char of 'junk') terminal.press(char)
    terminal.press(CTRL_U)
    terminal.press(RETURN)
    await delay()
    expect(onSubmit).toHaveBeenCalledWith({ name: '' })
  })

  it('Home/End 与 Ctrl+A/E 把光标移到行首/行尾', async () => {
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
    for (const char of 'def') terminal.press(char)
    terminal.press(CTRL_A)
    terminal.press('a') // 行首插入 → "adef"
    terminal.press(END)
    terminal.press('z') // 行尾插入 → "adefz"
    terminal.press(HOME)
    terminal.press('0') // "0adefz"
    terminal.press(CTRL_E)
    terminal.press(RETURN)
    await delay()
    expect(onSubmit).toHaveBeenCalledWith({ name: '0adefz' })
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
    expect(textOf(terminal.frames()).indexOf('╭─ 订阅 URL')).toBeGreaterThan(-1)

    terminal.press(UP) // 回到 name
    await delay()
    for (const char of 'c d') terminal.press(char) // "abc d" 含空格 → 非法
    terminal.press(RETURN) // 拦截
    await delay()
    expect(textOf(terminal.frames())).toContain('名称只能包含字母数字与 -_')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('错误集中展示：当前字段合法时回退显示首个出错字段', async () => {
    const onSubmit = vi.fn()
    const terminal = mount(
      <InputDialog title="添加订阅" fields={[NAME_FIELD, URL_FIELD]} onSubmit={onSubmit} onCancel={() => {}} />,
    )
    await delay()
    terminal.press('a')
    terminal.press(RETURN) // name 填好后前进到 url（此时 name 合法）
    await delay()
    terminal.press(RETURN) // url 为空：提交拦截，tried=true
    await delay()
    const beforeUp = terminal.frames().length
    terminal.press(UP) // 回到合法的 name 字段：错误只能靠回退分支（首个出错字段）浮出
    await delay()
    // 只看 UP 之后的增量帧：错误行若因回退分支被删而消失，这里会转红
    const tail = textOf(terminal.frames().slice(beforeUp))
    expect(tail).toContain('⚠ 订阅 URL不能为空') // validateField 内建必填文案：`${label}不能为空`
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
        message={['确认删除 alpha？', '此操作不可撤销！']}
        danger
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    await delay()
    const text = textOf(terminal.frames())
    expect(text).toContain('确认删除 alpha？')
    expect(text).toContain('此操作不可撤销！')
    expect(text).toContain('y 确认')
    expect(text).toContain('n/Esc 取消')

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
      <ConfirmDialog message="ok?" onConfirm={onConfirm} onCancel={onCancel} />,
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
    expect(progressBar(0, 10)).toBe('[----------]')
    expect(progressBar(0.5, 10)).toBe('[#####-----]')
    expect(progressBar(1, 10)).toBe('[##########]')
    expect(progressBar(2, 4)).toBe('[####]')
    expect(progressBar(-1, 4)).toBe('[----]')
  })

  it('progressPercent 边界', () => {
    expect(progressPercent(0, 7)).toBe(0)
    expect(progressPercent(3, 7)).toBe(43)
    expect(progressPercent(7, 7)).toBe(100)
    expect(progressPercent(0, 0)).toBe(100)
  })
})
