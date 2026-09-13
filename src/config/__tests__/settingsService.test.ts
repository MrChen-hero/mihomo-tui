/**
 * 设置事务的集成测试（spec 2026-09-13 settings-kernel §3.2）：
 * stub mihomo + stub systemctl + tmpdir，覆盖正常流、逐字段写入、
 * 校验拒绝与重启失败回滚。零生产触碰。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { ConfigManager } from '../manager.js'
import { ServiceManager } from '../service.js'
import { buildSkeleton } from '../skeleton.js'
import {
  SETTINGS_STEPS,
  SettingsError,
  applyChangesToConfig,
  applySettings,
  validateChanges,
} from '../settingsService.js'
import type { SettingsChanges, SettingsDeps, SettingsStep } from '../settingsService.js'
import type { Subscription } from '../types.js'

const ALPHA: Subscription = { name: 'alpha', url: 'https://alpha.example/sub?token=aaaa' }
const BETA: Subscription = { name: 'beta', url: 'https://beta.example/sub?token=bbbb', prefix: '[B] ' }

let root: string
let mihomoDir: string
let subsPath: string
let originalConfigText: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mihomo-tui-setsvc-'))
  mihomoDir = join(root, 'mihomo')
  subsPath = join(root, 'subscriptions.json')

  mkdirSync(mihomoDir, { recursive: true })
  const initial = buildSkeleton({ mode: 'rule' }, [ALPHA, BETA]).skeleton
  originalConfigText = YAML.stringify(initial, { lineWidth: 0, singleQuote: true })
  writeFileSync(join(mihomoDir, 'config.yaml'), originalConfigText, 'utf8')

  writeFileSync(subsPath, `${JSON.stringify({ subscriptions: [ALPHA, BETA] }, null, 2)}\n`, 'utf8')
})

/** stub mihomo：-t 默认通过；alwaysFail 时必败 */
function stubMihomo(alwaysFail = false): string {
  const bin = join(root, `mihomo-stub${alwaysFail ? '-fail' : ''}`)
  writeFileSync(
    bin,
    `#!/bin/sh
${alwaysFail ? 'echo "stub validation failed" >&2\nexit 1' : 'echo "configuration file test is successful"\nexit 0'}
`,
    'utf8',
  )
  chmodSync(bin, 0o755)
  return bin
}

/** stub systemctl：restart 后状态可控，可注入重启失败 */
function stubSystemctl(options: { afterRestart?: string; restartFails?: boolean } = {}): string {
  const bin = join(root, 'systemctl-stub')
  const state = join(root, 'service-state')
  const log = join(root, 'service-log')
  writeFileSync(state, `${options.afterRestart ?? 'active'}\n`, 'utf8')
  writeFileSync(log, '', 'utf8')
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> ${JSON.stringify(log)}
case "$2" in
  is-active) cat ${JSON.stringify(state)} ;;
  restart)
    ${options.restartFails ? 'echo "Job for mihomo.service failed (stub)" >&2; exit 1' : `echo "${options.afterRestart ?? 'active'}" > ${JSON.stringify(state)}`}
    ;;
