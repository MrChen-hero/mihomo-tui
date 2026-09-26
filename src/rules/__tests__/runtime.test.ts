import { describe, expect, it, vi } from 'vitest'
import { HttpStatusError, KernelUnreachableError } from '../../api/client.js'
import type { RuleItem } from '../../api/types.js'
import { toggleRule } from '../runtime.js'

const initial = (): RuleItem[] => [{ index: 12, type: 'Domain', payload: 'example.com', proxy: 'DIRECT', extra: { disabled: false } }]
const disabled = (): RuleItem[] => [{ ...initial()[0]!, extra: { disabled: true } }]
const client = () => ({ rules: vi.fn().mockResolvedValueOnce(initial()).mockResolvedValue(disabled()), setRuleDisabled: vi.fn().mockResolvedValue(undefined) })

describe('运行时禁用确认', () => {
  it('使用内核索引，不使用视图行号；PATCH 后回读', async () => {
    const api = client()
    expect(await toggleRule(api, initial(), 0)).toMatchObject({ status: 'confirmed', rules: disabled() })
    expect(api.setRuleDisabled).toHaveBeenCalledExactlyOnceWith(12, true)
    expect(api.rules).toHaveBeenCalledTimes(2)
  })
  it('支持重新启用', async () => {
    const api = { rules: vi.fn().mockResolvedValueOnce(disabled()).mockResolvedValue(initial()), setRuleDisabled: vi.fn().mockResolvedValue(undefined) }
    expect((await toggleRule(api, disabled(), 0)).status).toBe('confirmed')
    expect(api.setRuleDisabled).toHaveBeenCalledWith(12, false)
  })
  it.each([{ ...initial()[0]!, index: undefined }, { ...initial()[0]!, extra: undefined }, { ...initial()[0]!, index: -1 }])('缺少能力字段只读', async (item) => {
    const api = client()
    expect((await toggleRule(api, [item], 0)).status).toBe('unsupported')
    expect(api.setRuleDisabled).not.toHaveBeenCalled()
  })
  it('列表或禁用状态改变时中止写入', async () => {
    for (const fresh of [[], disabled(), [{ ...initial()[0]!, payload: 'changed.example' }]]) {
      const api = client(); api.rules.mockReset().mockResolvedValue(fresh)
      expect((await toggleRule(api, initial(), 0)).status).toBe('stale')
      expect(api.setRuleDisabled).not.toHaveBeenCalled()
    }
  })
  it.each([404, 405])('%s 降级', async (status) => {
    const api = client(); api.setRuleDisabled.mockRejectedValue(new HttpStatusError(status, '/rules/disable', 'unsupported'))
    expect((await toggleRule(api, initial(), 0)).status).toBe('unsupported')
  })
  it.each([401, 403, 500])('%s 保留错误，不降级', async (status) => {
    const api = client(); api.setRuleDisabled.mockRejectedValue(new HttpStatusError(status, '/rules/disable', 'failed'))
    await expect(toggleRule(api, initial(), 0)).rejects.toMatchObject({ status })
  })
  it('PATCH 断连不能确定是否写入，不重试', async () => {
    const api = client(); api.setRuleDisabled.mockRejectedValue(new KernelUnreachableError('test'))
    expect((await toggleRule(api, initial(), 0)).status).toBe('unconfirmed')
    expect(api.setRuleDisabled).toHaveBeenCalledTimes(1)
  })
  it('预检失败原样抛出，未写入', async () => {
    const api = client(); api.rules.mockReset().mockRejectedValue(new KernelUnreachableError('test'))
    await expect(toggleRule(api, initial(), 0)).rejects.toBeInstanceOf(KernelUnreachableError)
    expect(api.setRuleDisabled).not.toHaveBeenCalled()
  })
  it('回读失败、序列改变或状态未改变均不报告成功', async () => {
    for (const after of [initial(), [], null]) {
      const api = client(); api.rules.mockReset().mockResolvedValueOnce(initial())
      if (after) api.rules.mockResolvedValueOnce(after)
      else api.rules.mockRejectedValueOnce(new Error('read failed'))
      expect((await toggleRule(api, initial(), 0)).status).toBe('unconfirmed')
      expect(api.setRuleDisabled).toHaveBeenCalledTimes(1)
    }
  })
})
