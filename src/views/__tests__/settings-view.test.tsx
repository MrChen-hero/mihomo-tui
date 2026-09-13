/**
 * Settings 视图集成测试（spec 2026-09-13 settings-kernel §3.1）：
 * 真视图 + 真编排层（settingsService）+ stub mihomo/systemctl + tmpdir。
 * 覆盖行渲染、光标跳过只读行、开关/端口/日志级别的完整修改流。零生产触碰。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'
import { resetSettingsCacheForTests, SettingsView } from '../Settings.js'
import type { SettingsViewProps } from '../Settings.js'
import type { AppConfig } from '../../config.js'
import { ConfigManager } from '../../config/manager.js'
import { ServiceManager } from '../../config/service.js'
import { buildSkeleton } from '../../config/skeleton.js'
import type { SettingsDeps } from '../../config/settingsService.js'
import { createTerminal, delay, textOf, type Terminal } from '../../components/__tests__/harness.js'

const ALPHA = { name: 'alpha', url: 'https://alpha.example/sub?token=aaaa' }

const ESC = '\x1B'
const RETURN = '\r'
const DOWN = '\x1B[B'

let root: string
let mihomoDir: string
let subsPath: string
let terminals: Terminal[]
let messages: string[]

beforeEach(() => {
  resetSettingsCacheForTests()
  root = mkdtempSync(join(tmpdir(), 'mihomo-tui-setview-'))
  mihomoDir = join(root, 'mihomo')
  subsPath = join(root, 'subscriptions.json')
  mkdirSync(mihomoDir, { recursive: true })

  const initial = buildSkeleton({ mode: 'rule' }, [ALPHA]).skeleton
  writeFileSync(
    join(mihomoDir, 'config.yaml'),
    YAML.stringify(initial, { lineWidth: 0, singleQuote: true }),
    'utf8',
  )
  writeFileSync(subsPath, `${JSON.stringify({ subscriptions: [ALPHA] }, null, 2)}\n`, 'utf8')

  terminals = []
  messages = []
})

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.instance.unmount()
  vi.unstubAllGlobals()
})

function stubMihomo(): string {
  const bin = join(root, 'mihomo-stub')
  writeFileSync(bin, '#!/bin/sh\necho "configuration file test is successful"\nexit 0\n', 'utf8')
  chmodSync(bin, 0o755)
  return bin
}

function stubSystemctl(): string {
  const bin = join(root, 'systemctl-stub')
  const state = join(root, 'service-state')
  writeFileSync(state, 'active\n', 'utf8')
  writeFileSync(
    bin,
    `#!/bin/sh
case "$2" in
  is-active) cat ${JSON.stringify(state)} ;;
  restart) echo "active" > ${JSON.stringify(state)} ;;
esac
exit 0
`,
    'utf8',
  )
  chmodSync(bin, 0o755)
  return bin
}

function mountView(options: { height?: number } = {}): Terminal {
  const deps: SettingsDeps = {
    manager: new ConfigManager(mihomoDir, stubMihomo()),
    service: new ServiceManager('mihomo', stubSystemctl()),
    sleep: async () => {},
    graceMs: 0,
    subscriptionsPath: subsPath,
  }
  const config: AppConfig = {
    api: 'http://127.0.0.1:19090',
    secret: '',
    mihomoDir,
    mihomoBin: join(root, 'bin', 'mihomo'),
    downloadSource: { mode: 'custom', customPrefix: 'http://127.0.0.1:9/' },
    testUrl: 'https://www.gstatic.com/generate_204',
    testTimeout: 5000,
    delayThresholds: { good: 300, fair: 800 },
  }
  const props: SettingsViewProps = {
    config,
    version: 'v1.19.24',
    height: options.height ?? 28,
    width: 110,
    active: true,
    onMessage: (text) => messages.push(text),
    serviceDeps: deps,
    configPath: join(root, 'config.json'),
    kernelsDir: join(root, 'kernels'),
  }
  const terminal = createTerminal(<SettingsView {...props} />)
  terminals.push(terminal)
  return terminal
}

const configYaml = (): Record<string, unknown> =>
  YAML.parse(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8'))

describe('SettingsView 渲染', () => {
  it('显示 config.yaml 当前值与内核版本，只读行不带光标', async () => {
    const terminal = mountView()
    await delay()
    const text = textOf(terminal.frames())
    expect(text).toContain('◆ 设置')
    expect(text).toContain('混合端口')
    expect(text).toContain('17890')
    expect(text).toContain('127.0.0.1:19090')
    expect(text).toContain('v1.19.24')
    expect(text).toContain('DNS 接管')
    expect(text).toContain('mihomo 内核')
    // 骨架默认：allow-lan 关、ipv6 开
    expect(text).toContain('❯ 混合端口')
    expect(text).not.toContain('❯ 外部控制')
  })

  it('光标移动：DNS 接管 → 可用更新（可重试）→ 切换版本，只读行仍跳过', async () => {
    const terminal = mountView()
    await delay()
    for (let i = 0; i < 6; i += 1) terminal.press(DOWN)
    await delay()
    expect(textOf(terminal.frames())).toContain('❯ DNS 接管')
    terminal.press(DOWN)
    await delay()
    expect(textOf(terminal.frames())).toContain('❯ 可用更新')
    terminal.press(DOWN)
    await delay()
    expect(textOf(terminal.frames())).toContain('❯ 切换版本')
    // 只读行不落光标：继续向下直达下载源，不经过当前版本
    terminal.press(DOWN)
    await delay()
    expect(textOf(terminal.frames())).toContain('❯ 下载源')
  })

  it('80×24 档（body 18 行）卡片完整渲染不丢行', async () => {
    const terminal = mountView({ height: 18 })
    await delay()
    const text = textOf(terminal.frames())
    expect(text).toContain('混合端口')
    expect(text).toContain('下载源') // 最后一行区块仍可见
    expect(text).toContain('╰') // 底边框在场
  })
})

describe('SettingsView 修改流', () => {
  it('开关修改：确认框明示旧→新，y 应用后写入 config.yaml 并提示', async () => {
    const terminal = mountView()
    await delay()
    terminal.press(DOWN) // 混合端口 → 允许局域网
    await delay()
    terminal.press(RETURN)
    await delay()
    const text = textOf(terminal.frames())
    expect(text).toContain('允许局域网：关 → 开')
    expect(text).toContain('将写入 config.yaml 并重启服务，活动连接会瞬断数秒')

    // frames() 累积：只看 y 之后的增量帧——确认框已关、卡片页显示新值
    const mark = terminal.frames().length
    terminal.press('y')
    await delay(150)
    expect(configYaml()['allow-lan']).toBe(true)
    expect(messages).toContain('设置已应用，服务已重启')
    const tail = textOf(terminal.frames().slice(mark))
    expect(tail).not.toContain('允许局域网：关 → 开')
    expect(tail).toContain('❯ 允许局域网')
  })

  it('端口修改：输入框校验、ESC 取消不动文件、合法值走确认', async () => {
    const terminal = mountView()
    await delay()
    terminal.press(RETURN) // 混合端口
    await delay()
    expect(textOf(terminal.frames())).toContain('混合端口')
    // ESC 取消
    terminal.press(ESC)
    await delay()
    expect(textOf(terminal.frames())).toContain('❯ 混合端口')
    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).not.toContain('18080')

    // 再开，Ctrl+U 清空预填值后输入合法端口
    terminal.press(RETURN)
    await delay()
    terminal.press('\u0015') // Ctrl+U 清空
    for (const char of '18080') terminal.press(char)
    await delay()
    terminal.press(RETURN)
    await delay()
    expect(textOf(terminal.frames())).toContain('混合端口：17890 → 18080')
    terminal.press('y')
    await delay(150)
    expect(configYaml()['mixed-port']).toBe(18080)
  })

  it('日志级别：ListDialog 选择后确认生效', async () => {
    const terminal = mountView()
    await delay()
    for (let i = 0; i < 5; i += 1) terminal.press(DOWN) // → 日志级别
    await delay()
    terminal.press(RETURN)
    await delay()
    const text = textOf(terminal.frames())
    expect(text).toContain('╭─ 日志级别')
    expect(text).toContain('debug')
    expect(text).toContain('info')
    expect(text).toContain('当前')
    terminal.press(DOWN) // debug → info
    terminal.press(DOWN) // info → warning
    await delay()
    terminal.press(RETURN)
    await delay()
    expect(textOf(terminal.frames())).toContain('日志级别：info → warning')
    terminal.press('y')
    await delay(150)
    expect(configYaml()['log-level']).toBe('warning')
  })

  it('确认框 ESC 取消不触碰任何文件', async () => {
    const terminal = mountView()
    await delay()
    terminal.press(DOWN)
    await delay()
    terminal.press(RETURN) // 允许局域网确认框
    await delay()
    terminal.press(ESC)
    await delay()
    expect(textOf(terminal.frames())).toContain('❯ 允许局域网')
    expect(configYaml()['allow-lan']).toBe(false)
    expect(messages).toEqual([])
  })

  it('配置读取失败时渲染错误盒', async () => {
    writeFileSync(join(mihomoDir, 'config.yaml'), '{ broken', 'utf8')
    const terminal = mountView()
    await delay()
    expect(textOf(terminal.frames())).toContain('配置读取失败')
  })
})

// ---- CP2：内核区块（更新检查 / 版本列表 / 安装流 / 下载源）----
// 全局 fetch stub：release 列表、alpha、资产下载、/version 探针全部本地化，零真实网络

const NEW_VERSION_LINE = 'Mihomo Meta v1.19.30 linux amd64 with go1.26.2'
const gzOf = (content: string): Buffer => gzipSync(Buffer.from(content))

function stubGithubFetch(): Buffer {
  const gz = gzOf(`#!/bin/sh\necho "${NEW_VERSION_LINE}"\nexit 0\n`)
  const digest = `sha256:${createHash('sha256').update(gz).digest('hex')}`
  const releases = JSON.stringify([
    {
      tag_name: 'v1.19.30',
      published_at: '2026-09-01T00:00:00Z',
      prerelease: false,
      draft: false,
      assets: [{ name: 'mihomo-linux-amd64-v1.19.30.gz', size: gz.length, digest }],
    },
    {
      tag_name: 'v1.19.24',
      published_at: '2026-04-20T00:00:00Z',
      prerelease: false,
      draft: false,
      assets: [{ name: 'mihomo-linux-amd64-v1.19.24.gz', size: 1024 }],
    },
  ])
  const alpha = JSON.stringify({
    tag_name: 'Prerelease-Alpha',
    prerelease: true,
    assets: [{ name: 'mihomo-linux-amd64-alpha-deadbeef.gz', size: 100 }],
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/version')) {
        return new Response(JSON.stringify({ version: 'v1.19.30' }), { status: 200 })
      }
      if (url.includes('releases/download/')) return new Response(gz, { status: 200 })
      if (url.includes('tags/Prerelease-Alpha')) return new Response(alpha, { status: 200 })
      if (url.includes('/releases')) return new Response(releases, { status: 200 })
      return new Response('{}', { status: 200 })
    }),
  )
  return gz
}

describe('SettingsView 内核区块', () => {
  it('进入页面自动检查更新：显示「v1.19.30 可更新」', async () => {
    stubGithubFetch()
    const terminal = mountView()
    await delay(120)
    const text = textOf(terminal.frames())
    expect(text).toContain('v1.19.30 可更新')
  })

  it('切换版本：列表含稳定版/Alpha 分组与当前标记；确认框明示切换计划', async () => {
    stubGithubFetch()
    const terminal = mountView()
    await delay(120)
    for (let i = 0; i < 8; i += 1) terminal.press(DOWN) // → 切换版本
    await delay()
    terminal.press(RETURN)
    await delay(120)
    let text = textOf(terminal.frames())
    expect(text).toContain('╭─ 切换内核版本')
    expect(text).toContain('稳定版（最近 10 个）')
    expect(text).toContain('当前 · 2026-04-20') // v1.19.24 = 当前版本
    expect(text).toContain('Alpha 最新')
    // 选 v1.19.30（首个可选条目即高亮）
    terminal.press(RETURN)
    await delay()
    text = textOf(terminal.frames())
    expect(text).toContain('切换内核：v1.19.24 → v1.19.30')
    expect(text).toContain('失败自动回滚旧内核')
    // ESC 取消回到卡片页
    terminal.press(ESC)
    await delay()
    expect(textOf(terminal.frames())).toContain('❯ 切换版本')
  })

  it('完整安装流：确认后下载→校验→替换→重启→提示成功', async () => {
    stubGithubFetch()
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'bin', 'mihomo'), '#!/bin/sh\necho "old"\n', 'utf8')
    chmodSync(join(root, 'bin', 'mihomo'), 0o755)
    const terminal = mountView()
    await delay(120)
    for (let i = 0; i < 8; i += 1) terminal.press(DOWN)
    await delay()
    terminal.press(RETURN) // 打开版本列表
    await delay(120)
    terminal.press(RETURN) // 选 v1.19.30（首个可选条目）
    await delay()
    terminal.press('y') // 确认安装
    await delay(1200) // 探针首个 500ms 轮询为真实 sleep
    expect(messages).toContain('内核已切换到 v1.19.30')
    // 目标二进制已被替换为 stub 脚本内容
    expect(readFileSync(join(root, 'bin', 'mihomo'), 'utf8')).toContain(NEW_VERSION_LINE)
    // 归档落位
    expect(existsSync(join(root, 'kernels', 'v1.19.30', 'mihomo'))).toBe(true)
  })

  it('下载源切换立即保存到 config.json（不触碰内核配置）', async () => {
    stubGithubFetch()
    const terminal = mountView()
    await delay(120)
    for (let i = 0; i < 9; i += 1) terminal.press(DOWN) // → 下载源
    await delay()
    terminal.press(RETURN)
    await delay()
    let text = textOf(terminal.frames())
    expect(text).toContain('╭─ 下载源')
    expect(text).toContain('自动（推荐）')
    expect(text).toContain('ghfast.top')
    terminal.press(DOWN) // 自动 → 直连
    terminal.press(DOWN) // 直连 → gh-proxy.com
    await delay()
    terminal.press(RETURN)
    await delay()
    expect(messages).toContain('下载源已保存')
    const saved = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
    expect(saved.downloadSource).toEqual({ mode: 'gh-proxy.com' })
    expect(textOf(terminal.frames())).toContain('gh-proxy.com')
    // 内核配置不受影响
    expect(configYaml()['mixed-port']).toBe(17890)
  })
})

describe('SettingsView CP3 修复回归', () => {
  it('同版本短路：选当前版本提示「已是该版本」，不进入安装确认', async () => {
    stubGithubFetch()
    const terminal = mountView()
    await delay(120)
    for (let i = 0; i < 8; i += 1) terminal.press(DOWN) // → 切换版本
    await delay()
    terminal.press(RETURN) // 版本列表
    await delay(120)
    terminal.press(DOWN) // v1.19.30 → v1.19.24（当前）
    await delay()
    terminal.press(RETURN)
    await delay()
    expect(messages).toContain('已是该版本，无需切换')
    // 回到卡片页，从未出现安装确认
    const text = textOf(terminal.frames())
    expect(text).not.toContain('切换内核：v1.19.24 → v1.19.24')
    expect(text).toContain('❯ 切换版本')
  })

  it('可用更新行 Enter 强制重查：失败 → 成功后显示可更新', async () => {
    // 先让检查失败（无可达源）
    const terminal = mountView()
    await delay(150)
    expect(textOf(terminal.frames())).toContain('检查失败')
    // 换上可达源后强制重查
    stubGithubFetch()
    for (let i = 0; i < 7; i += 1) terminal.press(DOWN) // → 可用更新
    await delay()
    terminal.press(RETURN)
    await delay(200)
    expect(textOf(terminal.frames())).toContain('v1.19.30 可更新')
  })
})
