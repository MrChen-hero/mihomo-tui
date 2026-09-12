/**
 * config.ts 的测试全部走 tmpdir 注入路径 —— 绝不读写真实的 ~/.config/mihomo-tui/。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, loadConfig } from '../config.js'

function tempFile(content?: string): string {
  const dir = mkdtemp()
  const path = join(dir, 'config.json')
  if (content !== undefined) writeFileSync(path, content, 'utf8')
  return path
}

function mkdtemp(): string {
  return mkdtempSync(join(tmpdir(), 'mihomo-tui-test-'))
}

describe('loadConfig 文件缺失', () => {
  it('返回默认值并生成默认配置文件', () => {
    const path = tempFile()
    expect(loadConfig(path)).toEqual(DEFAULT_CONFIG)
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(DEFAULT_CONFIG)
  })

  it('目录不存在时递归创建', () => {
    const path = join(mkdtemp(), 'nested', 'deeper', 'config.json')
    expect(loadConfig(path)).toEqual(DEFAULT_CONFIG)
    expect(existsSync(path)).toBe(true)
  })
})

describe('loadConfig 内容容错', () => {
  it('坏 JSON 回退默认值，且不覆盖原文件', () => {
    const broken = 'not json {{{'
    const path = tempFile(broken)
    expect(loadConfig(path)).toEqual(DEFAULT_CONFIG)
    expect(readFileSync(path, 'utf8')).toBe(broken)
  })

  it('JSON 数组（非对象）回退默认值', () => {
    expect(loadConfig(tempFile('[]'))).toEqual(DEFAULT_CONFIG)
  })

  it('部分字段合法时与默认值合并', () => {
    const path = tempFile(JSON.stringify({ api: 'http://10.0.0.1:9090///' }))
    const config = loadConfig(path)
    expect(config.api).toBe('http://10.0.0.1:9090')
    expect(config.secret).toBe(DEFAULT_CONFIG.secret)
    expect(config.testUrl).toBe(DEFAULT_CONFIG.testUrl)
    expect(config.testTimeout).toBe(DEFAULT_CONFIG.testTimeout)
    expect(config.delayThresholds).toEqual(DEFAULT_CONFIG.delayThresholds)
  })

  it('非法字段的类型逐个回退默认值，不整体崩掉', () => {
    const path = tempFile(
      JSON.stringify({
        api: 42,
        secret: null,
        testTimeout: -5,
        delayThresholds: { good: 'x', fair: 0 },
      }),
    )
    const config = loadConfig(path)
    expect(config.api).toBe(DEFAULT_CONFIG.api)
    expect(config.secret).toBe(DEFAULT_CONFIG.secret)
    expect(config.testTimeout).toBe(DEFAULT_CONFIG.testTimeout)
    expect(config.delayThresholds).toEqual(DEFAULT_CONFIG.delayThresholds)
  })

  it('合法的 secret 为空串时保留空串（本机约定）', () => {
    const path = tempFile(JSON.stringify({ secret: '' }))
    expect(loadConfig(path).secret).toBe('')
  })
})

describe('loadConfig 非 ENOENT 读取错误', () => {
  it('路径是目录时抛出异常而不是吞掉', () => {
    const dir = mkdtemp()
    expect(() => loadConfig(dir)).toThrow()
  })
})
