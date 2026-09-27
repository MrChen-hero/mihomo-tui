/** 启动真实 CLI 入口：kernel 命令的参数校验层（退出码 2），临时 HOME 隔离。 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../..', import.meta.url))
let testHome = ''

beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), 'kernel-cli-'))
  mkdirSync(join(testHome, '.config/mihomo-tui'), { recursive: true })
  writeFileSync(join(testHome, '.config/mihomo-tui/config.json'), '{}')
})
afterAll(() => rmSync(testHome, { recursive: true, force: true }))

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli.tsx', ...args], {
      cwd: root, env: { ...process.env, HOME: testHome }, timeout: 15000,
    }, (err, stdout, stderr) => {
      resolve({ code: typeof err?.code === 'number' ? err.code : err ? -1 : 0, stdout, stderr })
    })
  })
}

describe('kernel CLI 参数校验', () => {
  it('--port 低于合法域：usage 退出 2，不触网', async () => {
    const result = await run(['kernel', 'install', '--port', '80'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('1024-65535')
  })

  it('--mirror 非法前缀：usage 退出 2', async () => {
    const result = await run(['kernel', 'install', '1.19.30', '--mirror', 'ftp://x/'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('http(s)://')
  })

  it('--json 消费者看到干净 stdout（无提示混入）', async () => {
    const result = await run(['kernel', 'install', '--port', '80'])
    expect(result.stdout).toBe('')
  })
})
