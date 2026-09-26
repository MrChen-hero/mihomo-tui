/**
 * 代理链写入事务测试：临时目录 + stub mihomo，零生产触碰。
 * 覆盖校验拒绝不写盘、reload 失败回滚、订阅事务后 relay 组仍在。
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { ConfigManager } from '../../config/manager.js'
import { buildSkeleton } from '../../config/skeleton.js'
import { addSubscription } from '../../config/subscriptionService.js'
import { ServiceManager } from '../../config/service.js'
import type { Subscription } from '../../config/types.js'
import { applyRelays, RelayError } from '../apply.js'
import type { RelayGroup } from '../editor.js'

const ALPHA: Subscription = { name: 'alpha', type: 'remote', url: 'https://alpha.example/sub?token=aaaa' }

let root: string
let mihomoDir: string
let subsPath: string
let originalText: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mihomo-tui-relay-'))
  mihomoDir = join(root, 'mihomo')
  subsPath = join(root, 'subscriptions.json')
  mkdirSync(mihomoDir, { recursive: true })
  const initial = buildSkeleton({ mode: 'rule' }, [ALPHA]).skeleton
  originalText = YAML.stringify(initial, { lineWidth: 0, singleQuote: true })
  writeFileSync(join(mihomoDir, 'config.yaml'), originalText, 'utf8')
  writeFileSync(subsPath, `${JSON.stringify({ subscriptions: [ALPHA] }, null, 2)}\n`, 'utf8')
})

function stubMihomo(alwaysFail = false): string {
  const bin = join(root, `mihomo-stub${alwaysFail ? '-fail' : ''}`)
  writeFileSync(
    bin,
    alwaysFail
      ? '#!/bin/sh\necho "stub validation failed" >&2\nexit 1\n'
      : '#!/bin/sh\necho "configuration file test is successful"\nexit 0\n',
    'utf8',
  )
  chmodSync(bin, 0o755)
  return bin
}

const chain = (name: string, proxies: string[]): RelayGroup => ({ name, type: 'relay', proxies })

const CANDIDATES = ['节点A', '节点B', '节点C']

function savedRelays(): RelayGroup[] {
  const config = YAML.parse(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')) as {
    'proxy-groups': { name: string; type: string; proxies?: string[] }[]
  }
  return config['proxy-groups']
    .filter((group) => group.type === 'relay')
    .map((group) => ({ name: group.name, type: 'relay' as const, proxies: group.proxies ?? [] }))
}

describe('applyRelays', () => {
  it('写入 relay 组并保留骨架原有的组', async () => {
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    const reloaded: string[] = []
    await applyRelays([chain('落地中转', ['节点A', '节点B'])], CANDIDATES, {
      manager,
      subscriptionsPath: subsPath,
      reload: async () => {
        reloaded.push('once')
      },
    })
    expect(savedRelays()).toEqual([chain('落地中转', ['节点A', '节点B'])])
    const config = YAML.parse(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')) as {
      'proxy-groups': { name: string }[]
    }
    expect(config['proxy-groups'].some((group) => group.name === 'PROXY')).toBe(true)
    expect(reloaded).toEqual(['once'])
  })

  it('校验失败时 config 逐字节不变且不触发 reload', async () => {
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    let reloaded = false
    await expect(
      applyRelays([chain('落地中转', ['节点A', '不存在'])], CANDIDATES, {
        manager,
        subscriptionsPath: subsPath,
        reload: async () => {
          reloaded = true
        },
      }),
    ).rejects.toBeInstanceOf(RelayError)
    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe(originalText)
    expect(reloaded).toBe(false)
  })

  it('mihomo 校验失败时不写 config', async () => {
    const manager = new ConfigManager(mihomoDir, stubMihomo(true))
    await expect(
      applyRelays([chain('落地中转', ['节点A', '节点B'])], CANDIDATES, {
        manager,
        subscriptionsPath: subsPath,
      }),
    ).rejects.toThrow(/校验失败/)
    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe(originalText)
  })

  it('reload 失败时回滚 config 并再次 reload', async () => {
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    let attempts = 0
    await expect(
      applyRelays([chain('落地中转', ['节点A', '节点B'])], CANDIDATES, {
        manager,
        subscriptionsPath: subsPath,
        reload: async () => {
          attempts += 1
          if (attempts === 1) throw new Error('reload boom')
        },
      }),
    ).rejects.toThrow(/已回滚/)
    expect(attempts).toBe(2)
    expect(savedRelays()).toEqual([])
  })

  it('两个 relay 组互引成环被拒且不写盘', async () => {
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    await expect(
      applyRelays(
        [chain('链一', ['节点A', '链二']), chain('链二', ['节点B', '链一'])],
        [...CANDIDATES, '链一', '链二'],
        { manager, subscriptionsPath: subsPath },
      ),
    ).rejects.toThrow(/成环/)
    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe(originalText)
  })
})

describe('订阅事务与 relay 共存', () => {
  it('新增订阅重新生成骨架后 relay 组仍在', async () => {
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    await applyRelays([chain('落地中转', ['节点A', '节点B'])], CANDIDATES, {
      manager,
      subscriptionsPath: subsPath,
    })

    const systemctl = join(root, 'systemctl-stub')
    const state = join(root, 'service-state')
    writeFileSync(state, 'active\n', 'utf8')
    writeFileSync(
      systemctl,
      `#!/bin/sh\ncase "$2" in\n  is-active) cat ${JSON.stringify(state)} ;;\n  restart) echo active > ${JSON.stringify(state)} ;;\n  status) echo ok ;;\nesac\nexit 0\n`,
      'utf8',
    )
    chmodSync(systemctl, 0o755)

    await addSubscription(
      { name: 'beta', type: 'remote', url: 'https://beta.example/sub?token=bbbb' },
      {
        manager,
        service: new ServiceManager('mihomo', systemctl),
        subscriptionsPath: subsPath,
        sleep: async () => {},
        graceMs: 0,
      },
    )
    expect(savedRelays()).toEqual([chain('落地中转', ['节点A', '节点B'])])
  })
})
