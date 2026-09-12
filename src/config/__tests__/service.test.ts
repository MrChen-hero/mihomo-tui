import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ServiceManager } from '../service.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mihomo-tui-svc-'))
})

/**
 * stub systemctl：
 *   - 每次调用记录到 STUB_LOG；
 *   - is-active 读状态文件；restart 把状态文件写成 active（或注入失败）。
 */
function stubSystemctl(options: { startState?: string; restartFails?: boolean } = {}): string {
  const stateFile = join(root, 'state')
  const logFile = join(root, 'log')
  writeFileSync(stateFile, `${options.startState ?? 'inactive'}\n`, 'utf8')
  const body = `#!/bin/sh
echo "$@" >> ${JSON.stringify(logFile)}
case "$2" in
  is-active) cat ${JSON.stringify(stateFile)} ;;
  restart)
    ${options.restartFails ? 'echo "Job for mihomo.service failed (stub)" >&2; exit 1' : `echo "active" > ${JSON.stringify(stateFile)}`}
    ;;
  status)
    echo "● mihomo.service - stub"
    echo "   Active: $(cat ${JSON.stringify(stateFile)})"
    ;;
esac
exit 0
`
  const bin = join(root, 'systemctl-stub')
  writeFileSync(bin, body, 'utf8')
  chmodSync(bin, 0o755)
  return bin
}

function calls(bin: string): string[] {
  return readFileSync(join(root, 'log'), 'utf8').trim().split('\n')
}

describe('ServiceManager（注入 stub systemctl，物理隔离真实服务）', () => {
  it('isActive：active 返回 true', async () => {
    const service = new ServiceManager('mihomo', stubSystemctl({ startState: 'active' }))
    await expect(service.isActive()).resolves.toBe(true)
  })

  it('isActive：非 active 返回 false', async () => {
    const service = new ServiceManager('mihomo', stubSystemctl({ startState: 'inactive' }))
    await expect(service.isActive()).resolves.toBe(false)
  })

  it('isActive：查询异常也视为 false', async () => {
    const service = new ServiceManager('mihomo', join(root, 'no-such-systemctl'))
    await expect(service.isActive()).resolves.toBe(false)
  })

  it('restart 以 --user restart <服务名> 调用', async () => {
    const bin = stubSystemctl()
    const service = new ServiceManager('mihomo', bin)
    await service.restart()
    expect(calls(bin)).toContainEqual(['--user', 'restart', 'mihomo'].join(' '))
  })

  it('restart 失败抛错并携带 stderr', async () => {
    const service = new ServiceManager('mihomo', stubSystemctl({ restartFails: true }))
    await expect(service.restart()).rejects.toThrow(/Job for mihomo\.service failed/)
  })

  it('status 返回完整输出（含非 active 的诊断信息）', async () => {
    const service = new ServiceManager('mihomo', stubSystemctl({ startState: 'inactive' }))
    const output = await service.status()
    expect(output).toContain('mihomo.service - stub')
    expect(output).toContain('inactive')
  })

  it('服务名可自定义', async () => {
    const bin = stubSystemctl()
    const service = new ServiceManager('mihomo-dev', bin)
    await service.restart()
    expect(calls(bin).at(-1)).toBe('--user restart mihomo-dev')
  })
})
