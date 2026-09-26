/** 启动真实 CLI 入口；临时用户目录和假内核避免访问生产配置。 */
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const fixture = [
  { index: 0, type: 'Domain', payload: 'first.example', proxy: 'DIRECT', extra: { disabled: false } },
  { index: 1, type: 'DomainSuffix', payload: 'example.com', proxy: 'PROXY', extra: { disabled: false } },
  { index: 2, type: 'RuleSet', payload: 'remote', proxy: 'REJECT', extra: { disabled: false } },
]
let server: Server
let api = ''
let testHome = ''
let status = 200
let updated = false
let requestedRules = 0

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'rules-cli-'))
  mkdirSync(join(testHome, '.config/mihomo-tui'), { recursive: true })
  writeFileSync(join(testHome, '.config/mihomo-tui/config.json'), '{}')
  server = createServer((req, res) => {
    if (status !== 200) { res.writeHead(status); res.end('{"message":"failed"}'); return }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/rules') { requestedRules++; res.end(JSON.stringify({ rules: fixture })) }
    else if (req.url === '/providers/rules') res.end(JSON.stringify({ providers: { 'remote/中文': { name: 'remote/中文', vehicleType: 'HTTP', ruleCount: 2 } } }))
    else if (req.method === 'PUT' && req.url === '/providers/rules/remote%2F%E4%B8%AD%E6%96%87') { updated = true; res.writeHead(204); res.end() }
    else { res.writeHead(404); res.end() }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  api = 'http://127.0.0.1:' + (server.address() as { port: number }).port
})
beforeEach(() => { status = 200; updated = false; requestedRules = 0 })
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(testHome, { recursive: true, force: true })
})

function run(args: string[], endpoint = api): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli.tsx', '--api', endpoint, ...args], {
      cwd: root, env: { ...process.env, HOME: testHome }, timeout: 10000,
    }, (err, stdout, stderr) => {
      resolve({ code: typeof err?.code === 'number' ? err.code : err ? -1 : 0, stdout, stderr })
    })
  })
}

describe('规则 CLI 真实入口', () => {
  it.each(['DomainSuffix', 'DOMAIN-SUFFIX'])('类型 %s 的 JSON 保留内核字段', async (type) => {
    const result = await run(['rules', 'ls', '--type', type, '--json'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([fixture[1]])
    expect(result.stderr).toBe('')
  })
  it('文本筛选保持原始序号与状态', async () => {
    const result = await run(['rules', 'ls', '--type', 'DomainSuffix'])
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/2\s+DOMAIN-SUFFIX/)
    expect(result.stdout).toContain('启用')
  })
  it.each([['a.example.com', 'hit', 2], ['unknown.example', 'unsupported', 3]])('测试 %s', async (target, outcome, index) => {
    const result = await run(['rules', 'test', String(target), '--json'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ target, outcome, index })
  })
  it('规则集 ls/update 都输出纯 JSON，名称正确编码', async () => {
    const listed = await run(['rule-provider', 'ls', '--json'])
    expect(JSON.parse(listed.stdout)[0].name).toBe('remote/中文')
    const result = await run(['rule-provider', 'update', 'remote/中文', '--json'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, name: 'remote/中文' })
    expect(result.stderr).toBe('')
    expect(updated).toBe(true)
  })
  it('非法目标和缺少参数退出 2，非法目标不请求规则', async () => {
    for (const args of [['rules', 'test', 'https://example.com'], ['rules', 'test']]) {
      const result = await run(args)
      expect(result.code).toBe(2)
      expect(result.stdout).toBe('')
    }
    expect(requestedRules).toBe(0)
  })
  it('业务失败退出 1，JSON 标准输出为空', async () => {
    const missing = await run(['rule-provider', 'update', 'missing', '--json'])
    expect(missing.code).toBe(1)
    status = 401
    const result = await run(['rules', 'ls', '--json'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('鉴权失败')
  })
  it('内核不可达退出 3', async () => {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const result = await run(['rules', 'ls', '--json'], 'http://127.0.0.1:' + port)
    expect(result.code).toBe(3)
    expect(result.stdout).toBe('')
  })
})
