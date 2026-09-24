import { describe, expect, it } from 'vitest'
import { checkProxyFile } from '../yamlFile.js'

describe('checkProxyFile 订阅文件校验', () => {
  it('空文件与合法 proxies 数组通过', () => {
    expect(checkProxyFile('').ok).toBe(true)
    expect(checkProxyFile('proxies:\n  - { name: hk-01, type: ss }\n').ok).toBe(true)
  })

  it('非法 YAML 报解析错误', () => {
    const result = checkProxyFile('proxies: [\n')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('解析失败')
  })

  it('缺少 proxies 数组被拒绝', () => {
    const result = checkProxyFile('proxy-groups: []\n')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('proxies')
  })

  it('顶层不是映射被拒绝', () => {
    expect(checkProxyFile('- just\n- a\n- list\n').ok).toBe(false)
  })
})
