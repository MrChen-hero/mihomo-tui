import { describe, expect, it } from 'vitest'
import { preserveLegacyRelayGroups } from '../preserveGroups.js'

describe('旧 relay 配置保留边界', () => {
  const generated = [{ name: 'AUTO', type: 'url-test' }, { name: 'PROXY', type: 'select' }]
  it('非数组配置直接返回生成结果', () => {
    expect(preserveLegacyRelayGroups(generated, undefined)).toBe(generated)
  })
  it('同名保留用户原组与未知字段，不改动输入', () => {
    const legacy = { name: 'AUTO', type: 'relay', proxies: ['one', 'two'], hidden: true, custom: { key: 'value' } }
    expect(preserveLegacyRelayGroups(generated, [legacy, null, 'bad', { type: 'relay' }])).toEqual([generated[1], legacy])
    expect(generated).toHaveLength(2)
  })
  it('不静默删除格式不合法的命名 relay，由内核校验拒绝', () => {
    const legacy = { name: 'old', type: 'relay', proxies: [42] }
    expect(preserveLegacyRelayGroups(generated, [legacy])).toContainEqual(legacy)
  })
})
