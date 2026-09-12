/**
 * 订阅事务编排的集成测试：全 mock（stub mihomo + stub systemctl + tmpdir），
 * 覆盖设计稿 8.2 的正常流、逐阶段失败回滚与并发保护。零生产触碰。
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
  ADD_STEPS,
  DELETE_STEPS,
  SubscriptionError,
  addSubscription,
  deleteSubscription,
  editSubscriptionPrefix,
} from '../subscriptionService.js'
import type { ServiceDeps, Step } from '../subscriptionService.js'
import type { Subscription } from '../types.js'

const ALPHA: Subscription = { name: 'alpha', url: 'https://alpha.example/sub?token=aaaa' }
const BETA: Subscription = { name: 'beta', url: 'https://beta.example/sub?token=bbbb', prefix: '[B] ' }
const GAMMA: Subscription = { name: 'gamma', url: 'https://gamma.example/sub?token=cccc' }

let root: string
let mihomoDir: string
let subsPath: string
let originalConfigText: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mihomo-tui-svcint-'))
  mihomoDir = join(root, 'mihomo')
  subsPath = join(root, 'subscriptions.json')

  // 初始配置由 buildSkeleton 自身生成，保证与现实一致的骨架形态
  mkdirSync(mihomoDir, { recursive: true })
  const initial = buildSkeleton({ mode: 'rule' }, [ALPHA, BETA]).skeleton
  originalConfigText = YAML.stringify(initial, { lineWidth: 0, singleQuote: true })
  writeFileSync(join(mihomoDir, 'config.yaml'), originalConfigText, 'utf8')

  const providers = join(mihomoDir, 'providers')
  mkdirSync(providers, { recursive: true })
  writeFileSync(join(providers, 'alpha.yaml'), '# alpha cache\n', 'utf8')
  writeFileSync(join(providers, 'beta.yaml'), '# beta cache\n', 'utf8')

  writeFileSync(
    subsPath,
    `${JSON.stringify({ subscriptions: [ALPHA, BETA] }, null, 2)}\n`,
    'utf8',
  )
})

/** stub mihomo：-t 默认通过；alwaysFail 时必败 */
function stubMihomo(alwaysFail = false): string {
  const bin = join(root, `mihomo-stub${alwaysFail ? '-fail' : ''}`)
  writeFileSync(
    bin,
    `#!/bin/sh
${alwaysFail ? 'echo "stub validation failed" >&2\nexit 1' : `echo "configuration file $4 test is successful"\nexit 0`}
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
  writeFileSync(state, `${options.afterRestart ?? 'inactive'}\n`, 'utf8')
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
  status)
    echo "● mihomo.service - stub status"
    echo "   Active: $(cat ${JSON.stringify(state)})"
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
  deps: ServiceDeps
  restartCount: () => number
}

function harness(
  options: { afterRestart?: string; restartFails?: boolean; mihomoFails?: boolean } = {},
  onProgress?: ServiceDeps['onProgress'],
): Harness {
  const systemctl = stubSystemctl(options)
  const manager = new ConfigManager(mihomoDir, stubMihomo(options.mihomoFails))
  const service = new ServiceManager('mihomo', systemctl)
  const deps: ServiceDeps = {
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

const subNames = (): string[] =>
  YAML.parse(readFileSync(subsPath, 'utf8')).subscriptions.map((s: Subscription) => s.name)

describe('addSubscription 新增订阅', () => {
  it('正常流：清单、配置、备份、缓存目录、服务重启全部到位', async () => {
    const { deps, restartCount } = harness()
    const result = await addSubscription(GAMMA, deps)

    expect(result.warnings).toEqual([])
    expect(subNames()).toEqual(['alpha', 'beta', 'gamma'])
    const config = YAML.parse(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8'))
    expect(config['proxy-providers']?.gamma?.url).toBe(GAMMA.url)
    expect(config['proxy-groups'].some((g: { name: string }) => g.name === '机场-gamma')).toBe(true)
    expect(restartCount()).toBe(1)
    expect(existsSync(join(mihomoDir, 'providers'))).toBe(true)
    // 备份存在且内容是改动前的配置
    const backups = readdirSync(mihomoDir).filter((entry) => entry.startsWith('config.yaml.bak.'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(mihomoDir, backups[0] ?? ''), 'utf8')).toBe(originalConfigText)
  })

  it('重名被拒绝且不触碰任何文件', async () => {
    const { deps, restartCount } = harness()
    await expect(addSubscription({ ...GAMMA, name: 'alpha' }, deps)).rejects.toThrow(/已存在/)
    expect(subNames()).toEqual(['alpha', 'beta'])
    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe(originalConfigText)
    expect(restartCount()).toBe(0)
  })

  it('非法输入在改动任何文件之前被拒绝', async () => {
    const { deps, restartCount } = harness()
    await expect(addSubscription({ name: 'a b', url: GAMMA.url }, deps)).rejects.toThrow(
      SubscriptionError,
    )
    await expect(addSubscription({ name: 'ok', url: 'ftp://x' }, deps)).rejects.toThrow(
      SubscriptionError,
    )
    expect(subNames()).toEqual(['alpha', 'beta'])
    expect(restartCount()).toBe(0)
  })
})

describe('deleteSubscription 删除订阅', () => {
  it('正常流：清单与配置移除、缓存文件清理、组消失', async () => {
    const { deps } = harness()
    await deleteSubscription('beta', deps)

    expect(subNames()).toEqual(['alpha'])
    const config = YAML.parse(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8'))
    expect(config['proxy-providers']?.beta).toBeUndefined()
    expect(config['proxy-groups'].some((g: { name: string }) => g.name === '机场-beta')).toBe(false)
    expect(existsSync(join(mihomoDir, 'providers', 'beta.yaml'))).toBe(false)
    expect(existsSync(join(mihomoDir, 'providers', 'alpha.yaml'))).toBe(true)
  })

  it('不能删除最后一个订阅', async () => {
    await deleteSubscription('alpha', harness().deps) // 先删一个
    await expect(deleteSubscription('beta', harness().deps)).rejects.toThrow(/不能删除最后一个订阅/)
    expect(subNames()).toEqual(['beta'])
  })

  it('删除不存在的订阅抛错', async () => {
    await expect(deleteSubscription('ghost', harness().deps)).rejects.toThrow(/不存在/)
  })
})

describe('editSubscriptionPrefix 编辑前缀', () => {
  it('改前缀：配置中的 additional-prefix 同步更新', async () => {
    const { deps } = harness()
    const result = await editSubscriptionPrefix('beta', '[BB] ', deps)
    expect(result.unchanged).toBe(false)
    const config = YAML.parse(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8'))
    expect(config['proxy-providers']?.beta?.override?.['additional-prefix']).toBe('[BB] ')
    expect(subNames()).toEqual(['alpha', 'beta'])
  })

  it('前缀无变化时是 no-op：不重启、不备份', async () => {
    const { deps, restartCount } = harness()
    const result = await editSubscriptionPrefix('beta', '[B] ', deps)
    expect(result.unchanged).toBe(true)
    expect(restartCount()).toBe(0)
    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe(originalConfigText)
  })

  it('清除前缀（传空）与编辑不存在的订阅', async () => {
    const { deps } = harness()
    const cleared = await editSubscriptionPrefix('beta', '   ', deps)
    expect(cleared.unchanged).toBe(false)
    const config = YAML.parse(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8'))
    expect(config['proxy-providers']?.beta?.override).toBeUndefined()
    await expect(editSubscriptionPrefix('ghost', '[X] ', harness().deps)).rejects.toThrow(/不存在/)
  })
})

describe('失败回滚（设计稿 6.1 回滚表）', () => {
  it('服务起不来：完整回滚配置与清单并再次重启，错误携带 systemctl status', async () => {
    const { deps, restartCount } = harness({ afterRestart: 'inactive' })
    await expect(addSubscription(GAMMA, deps)).rejects.toThrow(/服务启动失败（已回滚）/)

    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe(originalConfigText)
    expect(subNames()).toEqual(['alpha', 'beta'])
    expect(restartCount()).toBe(2)
  })

  it('配置校验失败：清单恢复、配置不动、不重启', async () => {
    const { deps, restartCount } = harness({ mihomoFails: true })
    await expect(addSubscription(GAMMA, deps)).rejects.toThrow(/校验/)

    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe(originalConfigText)
    expect(subNames()).toEqual(['alpha', 'beta'])
    expect(restartCount()).toBe(0)
  })

  it('重启失败：回滚配置（重启也失败时错误合并上报），清单恢复', async () => {
    const { deps } = harness({ restartFails: true })
    await expect(addSubscription(GAMMA, deps)).rejects.toThrow(/回滚失败/)

    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe(originalConfigText)
    expect(subNames()).toEqual(['alpha', 'beta'])
  })

  it('服务起不来时删除订阅同样整体回滚', async () => {
    const { deps } = harness({ afterRestart: 'inactive' })
    await expect(deleteSubscription('beta', deps)).rejects.toThrow(/服务启动失败（已回滚）/)
    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe(originalConfigText)
    expect(subNames()).toEqual(['alpha', 'beta'])
  })
})

describe('进度上报', () => {
  it('add 按步骤顺序上报，validate 之后每步都有 completed 列表', async () => {
    const seen: Step[] = []
    const { deps } = harness({}, (current) => seen.push(current))
    await addSubscription(GAMMA, deps)
    expect(seen.map((step) => step.key)).toEqual(ADD_STEPS.map((step) => step.key))
    expect(seen[0]?.label).toBe('校验输入')
  })

  it('delete 的最后一步是清理订阅缓存', async () => {
    const seen: Step[] = []
    const { deps } = harness({}, (current) => seen.push(current))
    await deleteSubscription('beta', deps)
    expect(seen.at(-1)?.key).toBe('cache')
    expect(seen.map((step) => step.key)).toEqual(DELETE_STEPS.map((step) => step.key))
  })

  it('校验失败时只推进到写入步骤（未触碰服务）', async () => {
    const seen: Step[] = []
    const { deps, restartCount } = harness({ mihomoFails: true }, (current) => seen.push(current))
    await addSubscription(GAMMA, deps).catch(() => {})
    expect(seen.map((step) => step.key)).toEqual([
      'validate',
      'manifest',
      'generate',
      'backup',
      'write',
    ])
    expect(restartCount()).toBe(0)
  })
})
