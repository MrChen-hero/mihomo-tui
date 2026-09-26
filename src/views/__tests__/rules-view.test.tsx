import { afterEach, describe, expect, it, vi } from 'vitest'
import { RulesView } from '../Rules.js'
import { DEFAULT_CONFIG } from '../../config.js'
import type { RuleItem } from '../../api/types.js'
import { HttpStatusError } from '../../api/client.js'
import { createTerminal, delay, textOf, type Terminal } from '../../components/__tests__/harness.js'
import { keysCaptured } from '../../ui/keyCapture.js'
import { displayWidth } from '../../commands/output.js'

const rules: RuleItem[] = [
  { index: 0, type: 'Domain', payload: 'example.com', proxy: 'DIRECT', extra: { disabled: false } },
  { index: 1, type: 'RuleSet', payload: 'remote-set', proxy: 'PROXY', extra: { disabled: false } },
  { index: 2, type: 'Match', payload: '', proxy: 'FALLBACK', extra: { disabled: false } },
]
const terminals: Terminal[] = []
afterEach(() => { for (const term of terminals.splice(0)) term.instance.unmount() })
function setup(options: { width?: number; items?: RuleItem[]; ruleError?: Error; providerError?: Error } = {}) {
  let data = structuredClone(options.items ?? rules)
  const api = {
    rules: vi.fn(async () => { if (options.ruleError) throw options.ruleError; return structuredClone(data) }),
    ruleProviders: vi.fn(async () => {
      if (options.providerError) throw options.providerError
      return { 'remote-set': { name: 'remote-set', vehicleType: 'HTTP', ruleCount: 12, updatedAt: new Date().toISOString() } }
    }),
    updateRuleProvider: vi.fn(async () => {}),
    setRuleDisabled: vi.fn(async (index: number, disabled: boolean) => {
      data = data.map((item) => item.index === index ? { ...item, extra: { disabled } } : item)
    }),
  }
  const onMessage = vi.fn()
  const width = options.width ?? 100
  const term = createTerminal(<RulesView config={DEFAULT_CONFIG} client={api} height={24} width={width} active onMessage={onMessage} />, { columns: width })
  terminals.push(term)
  return { term, api, onMessage, setRules: (next: RuleItem[]) => { data = next } }
}
const press = async (term: Terminal, key: string) => { term.press(key); await delay(80) }
const tail = (term: Terminal, start: number) => textOf(term.frames().slice(start))

