import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isDuplicateName,
  loadSubscriptions,
  saveSubscriptions,
  validateSubscription,
} from '../subscriptions.js'

const GOOD_URL = 'https://airport.example.com/sub?token=0123456789abcdef'

function tempSubsFile(entries: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'mihomo-tui-subs-'))
  const path = join(dir, 'subscriptions.json')
  if (entries !== undefined) writeFileSync(path, JSON.stringify(entries), 'utf8')
  return path
}

describe('validateSubscription 校验规则', () => {
  it('接受合法的最小条目（无前缀）', () => {
    const result = validateSubscription({ name: 'alpha', url: GOOD_URL })
    expect(result).toEqual({ ok: true, data: { name: 'alpha', url: GOOD_URL } })
  })

  it('带前缀时保留前缀；空前缀视为无前缀', () => {
    expect(validateSubscription({ name: 'a', url: GOOD_URL, prefix: '[Y] ' }).ok).toBe(true)
    const empty = validateSubscription({ name: 'a', url: GOOD_URL, prefix: '' })
    expect(empty.ok && empty.data).toEqual({ name: 'a', url: GOOD_URL })
  })

  it('拒绝空名、超长名、非法字符名', () => {
    for (const name of ['', '   ', 'x'.repeat(33), '有 空 格', '中文名', 'a/b']) {
      const result = validateSubscription({ name, url: GOOD_URL })
      expect(result.ok).toBe(false)
    }
    expect(
      validateSubscription({ name: 'x'.repeat(33), url: GOOD_URL }),
    ).toMatchObject({ error: expect.stringContaining('32') })
    expect(validateSubscription({ name: 'a b', url: GOOD_URL })).toMatchObject({
      error: expect.stringContaining('字母数字'),
    })
  })

  it('拒绝空 URL、非 http(s)、不可解析、超长 URL', () => {
    expect(validateSubscription({ name: 'a', url: '' }).ok).toBe(false)
    expect(validateSubscription({ name: 'a', url: 'ftp://x' }).ok).toBe(false)
    expect(validateSubscription({ name: 'a', url: 'not a url' }).ok).toBe(false)
    expect(validateSubscription({ name: 'a', url: `https://x/${'a'.repeat(2100)}` }).ok).toBe(false)
    expect(validateSubscription({ name: 'a', url: 'https://x' }).ok).toBe(true)
  })

  it('拒绝超过 10 字符的前缀', () => {
    expect(validateSubscription({ name: 'a', url: GOOD_URL, prefix: 'x'.repeat(11) }).ok).toBe(false)
    expect(validateSubscription({ name: 'a', url: GOOD_URL, prefix: 'x'.repeat(10) }).ok).toBe(true)
  })

  it('非字符串字段类型直接拒绝', () => {
    expect(validateSubscription({ name: 42, url: GOOD_URL }).ok).toBe(false)
    expect(validateSubscription({ name: 'a', url: 42 }).ok).toBe(false)
    expect(validateSubscription({ name: 'a', url: GOOD_URL, prefix: 7 }).ok).toBe(false)
  })
})

describe('isDuplicateName 重名判断', () => {
  const subs = [
    { name: 'alpha', url: GOOD_URL },
    { name: 'beta', url: GOOD_URL },
  ]
  it('同名（含大小写变体）判重', () => {
    expect(isDuplicateName('alpha', subs)).toBe(true)
    expect(isDuplicateName('ALPHA', subs)).toBe(true)
    expect(isDuplicateName('gamma', subs)).toBe(false)
  })
})

describe('loadSubscriptions 读取与容错', () => {
  it('文件缺失时抛错并提示格式', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mihomo-tui-subs-')), 'nope.json')
    expect(() => loadSubscriptions(path)).toThrow(/找不到订阅清单/)
  })

  it('坏 JSON 抛错', () => {
    const path = tempSubsFile(undefined)
    writeFileSync(path, '{broken', 'utf8')
    expect(() => loadSubscriptions(path)).toThrow(/不是合法 JSON/)
  })

  it('空清单与非对象清单抛错', () => {
    expect(() => loadSubscriptions(tempSubsFile({ subscriptions: [] }))).toThrow(/订阅清单为空/)
    expect(() => loadSubscriptions(tempSubsFile({}))).toThrow(/订阅清单为空/)
  })

  it('条目缺 url 或名称非法时抛错，且错误信息不含 URL（防 token 泄漏）', () => {
    const path = tempSubsFile({ subscriptions: [{ name: 'alpha' }] })
    try {
      loadSubscriptions(path)
      expect.unreachable('应当抛错')
    } catch (err) {
      expect((err as Error).message).not.toContain('TOKENVALUE')
      expect((err as Error).message).toContain('alpha')
    }
  })

  it('合法清单按名称排序返回', () => {
    const path = tempSubsFile({
      subscriptions: [
        { name: 'beta', url: GOOD_URL },
        { name: 'alpha', url: GOOD_URL, prefix: '[A] ' },
      ],
    })
    const subs = loadSubscriptions(path)
    expect(subs.map((sub) => sub.name)).toEqual(['alpha', 'beta'])
    expect(subs[0]?.prefix).toBe('[A] ')
  })
})

describe('saveSubscriptions 原子写', () => {
  it('写入两空格缩进 JSON + 末尾换行，并能读回', () => {
    const path = tempSubsFile(undefined)
    const subs = [{ name: 'alpha', url: GOOD_URL, prefix: '[A] ' }]
    saveSubscriptions(subs, path)
    const text = readFileSync(path, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toEqual({ subscriptions: subs })
    expect(loadSubscriptions(path)).toEqual(subs)
  })

  it('不留下 .tmp 残留文件', () => {
    const path = tempSubsFile(undefined)
    saveSubscriptions([{ name: 'a', url: GOOD_URL }], path)
    expect(existsSync(path)).toBe(true)
    expect(readdirSync(dirname(path)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('目录不存在时自动创建', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mihomo-tui-subs-')), 'deep', 'subs.json')
    saveSubscriptions([{ name: 'a', url: GOOD_URL }], path)
    expect(existsSync(path)).toBe(true)
  })
})
