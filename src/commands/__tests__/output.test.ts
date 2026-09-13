import { describe, expect, it } from 'vitest'
import {
  EXIT,
  displayWidth,
  fitDisplay,
  formatBytes,
  formatRelativeTime,
  padDisplay,
  redactUrl,
  renderTable,
  truncateDisplay,
} from '../output.js'

describe('EXIT 退出码约定', () => {
  it('固定为 0/1/2/3', () => {
    expect(EXIT).toEqual({ ok: 0, error: 1, usage: 2, unreachable: 3 })
  })
})

describe('redactUrl 订阅链接脱敏', () => {
  it('query 中的 token 参数被替换，普通参数保留', () => {
    expect(redactUrl('https://example.com/sub?token=abc123&days=3')).toBe(
      'https://example.com/sub?token=<REDACTED>&days=3',
    )
  })

  it('键名不含 token 但值形如长十六进制串时也要脱敏', () => {
    expect(redactUrl('https://example.com/sub?OwO=0123456789abcdef0123456789abcdef')).toBe(
      'https://example.com/sub?OwO=<REDACTED>',
    )
  })

  it('键名不含 token 但值形如 uuid 时也要脱敏', () => {
    expect(redactUrl('https://example.com/sub?tag=0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0')).toBe(
      'https://example.com/sub?tag=<REDACTED>',
    )
  })

  it('键名不含 token 但值形如长 base64 时也要脱敏', () => {
    expect(redactUrl('https://example.com/sub?tag=abcdefghijklmnopqrstuvwxyz')).toBe(
      'https://example.com/sub?tag=<REDACTED>',
    )
  })

  it('路径式 token（十六进制段）被替换', () => {
    expect(
      redactUrl('https://example.com/api/v1/client/subscribe/0123456789abcdef0123456789abcdef'),
    ).toBe('https://example.com/api/v1/client/subscribe/<REDACTED>')
  })

  it('路径式 token（uuid 段）被替换', () => {
    expect(
      redactUrl('https://example.com/api/v1/client/subscribe/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'),
    ).toBe('https://example.com/api/v1/client/subscribe/<REDACTED>')
  })

  it('普通路径段不被误伤', () => {
    expect(redactUrl('https://example.com/api/v1/client/subscribe')).toBe(
      'https://example.com/api/v1/client/subscribe',
    )
  })

  it('无参数的普通 URL 原样返回', () => {
    expect(redactUrl('https://example.com/sub')).toBe('https://example.com/sub')
  })

  it('短 query 值不脱敏', () => {
    expect(redactUrl('https://example.com/sub?days=3&level=1')).toBe(
      'https://example.com/sub?days=3&level=1',
    )
  })

  it('非法 URL 与空串原样返回，不抛异常', () => {
    expect(redactUrl('not a url')).toBe('not a url')
    expect(redactUrl('')).toBe('')
  })
})

describe('displayWidth CJK 与 emoji 显示宽度', () => {
  it('空串为 0，ASCII 为 1', () => {
    expect(displayWidth('')).toBe(0)
    expect(displayWidth('abc')).toBe(3)
  })

  it('中日韩字符占两列', () => {
    expect(displayWidth('中文')).toBe(4)
    expect(displayWidth('a中b文')).toBe(6)
    expect(displayWidth('한국')).toBe(4)
  })

  it('emoji 占两列', () => {
    expect(displayWidth('👍')).toBe(2)
  })

  it('区域指示符按最坏情况各计 2（国旗合计 4，防终端渲染分歧折行）', () => {
    expect(displayWidth('🇨🇳')).toBe(4)
  })

  it('变体选择符不占宽', () => {
    expect(displayWidth('✔️')).toBe(1)
  })
})

describe('padDisplay 按显示宽度补齐', () => {
  it('补空格到目标列数', () => {
    expect(padDisplay('ab', 5)).toBe('ab   ')
    expect(padDisplay('中', 4)).toBe('中  ')
  })

  it('超宽不截断', () => {
    expect(padDisplay('中文', 3)).toBe('中文')
  })
})

describe('truncateDisplay 按显示宽度截断', () => {
  it('未超宽原样返回', () => {
    expect(truncateDisplay('ab', 4)).toBe('ab')
    expect(truncateDisplay('中文', 4)).toBe('中文')
  })

  it('超宽以 … 结尾且不把列宽撑破', () => {
    expect(truncateDisplay('abcdef', 4)).toBe('abc…')
    expect(displayWidth(truncateDisplay('abcdef', 4))).toBe(4)
  })

  it('宽字符宁可留少也不越界', () => {
    expect(truncateDisplay('中文中文', 4)).toBe('中…')
  })

  it('max 为 0 返回空串', () => {
    expect(truncateDisplay('abc', 0)).toBe('')
  })
})

describe('fitDisplay 先截断再补齐', () => {
  it('恒定占 width 列', () => {
    expect(fitDisplay('ab', 4)).toBe('ab  ')
    expect(displayWidth(fitDisplay('abcdef', 4))).toBe(4)
  })
})

describe('renderTable 表格对齐', () => {
  it('按显示宽度对齐，列间两空格', () => {
    expect(renderTable(['NAME', 'VAL'], [['a', 'b'], ['ccc', 'd']])).toBe(
      ['NAME  VAL', 'a     b', 'ccc   d'].join('\n'),
    )
  })

  it('最后一列不补空格，便于 grep', () => {
    expect(renderTable(['A'], [['longvalue']])).toBe(['A', 'longvalue'].join('\n'))
    expect(renderTable(['A'], [['x']])).toBe(['A', 'x'].join('\n'))
  })

  it('中英文混排不错位', () => {
    expect(renderTable(['节点'], [['香港']])).toBe('节点\n香港')
  })
})

describe('formatBytes 字节数格式化', () => {
  it('非法输入返回 ---', () => {
    expect(formatBytes(-1)).toBe('---')
    expect(formatBytes(Number.NaN)).toBe('---')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('---')
  })

  it('KB 以下取整', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(5)).toBe('5 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('进位后保留两位小数', () => {
    expect(formatBytes(1024)).toBe('1.00 KB')
    expect(formatBytes(1536)).toBe('1.50 KB')
    expect(formatBytes(1024 ** 2)).toBe('1.00 MB')
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.50 GB')
  })

  it('整百取整', () => {
    expect(formatBytes(100 * 1024)).toBe('100 KB')
  })
})

describe('formatRelativeTime 相对时间', () => {
  it('缺失或非法返回 ---', () => {
    expect(formatRelativeTime(undefined)).toBe('---')
    expect(formatRelativeTime('not-a-date')).toBe('---')
  })

  it('未来时间显示「刚刚」', () => {
    expect(formatRelativeTime(new Date(Date.now() + 60_000).toISOString())).toBe('刚刚')
  })

  it('各区间格式正确', () => {
    expect(formatRelativeTime(new Date(Date.now() - 30_000).toISOString())).toBe('30s 前')
    expect(formatRelativeTime(new Date(Date.now() - 90_000).toISOString())).toBe('1m 前')
    expect(formatRelativeTime(new Date(Date.now() - 2 * 3600_000).toISOString())).toBe('2h 前')
    expect(formatRelativeTime(new Date(Date.now() - 3 * 86400_000).toISOString())).toBe('3d 前')
  })
})
