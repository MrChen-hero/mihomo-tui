/**
 * MihomoClient 测试：本地 node:http 服务器充当假内核，
 * 验证方法→路径/方法/请求体的映射与三类错误分类。全程无真实 mihomo。
 */
import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  ApiBusinessError,
  HttpStatusError,
  KernelUnreachableError,
  MihomoClient,
} from '../client.js'
import type { AppConfig } from '../../config.js'

const SECRET = 'test-secret'

interface CapturedRequest {
  method: string
  url: string
  authorization?: string
  contentType?: string
  body: string
}

let server: Server
let port = 0
let last: CapturedRequest | undefined

/** 每个用例自带的路由表：exact match "METHOD /path" → [status, body] */
let routes: Map<string, [number, string]>
const defaultRoutes = (): Map<string, [number, string]> =>
  new Map([
    ['GET /version', [200, JSON.stringify({ meta: 'mihomo', version: 'v1.19.24' })]],
    [
      'GET /providers/proxies',
      [
        200,
        JSON.stringify({
          providers: {
            alpha: {
              name: 'alpha',
              vehicleType: 'HTTP',
              proxies: [{ name: 'HK-1', type: 'Shadowsocks', alive: true, history: [] }],
            },
            default: { name: 'default', vehicleType: 'Compatible', proxies: [] },
          },
        }),
      ],
    ],
    ['PUT /proxies/%E9%A6%99%E6%B8%AF', [204, '']],
    ['DELETE /proxies/gp', [204, '']],
    ['PATCH /configs', [204, '']],
    ['GET /proxies/%E9%A6%99%E6%B8%AF/delay', [200, JSON.stringify({ delay: 233 })]],
    ['GET /proxies/bad/delay', [503, JSON.stringify({ message: 'An error occurred in the delay test' })]],
    ['GET /proxies/boom', [500, 'boom']],
    ['PUT /providers/proxies/alpha', [204, '']],
    [
      'GET /rules',
      [
        200,
        JSON.stringify({
          rules: [{ type: 'DOMAIN', payload: 'example.com', proxy: 'DIRECT' }],
        }),
      ],
    ],
    [
      'GET /providers/rules',
      [
        200,
        JSON.stringify({
          providers: {
            OpenAI: { name: 'OpenAI', vehicleType: 'HTTP', behavior: 'Classical', ruleCount: 12 },
          },
        }),
      ],
    ],
    ['PUT /providers/rules/AI%2FSearch', [204, '']],
  ])

