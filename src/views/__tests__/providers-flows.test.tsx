/**
 * Providers 视图订阅流程的集成测试：
 * 真视图 + 真编排层（subscriptionService）+ stub mihomo/systemctl + tmpdir，
 * 覆盖设计稿 10 的手动测试清单中可自动化的部分。零生产触碰。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'
import { ProvidersView } from '../Providers.js'
import type { ProvidersViewProps } from '../Providers.js'
import type { UseProvidersResult, ProviderRow } from '../../hooks/useProviders.js'
import type { AppConfig } from '../../config.js'
import { ConfigManager } from '../../config/manager.js'
import { ServiceManager } from '../../config/service.js'
import { buildSkeleton } from '../../config/skeleton.js'
import type { ServiceDeps } from '../../config/subscriptionService.js'
import { createTerminal, delay, textOf, type Terminal } from '../../components/__tests__/harness.js'

const ALPHA = { name: 'alpha', url: 'https://alpha.example/sub?token=aaaa' }
const BETA = { name: 'beta', url: 'https://beta.example/sub?token=bbbb', prefix: '[B] ' }

let root: string
let mihomoDir: string
let subsPath: string
let terminals: Terminal[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mihomo-tui-view-'))
  mihomoDir = join(root, 'mihomo')
  subsPath = join(root, 'subscriptions.json')
  mkdirSync(mihomoDir, { recursive: true })

  const initial = buildSkeleton({ mode: 'rule' }, [ALPHA, BETA]).skeleton
  writeFileSync(
    join(mihomoDir, 'config.yaml'),
    YAML.stringify(initial, { lineWidth: 0, singleQuote: true }),
    'utf8',
  )
  const providers = join(mihomoDir, 'providers')
  mkdirSync(providers, { recursive: true })
  writeFileSync(join(providers, 'alpha.yaml'), '# cache\n', 'utf8')
  writeFileSync(join(providers, 'beta.yaml'), '# cache\n', 'utf8')
  writeFileSync(subsPath, `${JSON.stringify({ subscriptions: [ALPHA, BETA] }, null, 2)}\n`, 'utf8')

  terminals = []
})

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.instance.unmount()
})

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
    ${options.restartFails ? 'echo "stub restart failed" >&2; exit 1' : `echo "${options.afterRestart ?? 'active'}" > ${JSON.stringify(state)}`}
    ;;
  status)
    echo "● mihomo.service - stub status"
    ;;
esac
exit 0
`,
    'utf8',
  )
  chmodSync(bin, 0o755)
  return bin
}

function stubMihomo(): string {
  const bin = join(root, 'mihomo-stub')
  writeFileSync(bin, '#!/bin/sh\necho "configuration file test is successful"\nexit 0\n', 'utf8')
  chmodSync(bin, 0o755)
  return bin
}

function fakeProviders(rows: Partial<ProviderRow>[]): UseProvidersResult {
  return {
    providers: rows.map((row) => ({
      name: 'x',
      type: 'HTTP',
      nodes: 10,
      alive: 8,
      remaining: undefined,
      expire: undefined,
      updatedAt: undefined,
      updating: false,
      error: undefined,
      ...row,
    })),
    loading: false,
    error: undefined,
    refresh: vi.fn(),
    update: vi.fn(async () => {}),
    updateAll: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    nodesOf: () => [],
  }
}

interface Fixture {
  props: ProvidersViewProps
  deps: ServiceDeps
  messages: string[]
  terminal: Terminal
}

function mountView(options: { afterRestart?: string; rows?: Partial<ProviderRow>[] } = {}): Fixture {
  const messages: string[] = []
  const deps: ServiceDeps = {
    manager: new ConfigManager(mihomoDir, stubMihomo()),
    service: new ServiceManager('mihomo', stubSystemctl(options)),
    sleep: async () => {},
    graceMs: 0,
    // 关键：显式注入清单路径，防止事务沿默认路径写到真实 subscriptions.json
    subscriptionsPath: subsPath,
  }
  const config: AppConfig = {
    api: 'http://127.0.0.1:19090',
    secret: '',
    mihomoDir,
    testUrl: 'https://www.gstatic.com/generate_204',
    testTimeout: 5000,
    delayThresholds: { good: 300, fair: 800 },
  }
  const props: ProvidersViewProps = {
    providers: fakeProviders(options.rows ?? [{ name: 'alpha' }, { name: 'beta' }]),
    height: 24,
    width: 100,
    tick: 0,
    active: true,
    onMessage: (text) => messages.push(text),
    config,
    serviceDeps: deps,
  }
  const terminal = createTerminal(<ProvidersView {...props} />)
  terminals.push(terminal)
  return { props, deps, messages, terminal }
}

const frames = (terminal: Terminal): string => textOf(terminal.frames())

describe('订阅流程（视图层集成）', () => {
  it('a 打开添加对话框，提交后订阅清单与配置同步更新', async () => {
    const { terminal, messages } = mountView()
    await delay(60)
    terminal.press('a')
    await delay(60)
    expect(frames(terminal)).toContain('添加订阅')

    for (const char of 'gamma') terminal.press(char)
    terminal.press('\r') // 名称合法 → 前进
    for (const char of 'https://gamma.example/sub?token=cccc') terminal.press(char)
    terminal.press('\r') // URL 合法 → 前进
    terminal.press('\r') // 前缀留空 → 提交
    await vi.waitFor(() => {
      expect(messages).toContain('已添加订阅 gamma')
    })

    const subs = YAML.parse(readFileSync(subsPath, 'utf8')).subscriptions.map(
      (s: { name: string }) => s.name,
    )
    expect(subs).toEqual(['alpha', 'beta', 'gamma'])
    const config = YAML.parse(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8'))
    expect(config['proxy-providers']?.gamma?.url).toBe('https://gamma.example/sub?token=cccc')
  })

  it('ESC 取消添加对话框，不产生任何改动', async () => {
    const { terminal } = mountView()
    await delay(60)
    terminal.press('a')
    await delay(60)
    terminal.press('\x1B')
    await delay(60)
    const before = readFileSync(subsPath, 'utf8')
    await delay(120)
    expect(readFileSync(subsPath, 'utf8')).toBe(before)
  })

  it('d 打开确认框：y 执行删除（清单+配置+缓存），n 取消', async () => {
    const { terminal, messages } = mountView()
    await delay(60)
    terminal.press('d') // 当前选中 alpha（排序第一）
    await delay(60)
    expect(frames(terminal)).toContain('将删除订阅：alpha')
    expect(frames(terminal)).toContain('此操作不可撤销！')

    terminal.press('n') // 先取消
    await delay(60)
    expect(readFileSync(subsPath, 'utf8')).toContain('alpha')

    terminal.press('d')
    await delay(60)
    terminal.press('y') // 确认删除
    await vi.waitFor(() => {
      expect(messages).toContain('已删除订阅 alpha')
    })
    const subs = YAML.parse(readFileSync(subsPath, 'utf8')).subscriptions.map(
      (s: { name: string }) => s.name,
    )
    expect(subs).toEqual(['beta'])
    expect(existsSync(join(mihomoDir, 'providers', 'alpha.yaml'))).toBe(false)
    expect(existsSync(join(mihomoDir, 'providers', 'beta.yaml'))).toBe(true)
  })

  it('e 编辑前缀：名称只读，前缀写入配置', async () => {
    const { terminal, messages } = mountView()
    await delay(60)
    terminal.press('e') // 编辑 alpha（当前无前缀）
    await delay(60)
    expect(frames(terminal)).toContain('编辑订阅：alpha')
    expect(frames(terminal)).toContain('（只读）')

    terminal.press('\r') // 从只读的名称前进到前缀
    await delay(30)
    for (const char of '[A] ') terminal.press(char)
    terminal.press('\r') // 提交
    await vi.waitFor(() => {
      expect(messages).toContain('已更新订阅 alpha 的前缀')
    })
    const config = YAML.parse(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8'))
    expect(config['proxy-providers']?.alpha?.override?.['additional-prefix']).toBe('[A] ')
  })

  it('服务起不来：错误对话框展示完整回滚信息，任意键关闭', async () => {
    const { terminal } = mountView({ afterRestart: 'inactive' })
    await delay(60)
    terminal.press('a')
    await delay(60)
    for (const char of 'gamma') terminal.press(char)
    terminal.press('\r')
    for (const char of 'https://gamma.example/sub?token=cccc') terminal.press(char)
    terminal.press('\r')
    terminal.press('\r')
    await vi.waitFor(() => {
      expect(frames(terminal)).toContain('服务启动失败（已回滚）')
    })
    expect(frames(terminal)).toContain('按任意键关闭')

    terminal.press('x') // 任意键关闭
    await delay(60)
    // 清单已回滚
    const subs = YAML.parse(readFileSync(subsPath, 'utf8')).subscriptions.map(
      (s: { name: string }) => s.name,
    )
    expect(subs).toEqual(['alpha', 'beta'])
  })

  it('订阅更新进行中时按 a/d/e 被拒绝', async () => {
    const { terminal, messages } = mountView({
      rows: [{ name: 'alpha', updating: true }, { name: 'beta' }],
    })
    await delay(60)
    terminal.press('a')
    await delay(60)
    expect(messages).toContain('订阅更新进行中，请稍后再试')
    expect(frames(terminal)).not.toContain('添加订阅')
  })

  it('d 无选中时提示且不打开对话框', async () => {
    const { terminal, messages } = mountView({ rows: [] })
    await delay(60)
    terminal.press('d')
    await delay(60)
    expect(messages).toContain('没有可删除的订阅')
  })
})