describe('规则页', () => {
  it('展示规范类型、规则集数量与更新时间；详情只为 RuleSet 显示来源', async () => {
    const { term } = setup(); await delay(100)
    expect(textOf(term.frames())).toContain('DOMAIN example.com')
    expect(textOf(term.frames())).toContain('12 条')
    expect(textOf(term.frames())).toContain('s 前')
    let start = term.frames().length
    await press(term, '\r')
    expect(tail(term, start)).toContain('内容：example.com')
    expect(tail(term, start)).not.toContain('来源规则集')
    expect(keysCaptured()).toBe(true)
    await press(term, '\x1b')
    expect(keysCaptured()).toBe(false)
    await press(term, 'j'); start = term.frames().length
    await press(term, '\r')
    expect(tail(term, start)).toContain('来源规则集：remote-set')
  })
  it('类型筛选后测试仍使用全部规则，并清除筛选定位命中', async () => {
    const { term } = setup(); await delay(100)
    await press(term, 'l'); await press(term, 'l') // RULE-SET
    await press(term, 't'); await press(term, 'example.com')
    const start = term.frames().length
    await press(term, '\r')
    expect(tail(term, start)).toContain('本地命中 #1')
    expect(tail(term, start)).toContain('类型 全部')
    expect(tail(term, start)).toContain('非最终节点')
  })
  it('遇到 RuleSet 提示无法判定，不宣告 MATCH 命中', async () => {
    const { term } = setup(); await delay(100)
    await press(term, 't'); await press(term, 'other.example')
    const start = term.frames().length
    await press(term, '\r')
    expect(tail(term, start)).toContain('需内核判定')
    expect(tail(term, start)).not.toContain('本地命中')
  })
  it('关键字过滤与 ESC 返回', async () => {
    const { term } = setup(); await delay(100)
    await press(term, '/'); await press(term, 'example')
    await press(term, '\r')
    expect(textOf(term.frames())).toContain('类型 全部 · example')
    await press(term, '/')
    expect(keysCaptured()).toBe(true)
    await press(term, '\x1b')
    expect(keysCaptured()).toBe(false)
  })
  it('禁用/启用使用真实索引且确认状态', async () => {
    const { term, api, onMessage } = setup(); await delay(100)
    await press(term, 'd')
    expect(api.setRuleDisabled).toHaveBeenCalledWith(0, true)
    expect(onMessage).toHaveBeenLastCalledWith(expect.stringContaining('已确认规则临时禁用'))
    await press(term, 'd')
    expect(api.setRuleDisabled).toHaveBeenLastCalledWith(0, false)
  })
  it('缺字段仅标记，不发送 PATCH；序列变化清除标记', async () => {
    const { term, api, setRules, onMessage } = setup({ items: [{ type: 'Domain', payload: 'example.com', proxy: 'DIRECT' }] })
    await delay(100); await press(term, 'd'); await press(term, 'm')
    expect(api.setRuleDisabled).not.toHaveBeenCalled()
    expect(onMessage).toHaveBeenLastCalledWith('仅本地标记，不影响内核分流或规则测试')
    expect(textOf(term.frames())).toContain('[标记]')
    await press(term, 't'); await press(term, 'example.com'); await press(term, '\r')
    expect(textOf(term.frames())).toContain('本地命中 #1')
    setRules([{ type: 'Match', payload: '', proxy: 'DIRECT' }])
    const start = term.frames().length
    await press(term, 'r')
    const latest = textOf(term.frames()).split('╭─ 规则 · ').at(-1) ?? ''
    expect(latest).not.toContain('[标记]')
  })
  it('405 降级本地标记，401 显示错误', async () => {
    const { term, api, onMessage } = setup(); await delay(100)
    api.setRuleDisabled.mockRejectedValueOnce(new HttpStatusError(401, '/rules/disable', 'Unauthorized'))
    await press(term, 'd')
    expect(onMessage).toHaveBeenLastCalledWith(expect.stringContaining('操作失败'))
    api.setRuleDisabled.mockRejectedValueOnce(new HttpStatusError(405, '/rules/disable', 'unsupported'))
    await press(term, 'd'); await press(term, 'm')
    expect(onMessage).toHaveBeenLastCalledWith('仅本地标记，不影响内核分流或规则测试')
  })
  it('规则集加载失败时仍显示规则；规则接口缺失时仍可更新规则集', async () => {
    const first = setup({ providerError: new Error('provider unavailable') }); await delay(100)
    expect(textOf(first.term.frames())).toContain('example.com')
    expect(textOf(first.term.frames())).toContain('规则集加载失败')
    first.term.instance.unmount()
    const second = setup({ ruleError: new HttpStatusError(404, '/rules', '') }); await delay(100)
    expect(textOf(second.term.frames())).toContain('内核不支持规则接口')
    await press(second.term, 'u')
    expect(second.api.updateRuleProvider).toHaveBeenCalledExactlyOnceWith('remote-set')
    await press(second.term, 't')
    expect(second.onMessage).toHaveBeenLastCalledWith('规则尚未就绪，请先刷新')
  })
  it('规则集更新失败显示错误，更新期间不重复提交', async () => {
    const { term, api, onMessage } = setup({ items: [] }); await delay(100)
    let reject!: (reason: Error) => void
    api.updateRuleProvider.mockImplementationOnce(() => new Promise<void>((_resolve, no) => { reject = no }))
    await press(term, 'u'); await press(term, 'u')
    expect(api.updateRuleProvider).toHaveBeenCalledTimes(1)
    reject(new Error('update failed')); await delay(100)
    expect(onMessage).toHaveBeenLastCalledWith('更新失败：update failed')
  })
  it('40 列窄屏列表按显示宽度裁剪，空列表安全响应导航', async () => {
    const { term } = setup({ width: 40 }); await delay(100)
    const lines = textOf(term.frames()).split('\n').filter((line) => line.includes('example.com') || line.includes('remote-set'))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((line) => displayWidth(line) <= 40)).toBe(true)
    term.instance.unmount()
    const empty = setup({ items: [], providerError: new Error('none') }); await delay(100)
    await press(empty.term, 'j'); await press(empty.term, '\r'); await press(empty.term, 'd')
    expect(empty.api.setRuleDisabled).not.toHaveBeenCalled()
  })
})
