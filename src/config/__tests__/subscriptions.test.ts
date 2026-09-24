import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isDuplicateName,
  loadSubscriptions,
  prefixFromName,
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
  it('接受合法的最小条目（无前缀），缺省 type 为 remote', () => {
    const result = validateSubscription({ name: 'alpha', url: GOOD_URL })
    expect(result).toEqual({ ok: true, data: { name: 'alpha', type: 'remote', url: GOOD_URL } })
  })

  it('带前缀时保留前缀；空前缀视为无前缀', () => {
    expect(validateSubscription({ name: 'a', url: GOOD_URL, prefix: '[Y] ' }).ok).toBe(true)
    const empty = validateSubscription({ name: 'a', url: GOOD_URL, prefix: '' })
    expect(empty.ok && empty.data).toEqual({ name: 'a', type: 'remote', url: GOOD_URL })
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

  it('group：合法保留、空白归一为空、非法拒绝', () => {
    const ok = validateSubscription({ name: 'a', url: GOOD_URL, group: '香港专线' })
    expect(ok.ok && ok.data.group).toBe('香港专线')
    const blank = validateSubscription({ name: 'a', url: GOOD_URL, group: '   ' })
    expect(blank.ok && blank.data.group).toBeUndefined()
    expect(validateSubscription({ name: 'a', url: GOOD_URL, group: 'a'.repeat(17) }).ok).toBe(false)
    expect(validateSubscription({ name: 'a', url: GOOD_URL, group: 'bad\nname' }).ok).toBe(false)
    expect(validateSubscription({ name: 'a', url: GOOD_URL, group: 7 }).ok).toBe(false)
  })

  it('interval：分钟数保留，0 与空视为禁用，超范围拒绝', () => {
    const ok = validateSubscription({ name: 'a', url: GOOD_URL, interval: 30 })
    expect(ok.ok && ok.data.interval).toBe(30)
    const zero = validateSubscription({ name: 'a', url: GOOD_URL, interval: 0 })
    expect(zero.ok && zero.data.interval).toBeUndefined()
    expect(validateSubscription({ name: 'a', url: GOOD_URL, interval: -1 }).ok).toBe(false)
    expect(validateSubscription({ name: 'a', url: GOOD_URL, interval: 43_201 }).ok).toBe(false)
    expect(validateSubscription({ name: 'a', url: GOOD_URL, interval: 1.5 }).ok).toBe(false)
  })

  it('local 类型不需要 URL，且不能带 URL', () => {
    const ok = validateSubscription({ name: 'mylocal', type: 'local' })
    expect(ok.ok && ok.data).toEqual({ name: 'mylocal', type: 'local' })
    expect(validateSubscription({ name: 'mylocal', type: 'local', url: GOOD_URL }).ok).toBe(false)
    expect(validateSubscription({ name: 'a', type: 'remote' }).ok).toBe(false)
  })

  it('locked 只对 remote 生效', () => {
    const remote = validateSubscription({ name: 'a', url: GOOD_URL, locked: true })
    expect(remote.ok && remote.data.locked).toBe(true)
    const local = validateSubscription({ name: 'a', type: 'local', locked: true })
    expect(local.ok && local.data.locked).toBeUndefined()
  })

  it('旧清单（无 type 字段）读取为 remote', () => {
    const path = tempSubsFile({ subscriptions: [{ name: 'alpha', url: GOOD_URL }] })
    const subs = loadSubscriptions(path)
    expect(subs[0]).toMatchObject({ name: 'alpha', type: 'remote', url: GOOD_URL })
  })
})

describe('prefixFromName 前缀派生', () => {
  it('取首个字母大写', () => {
    expect(prefixFromName('yuetoto')).toBe('[Y] ')
    expect(prefixFromName('ax-hk')).toBe('[A] ')
  })

  it('不含字母时用 [-]', () => {
    expect(prefixFromName('123node')).toBe('[-] ')
    expect(prefixFromName('-backup')).toBe('[-] ')
  })
})

describe('isDuplicateName 重名判断', () => {
  const subs = [
    { name: 'alpha', type: 'remote', url: GOOD_URL },
    { name: 'beta', type: 'remote', url: GOOD_URL },
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
    const subs = [{ name: 'alpha', type: 'remote' as const, url: GOOD_URL, prefix: '[A] ' }]
    saveSubscriptions(subs, path)
    const text = readFileSync(path, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toEqual({ subscriptions: subs })
    expect(loadSubscriptions(path)).toEqual(subs)
  })

  it('不留下 .tmp 残留文件', () => {
    const path = tempSubsFile(undefined)
    saveSubscriptions([{ name: 'a', type: 'remote', url: GOOD_URL }], path)
    expect(existsSync(path)).toBe(true)
    expect(readdirSync(dirname(path)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('目录不存在时自动创建', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mihomo-tui-subs-')), 'deep', 'subs.json')
    saveSubscriptions([{ name: 'a', type: 'remote', url: GOOD_URL }], path)
    expect(existsSync(path)).toBe(true)
  })
})
