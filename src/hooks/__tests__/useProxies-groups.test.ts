/**
 * [1] 节点页组可见性规则的纯函数测试。
 * 白名单曾是写死的三个订阅名，导致新增订阅的机场组永远进不了 [1]；
 * 现规则：AUTO + 全部「机场-」前缀组（与 skeleton 的命名常量同源）。
 */
import { describe, expect, it } from 'vitest'
import { isPrimaryGroupName } from '../useProxies.js'
import { AIRPORT_GROUP_PREFIX } from '../../config/skeleton.js'

describe('isPrimaryGroupName', () => {
  it('AUTO 可见', () => {
    expect(isPrimaryGroupName('AUTO')).toBe(true)
  })

  it('任意机场前缀的组都可见（新增订阅自动出现，删除自动消失）', () => {
    expect(isPrimaryGroupName(`${AIRPORT_GROUP_PREFIX}jkun`)).toBe(true)
    expect(isPrimaryGroupName(`${AIRPORT_GROUP_PREFIX}sakuracat`)).toBe(true)
    expect(isPrimaryGroupName(`${AIRPORT_GROUP_PREFIX}未来的新订阅`)).toBe(true)
  })

  it('骨架里的其他组（PROXY/FALLBACK/区域组/用途组）不可见', () => {
    expect(isPrimaryGroupName('PROXY')).toBe(false)
    expect(isPrimaryGroupName('FALLBACK')).toBe(false)
    expect(isPrimaryGroupName('香港')).toBe(false)
    expect(isPrimaryGroupName('其他地区')).toBe(false)
    expect(isPrimaryGroupName('AI')).toBe(false)
    expect(isPrimaryGroupName('兜底分流')).toBe(false)
  })

  it('名字里恰好包含机场前缀但不是前缀开头的组不可见', () => {
    expect(isPrimaryGroupName(`X${AIRPORT_GROUP_PREFIX}jkun`)).toBe(false)
  })

  it('内置出口与节点名不可见', () => {
    expect(isPrimaryGroupName('DIRECT')).toBe(false)
    expect(isPrimaryGroupName('REJECT')).toBe(false)
    expect(isPrimaryGroupName('🇭🇰 香港 IEPL-01')).toBe(false)
  })
})
