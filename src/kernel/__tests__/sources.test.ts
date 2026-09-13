/**
 * 内核下载源与镜像回退的单测（spec settings-kernel §3.3）：全部 mock fetch，
 * 零真实网络。覆盖源解析的角色能力过滤、锁定模式、自定义前缀与逐源回退。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  SOURCES,
  SourceError,
  assetDownloadUrl,
  fetchJsonThrough,
  resolveSources,
} from '../sources.js'

const OK_JSON = { hello: 'world' }

/** 按前缀命中返回成功的 mock fetch；miss 全部抛网络错误 */
function fetchByPrefix(successPrefix: string): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith(successPrefix)) {
      return new Response(JSON.stringify(OK_JSON), {
        status: 200,
        headers: { 'content-length': String(JSON.stringify(OK_JSON).length) },
      })
    }
    throw new TypeError('fetch failed (stub)')
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('resolveSources 源解析', () => {
  it('auto：API 角色跳过 ghfast.top（不代理 API），下载角色保留全部', () => {
    const api = resolveSources(undefined, 'api')
    expect(api.map((source) => source.id)).toEqual(['direct', 'gh-proxy.com'])
    const dl = resolveSources(undefined, 'dl')
    expect(dl.map((source) => source.id)).toEqual(['direct', 'gh-proxy.com', 'ghfast.top'])
  })

  it('锁定单一源：direct 只含直连；失败不静默回退', () => {
    expect(resolveSources({ mode: 'direct' }, 'dl').map((s) => s.id)).toEqual(['direct'])
    expect(resolveSources({ mode: 'ghfast.top' }, 'dl').map((s) => s.id)).toEqual(['ghfast.top'])
    // ghfast.top 不代理 API：锁定它请求 API 直接报错
    expect(() => resolveSources({ mode: 'ghfast.top' }, 'api')).toThrow(SourceError)
  })

  it('custom：使用自定义前缀；未配置抛错', () => {
    const custom = resolveSources({ mode: 'custom', customPrefix: 'https://m.example/' }, 'api')
    expect(custom).toHaveLength(1)
    expect(custom[0]?.prefix).toBe('https://m.example/')
    expect(() => resolveSources({ mode: 'custom' }, 'dl')).toThrow(/未配置/)
  })

  it('SOURCES 直连源前缀为空串', () => {
    expect(SOURCES[0]?.id).toBe('direct')
    expect(SOURCES[0]?.prefix).toBe('')
  })
})

describe('fetchJsonThrough 镜像回退', () => {
  it('直连成功：返回数据与来源 direct', async () => {
    const { fetchImpl, calls } = fetchByPrefix('')
    const { data, source } = await fetchJsonThrough<typeof OK_JSON>('/releases?per_page=1', {
      fetchImpl,
    })
    expect(data).toEqual(OK_JSON)
    expect(source).toBe('direct')
    expect(calls[0]).toContain('https://api.github.com/repos/MetaCubeX/mihomo/releases')
  })

  it('直连网络失败回退 gh-proxy.com；auto 的 API 角色不试 ghfast.top', async () => {
    const { fetchImpl, calls } = fetchByPrefix('https://gh-proxy.com/')
    const { source } = await fetchJsonThrough('/x', { fetchImpl })
    expect(source).toBe('gh-proxy.com')
    expect(calls).toHaveLength(2)
    expect(calls.some((url) => url.startsWith('https://ghfast.top/'))).toBe(false)
  })

  it('全部源失败抛 SourceError 并携带各源失败原因', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(fetchJsonThrough('/x', { fetchImpl })).rejects.toThrow(SourceError)
    try {
      await fetchJsonThrough('/x', { fetchImpl })
    } catch (err) {
      expect((err as SourceError).attempts).toHaveLength(2)
    }
  })

  it('HTTP 错误视为该源失败并回退到下一源', async () => {
    const calls: string[] = []
    let attempt = 0
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input))
      attempt += 1
      if (attempt === 1) return new Response('no', { status: 403 })
      return new Response(JSON.stringify(OK_JSON), { status: 200 })
    }) as unknown as typeof fetch
    const { source } = await fetchJsonThrough('/x', { fetchImpl })
    expect(source).toBe('gh-proxy.com')
    expect(calls).toHaveLength(2)
  })

  it('超限响应视为该源失败：API 角色全部失败时抛 SourceError', async () => {
    const fetchImpl = (async () =>
      new Response('x'.repeat(4 * 1024 * 1024 + 1), { status: 200 })) as unknown as typeof fetch
    try {
      await fetchJsonThrough('/x', { fetchImpl })
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SourceError)
      expect((err as SourceError).attempts).toHaveLength(2)
    }
  })

  it('assetDownloadUrl 按规则拼装下载地址', () => {
    expect(assetDownloadUrl('v1.19.30', 'mihomo-linux-amd64-v1.19.30.gz')).toBe(
      'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.30/mihomo-linux-amd64-v1.19.30.gz',
    )
  })

  it('锁定模式失败不回退（用户意图优先）：只尝试锁定源一次', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    try {
      await fetchJsonThrough('/x', { fetchImpl, sourceConfig: { mode: 'direct' } })
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SourceError)
      // 只有 direct 一个源被尝试，没有静默回退到镜像
      expect((err as SourceError).attempts).toHaveLength(1)
      expect((err as SourceError).attempts[0]?.startsWith('direct:')).toBe(true)
    }
  })
})