beforeAll(async () => {
  routes = defaultRoutes()
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      last = {
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      }
      // /proxies/locked 是鉴权哨兵：secret 不对直接 401
      if (req.url === '/proxies/locked' && req.headers.authorization !== `Bearer ${SECRET}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'Unauthorized' }))
        return
      }
      // 路由按「方法 + 纯路径」匹配，query 不参与
      const hit = routes.get(`${req.method} ${req.url?.split('?')[0] ?? ''}`)
      if (hit) {
        res.writeHead(hit[0], { 'content-type': 'application/json' })
        res.end(hit[1])
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address && typeof address === 'object') port = address.port
})

afterAll(() => {
  server.closeAllConnections()
  return new Promise<void>((resolve) => server.close(() => resolve()))
})

afterEach(() => {
  routes = defaultRoutes()
})

function makeClient(overrides: Partial<AppConfig> = {}): MihomoClient {
  const config: AppConfig = {
    api: `http://127.0.0.1:${port}`,
    secret: SECRET,
    mihomoDir: '/tmp/unused',
    testUrl: 'https://test/generate_204',
    testTimeout: 5000,
    delayThresholds: { good: 300, fair: 800 },
    ...overrides,
  }
  return new MihomoClient(config)
}

describe('只读方法', () => {
  it('version() 返回解析后的对象', async () => {
    const client = makeClient()
    await expect(client.version()).resolves.toEqual({ meta: 'mihomo', version: 'v1.19.24' })
    expect(last?.method).toBe('GET')
    expect(last?.url).toBe('/version')
  })

  it('providers() 返回 providers 映射', async () => {
    const providers = await makeClient().providers()
    expect(Object.keys(providers)).toEqual(['alpha', 'default'])
    expect(providers['alpha']?.vehicleType).toBe('HTTP')
  })

  it('配置了 secret 时携带 Bearer 头', async () => {
    await makeClient().version()
    expect(last?.authorization).toBe(`Bearer ${SECRET}`)
  })

  it('secret 为空时不带 Authorization 头', async () => {
    await makeClient({ secret: '' }).version()
    expect(last?.authorization).toBeUndefined()
  })
})

describe('运行时写操作（不触碰配置文件）', () => {
  it('禁用接口使用内核零基索引，读取保留原始类型和扩展字段', async () => {
    const rule = { index: 12, type: 'DomainSuffix', payload: 'example.com', proxy: 'DIRECT', size: -1, extra: { disabled: false, hitCount: 4 } }
    routes.set('GET /rules', [200, JSON.stringify({ rules: [rule] })])
    routes.set('PATCH /rules/disable', [204, ''])
    expect(await makeClient().rules()).toEqual([rule])
    await makeClient().setRuleDisabled(12, true)
    expect(last).toMatchObject({ method: 'PATCH', url: '/rules/disable', body: '{"12":true}' })
    expect(() => makeClient().setRuleDisabled(-1, true)).toThrow('非负整数')
  })

  it('405 即使有 JSON message 仍保留 HTTP 状态用于能力降级', async () => {
    routes.set('PATCH /rules/disable', [405, '{"message":"unsupported"}'])
    await expect(makeClient().setRuleDisabled(0, true)).rejects.toMatchObject({ status: 405 })
  })
  it('selectProxy 用 PUT + JSON body，路径段做 URI 编码', async () => {
    await makeClient().selectProxy('香港', 'HK-1')
    expect(last?.method).toBe('PUT')
    expect(last?.url).toBe('/proxies/%E9%A6%99%E6%B8%AF')
    expect(last?.body).toBe(JSON.stringify({ name: 'HK-1' }))
    expect(last?.contentType).toBe('application/json')
  })

  it('unfixProxy 用 DELETE', async () => {
    await makeClient().unfixProxy('gp')
    expect(last?.method).toBe('DELETE')
  })

  it('setMode 用 PATCH /configs', async () => {
    await makeClient().setMode('global')
    expect(last?.method).toBe('PATCH')
    expect(last?.url).toBe('/configs')
    expect(last?.body).toBe(JSON.stringify({ mode: 'global' }))
  })

  it('testProxyDelay 带上 url 与 timeout 查询参数', async () => {
    const result = await makeClient({ testTimeout: 1234 }).testProxyDelay('香港')
    expect(result).toEqual({ delay: 233 })
    expect(last?.url).toBe('/proxies/%E9%A6%99%E6%B8%AF/delay?url=https%3A%2F%2Ftest%2Fgenerate_204&timeout=1234')
  })

  it('updateProvider 用 PUT /providers/proxies/{name}', async () => {
    await makeClient().updateProvider('alpha')
    expect(last?.method).toBe('PUT')
    expect(last?.url).toBe('/providers/proxies/alpha')
  })

  it('rules() 返回规则数组', async () => {
    const rules = await makeClient().rules()
    expect(rules).toEqual([{ type: 'DOMAIN', payload: 'example.com', proxy: 'DIRECT' }])
    expect(last?.url).toBe('/rules')
  })

  it('ruleProviders() 返回规则集映射', async () => {
    const providers = await makeClient().ruleProviders()
    expect(providers['OpenAI']?.ruleCount).toBe(12)
    expect(last?.url).toBe('/providers/rules')
  })

  it('updateRuleProvider 用 PUT 且对名称做 URI 编码', async () => {
    await makeClient().updateRuleProvider('AI/Search')
    expect(last?.method).toBe('PUT')
    expect(last?.url).toBe('/providers/rules/AI%2FSearch')
  })
})

describe('错误分类', () => {
  it('401 归入 HttpStatusError（调用方配置问题）', async () => {
    const err = await makeClient({ secret: 'wrong-secret' })
      .proxy('locked')
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(HttpStatusError)
    expect((err as HttpStatusError).status).toBe(401)
  })

  it('404 归入 HttpStatusError 并携带路径', async () => {
    const err = await makeClient()
      .proxy('nonexistent')
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(HttpStatusError)
    expect((err as HttpStatusError).status).toBe(404)
    expect((err as HttpStatusError).path).toBe('/proxies/nonexistent')
  })

  it('503 + message 归入 ApiBusinessError（节点不可用是正常结果）', async () => {
    const err = await makeClient()
      .testProxyDelay('bad')
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(ApiBusinessError)
    expect((err as ApiBusinessError).message).toBe('An error occurred in the delay test')
  })

  it('非 JSON 错误体回退为原文截断', async () => {
    const err = await makeClient()
      .proxy('boom')
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(HttpStatusError)
    expect((err as HttpStatusError).body).toBe('boom')
  })

  it('连接拒绝 → KernelUnreachableError', async () => {
    // 先占住一个端口再关掉，得到一个确定无人监听的端口
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const deadPort = (probe.address() as { port: number }).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    const err = await makeClient({ api: `http://127.0.0.1:${deadPort}` })
      .version()
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(KernelUnreachableError)
    expect((err as KernelUnreachableError).api).toBe(`http://127.0.0.1:${deadPort}`)
  })
})

describe('URL 拼装', () => {
  it('api 尾部斜杠被剥掉', () => {
    const client = makeClient({ api: `http://127.0.0.1:${port}///` })
    expect(client.api).toBe(`http://127.0.0.1:${port}`)
  })

  it('wsUrl 把 http 转 ws，secret 以 token 参数传递', () => {
    const url = new URL(makeClient().wsUrl('/traffic'))
    expect(url.protocol).toBe('ws:')
    expect(url.searchParams.get('token')).toBe(SECRET)
  })

  it('secret 为空时 wsUrl 不带 token', () => {
    const url = new URL(makeClient({ secret: '' }).wsUrl('/traffic'))
    expect(url.searchParams.has('token')).toBe(false)
  })

  it('logsUrl 附带 level', () => {
    const url = new URL(makeClient().logsUrl('debug'))
    expect(url.pathname).toBe('/logs')
    expect(url.searchParams.get('level')).toBe('debug')
  })
})
