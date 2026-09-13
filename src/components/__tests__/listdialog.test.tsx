import { afterEach, describe, expect, it, vi } from 'vitest'
import { ListDialog, nextSelectable, windowStart, type ListItem } from '../ListDialog.js'
import { createTerminal, delay, textOf } from './harness.js'

const ESC = '\x1B'
const RETURN = '\r'
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

const ITEMS: ListItem[] = [
  { label: '稳定版', section: true },
  { value: 'v1.19.30', label: 'v1.19.30', hint: '2026-09-01' },
  { value: 'v1.19.24', label: 'v1.19.24', hint: '当前' },
  { label: 'Alpha', section: true },
  { value: 'alpha', label: 'Alpha 最新' },
]

describe('ListDialog 纯逻辑', () => {
  it('nextSelectable：跳过分组头，端点返回 null', () => {
    expect(nextSelectable(ITEMS, -1, 1)).toBe(1)
    expect(nextSelectable(ITEMS, 1, 1)).toBe(2)
    expect(nextSelectable(ITEMS, 2, 1)).toBe(4) // 跳过 Alpha 分组头
    expect(nextSelectable(ITEMS, 4, 1)).toBeNull()
    expect(nextSelectable(ITEMS, 4, -1)).toBe(2)
    expect(nextSelectable(ITEMS, 1, -1)).toBeNull()
  })

  it('windowStart：条目不超窗时归零，超窗时光标保持可见', () => {
    const many: ListItem[] = Array.from({ length: 20 }, (_, i) => ({ value: String(i), label: String(i) }))
    expect(windowStart(3, many, 12)).toBe(0)
    expect(windowStart(5, many, 12)).toBe(0)
    expect(windowStart(9, many, 12)).toBe(3)
    expect(windowStart(19, many, 12)).toBe(8)
    expect(windowStart(2, ITEMS, 12)).toBe(0)
  })
})

describe('ListDialog 交互', () => {
  it('渲染分组头与条目，光标落在首个可选条目', async () => {
    const terminal = mount(
      <ListDialog borderTitle="切换版本" items={ITEMS} onSubmit={() => {}} onCancel={() => {}} />,
    )
    await delay()
    const text = textOf(terminal.frames())
    expect(text).toContain('╭─ 切换版本')
    expect(text).toContain('稳定版')
    expect(text).toContain('v1.19.30')
    expect(text).toContain('2026-09-01')
    expect(text).toContain('当前')
    expect(text).toContain('❯ v1.19.30')
  })

  it('↑↓ 跳过分组头，Enter 提交选中值，ESC 取消', async () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const terminal = mount(
      <ListDialog borderTitle="t" items={ITEMS} onSubmit={onSubmit} onCancel={onCancel} />,
    )
    await delay()
    terminal.press(DOWN) // v1.19.30 → v1.19.24
    await delay()
    expect(textOf(terminal.frames())).toContain('❯ v1.19.24')
    terminal.press(RETURN)
    await delay()
    expect(onSubmit).toHaveBeenCalledWith('v1.19.24')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('ESC 触发取消', async () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const terminal = mount(
      <ListDialog borderTitle="t" items={ITEMS} onSubmit={onSubmit} onCancel={onCancel} />,
    )
    await delay()
    terminal.press(ESC)
    await delay()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('光标在端点继续同方向移动时原地不动（无循环）', async () => {
    const onSubmit = vi.fn()
    const terminal = mount(
      <ListDialog borderTitle="t" items={ITEMS} onSubmit={onSubmit} onCancel={() => {}} />,
    )
    await delay()
    terminal.press(UP) // 已在第一个可选条目
    await delay()
    expect(textOf(terminal.frames())).toContain('❯ v1.19.30')
  })

  it('条目超窗时按光标开窗，全量条目仍可选', async () => {
    const many: ListItem[] = [
      { label: '全部版本', section: true },
      ...Array.from({ length: 20 }, (_, i) => ({ value: `v0.${i}`, label: `v0.${i}` })),
    ]
    const onSubmit = vi.fn()
    const terminal = mount(
      <ListDialog borderTitle="t" items={many} maxVisible={8} onSubmit={onSubmit} onCancel={() => {}} />,
    )
    await delay()
    // 20 次向下移到最后一项（开窗跟随）
    for (let i = 0; i < 20; i += 1) terminal.press(DOWN)
    await delay()
    terminal.press(RETURN)
    await delay()
    expect(onSubmit).toHaveBeenCalledWith('v0.19')
  })
})