esac
exit 0
`,
    'utf8',
  )
  chmodSync(bin, 0o755)
  return bin
}

interface Harness {
  deps: SettingsDeps
  restartCount: () => number
}

function harness(
  options: { afterRestart?: string; restartFails?: boolean; mihomoFails?: boolean } = {},
  onProgress?: SettingsDeps['onProgress'],
): Harness {
  const manager = new ConfigManager(mihomoDir, stubMihomo(options.mihomoFails))
  const service = new ServiceManager('mihomo', stubSystemctl(options))
  const deps: SettingsDeps = {
    subscriptionsPath: subsPath,
    manager,
    service,
    sleep: async () => {},
    graceMs: 0,
    onProgress,
  }
  return {
    deps,
    restartCount: () =>
      readFileSync(join(root, 'service-log'), 'utf8')
        .split('\n')
        .filter((line) => line.includes('restart')).length,
  }
}

const configYaml = (): Record<string, unknown> =>
  YAML.parse(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8'))

describe('applySettings 设置事务', () => {
  it('改端口正常流：写入、骨架其余字段保持、重启一次、备份存在', async () => {
    const { deps, restartCount } = harness()
    const result = await applySettings({ 'mixed-port': 18080 }, deps)

    expect(result.warnings).toEqual([])
    expect(configYaml()['mixed-port']).toBe(18080)
    // 骨架沿用语义：其余字段与订阅段不受设置修改影响
    expect(configYaml()['allow-lan']).toBe(false)
    expect(Object.keys(configYaml()['proxy-providers'] as object)).toEqual(['alpha', 'beta'])
    expect(restartCount()).toBe(1)
    const backups = readdirSync(mihomoDir).filter((entry) => entry.startsWith('config.yaml.bak.'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(mihomoDir, backups[0] ?? ''), 'utf8')).toBe(originalConfigText)
  })

  it('每个设置字段都能独立写入', async () => {
    const { deps } = harness()
    await applySettings({ 'allow-lan': true }, deps)
    expect(configYaml()['allow-lan']).toBe(true)

    await applySettings({ ipv6: false }, deps)
    expect(configYaml()['ipv6']).toBe(false)

    await applySettings({ 'unified-delay': false }, deps)
    expect(configYaml()['unified-delay']).toBe(false)

    await applySettings({ 'tcp-concurrent': false }, deps)
    expect(configYaml()['tcp-concurrent']).toBe(false)

    await applySettings({ 'log-level': 'debug' }, deps)
    expect(configYaml()['log-level']).toBe('debug')

    await applySettings({ dnsEnable: false }, deps)
    expect((configYaml()['dns'] as Record<string, unknown>)['enable']).toBe(false)
  })

  it('非法端口与非法日志级别在改动任何文件之前被拒绝', async () => {
    const { deps, restartCount } = harness()
    await expect(applySettings({ 'mixed-port': 80 }, deps)).rejects.toThrow(/1024–65535/)
    await expect(applySettings({ 'mixed-port': 8080.5 }, deps)).rejects.toThrow(SettingsError)
    await expect(applySettings({ 'log-level': 'verbose' as never }, deps)).rejects.toThrow(
      /日志级别/,
    )
    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe(originalConfigText)
    expect(restartCount()).toBe(0)
  })

  it('空变更不动文件也不重启', async () => {
    const { deps, restartCount } = harness()
    await applySettings({}, deps)
    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe(originalConfigText)
    expect(restartCount()).toBe(0)
  })

  it('onProgress 按步骤顺序上报且引用 SETTINGS_STEPS 元素', async () => {
    const { deps } = harness()
    const seen: string[] = []
    await applySettings({ 'log-level': 'warning' }, {
      ...deps,
      onProgress: (current: SettingsStep, completed: SettingsStep[]) => {
        seen.push(`${current.key}|${completed.length}`)
        expect(SETTINGS_STEPS).toContain(current)
      },
    })
    expect(seen).toEqual(['read|0', 'generate|1', 'backup|2', 'write|3', 'restart|4', 'verify|5'])
  })

  it('配置校验失败：不写入、不重启、配置原样', async () => {
    const { deps, restartCount } = harness({ mihomoFails: true })
    await expect(applySettings({ 'mixed-port': 18080 }, deps)).rejects.toThrow(/未通过校验/)
    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe(originalConfigText)
    expect(restartCount()).toBe(0)
    expect(existsSync(join(mihomoDir, 'config.yaml.tmp'))).toBe(false)
  })

  it('服务重启后未 active：回滚配置并再次重启，错误带 systemctl status', async () => {
    const { deps, restartCount } = harness({ afterRestart: 'inactive' })
    await expect(applySettings({ 'mixed-port': 18080 }, deps)).rejects.toThrow(
      /服务启动失败（已回滚）/,
    )
    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe(originalConfigText)
    // 第一次 restart + 回滚再 restart
    expect(restartCount()).toBe(2)
  })

  it('重启失败：从备份回滚配置并再次重启，错误带阶段信息', async () => {
    const { deps, restartCount } = harness({ restartFails: true })
    await expect(applySettings({ 'mixed-port': 18080 }, deps)).rejects.toThrow(/重启/)
    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe(originalConfigText)
    // 第一次 restart 失败 + 回滚再 restart = 2 次调用（第二次成功，否则 rollback 也抛）
    expect(restartCount()).toBe(2)
  })
})

describe('applyChangesToConfig / validateChanges 纯逻辑', () => {
  it('变更就地套到解析对象上，dns 段缺失时创建', () => {
    const old: Record<string, unknown> = { 'mixed-port': 17890 }
    const changes: SettingsChanges = { 'mixed-port': 8080, dnsEnable: false }
    applyChangesToConfig(old as never, changes)
    expect(old['mixed-port']).toBe(8080)
    expect((old['dns'] as Record<string, unknown>)['enable']).toBe(false)
  })

  it('validateChanges 接受合法端口与级别', () => {
    expect(() => validateChanges({ 'mixed-port': 1024 })).not.toThrow()
    expect(() => validateChanges({ 'mixed-port': 65535 })).not.toThrow()
    expect(() => validateChanges({ 'log-level': 'silent' })).not.toThrow()
  })
})
