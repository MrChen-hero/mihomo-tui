#!/usr/bin/env node
/**
 * commander 入口。无子命令时进入 TUI（检查点 5 接入），带子命令时走 CLI。
 * 所有子命令共享同一份 ~/.config/mihomo-tui/config.json，并支持 --json。
 */
import { Command, CommanderError } from 'commander'
import { MihomoClient } from './api/client.js'
import { loadConfig } from './config.js'
import { runStatus } from './commands/status.js'
import { runProxyLs, runProxyTest, runProxyUnfix, runProxyUse } from './commands/proxy.js'
import { runProviderCheck, runProviderLs, runProviderUpdate } from './commands/provider.js'
import { runConnClose, runConnLs, runReload } from './commands/conn.js'
import { runLogs } from './commands/logs.js'
import { EXIT, exitAfterFlush, reportError } from './commands/output.js'

const program = new Command()

program
  .name('mihomo-tui')
  .description('mihomo 内核的 CLI + TUI 管理工具（只通过 REST API 操作，不写 config.yaml）')
  .version('0.1.0', '-V, --version', '显示本工具版本')
  .option('--api <url>', '覆盖控制口地址，默认取配置文件中的 api')
  .option('--secret <token>', '覆盖控制口密钥')
  .showHelpAfterError('（用 --help 查看用法）')
  // commander 默认对参数错误用退出码 1，本项目约定参数错误为 2
  .exitOverride((err: CommanderError) => {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.help') {
      process.exit(EXIT.ok)
    }
    if (err.code === 'commander.version') process.exit(EXIT.ok)
    process.exit(err.exitCode === 0 ? EXIT.ok : EXIT.usage)
  })

/** 合并配置文件与全局选项，命令行优先 */
function resolveConfig() {
  const options = program.opts<{ api?: string; secret?: string }>()
  const config = loadConfig()
  if (options.api) config.api = options.api.replace(/\/+$/, '')
  if (options.secret !== undefined) config.secret = options.secret
  return config
}

/** 统一异常出口：把三类失败翻译成人话与退出码 */
function wrap<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  return async (...args: A) => {
    try {
      await fn(...args)
    } catch (err) {
      reportError(err)
    }
  }
}

program
  .command('status')
  .description('显示内核版本、模式、端口与 provider 概览')
  .option('--json', '输出原始 JSON')
  .action(wrap(async (options: { json?: boolean }) => runStatus(resolveConfig(), options)))

const proxy = program.command('proxy').description('代理组与节点操作')

proxy
  .command('ls')
  .argument('[group]', '代理组名；省略则列出所有代理组')
  .description('列出代理组及当前选中；带组名则列出该组节点与延迟')
  .option('--json', '输出原始 JSON')
  .action(wrap(async (group: string | undefined, options: { json?: boolean }) =>
    runProxyLs(resolveConfig(), group, options),
  ))

proxy
  .command('use')
  .argument('<group>', '代理组名')
  .argument('<name>', '节点名')
  .description('切换代理组当前选中节点')
  .option('--json', '输出原始 JSON')
  .action(wrap(async (group: string, name: string, options: { json?: boolean }) =>
    runProxyUse(resolveConfig(), group, name, options),
  ))

proxy
  .command('unfix')
  .argument('<group>', '代理组名')
  .description('解除 url-test/fallback 组的钉选，恢复自动选路')
  .option('--json', '输出原始 JSON')
  .action(wrap(async (group: string, options: { json?: boolean }) =>
    runProxyUnfix(resolveConfig(), group, options),
  ))

proxy
  .command('test')
  .argument('<group>', '代理组名')
  .description('整组延迟测试')
  .option('--json', '输出原始 JSON')
  .option('-u, --url <url>', '测速地址，默认取组自身的 testUrl')
  .option('-t, --timeout <ms>', '单节点超时（毫秒）')
  .action(wrap(async (group: string, options: { json?: boolean; url?: string; timeout?: string }) =>
    runProxyTest(resolveConfig(), group, options),
  ))

const provider = program.command('provider').description('订阅（proxy-providers）管理')

provider
  .command('ls')
  .description('列出所有 provider，含节点数、流量、到期与更新时间')
  .option('--json', '输出原始 JSON')
  .action(wrap(async (options: { json?: boolean }) => runProviderLs(resolveConfig(), options)))

provider
  .command('update')
  .argument('[name]', 'provider 名称；省略则更新全部')
  .description('更新订阅（内核重新拉取，不重启进程）')
  .option('--json', '输出原始 JSON')
  .action(wrap(async (name: string | undefined, options: { json?: boolean }) =>
    runProviderUpdate(resolveConfig(), name, options),
  ))

provider
  .command('check')
  .argument('<name>', 'provider 名称')
  .description('触发该 provider 的健康检查')
  .option('--json', '输出原始 JSON')
  .action(wrap(async (name: string, options: { json?: boolean }) =>
    runProviderCheck(resolveConfig(), name, options),
  ))

const conn = program.command('conn').description('连接管理')

conn
  .command('ls')
  .description('列出当前活跃连接')
  .option('--json', '输出原始 JSON')
  .option('-s, --sort <field>', '排序方式：traffic / time / host', 'traffic')
  .option('-n, --limit <count>', '最多显示多少条')
  .action(wrap(async (options: { json?: boolean; sort?: string; limit?: string }) =>
    runConnLs(resolveConfig(), options),
  ))

conn
  .command('close')
  .argument('[id]', '连接 ID，支持 ls 显示的 8 位前缀')
  .description('关闭指定连接，或用 --all 关闭全部')
  .option('--all', '关闭全部连接')
  .option('--json', '输出原始 JSON')
  .action(wrap(async (id: string | undefined, options: { all?: boolean; json?: boolean }) =>
    runConnClose(resolveConfig(), id, options),
  ))

program
  .command('logs')
  .description('实时日志')
  .option('-l, --level <level>', '日志级别：silent/error/warning/info/debug', 'info')
  .option('-f, --follow', '持续跟随，Ctrl+C 退出')
  .option('-n, --lines <count>', '非 follow 模式下收集多少条后退出', '20')
  .option('--idle <seconds>', '非 follow 模式下多久无新日志则退出', '5')
  .option('-g, --grep <pattern>', '按正则过滤（不区分大小写）')
  .option('--json', '每行输出原始 JSON')
  .action(wrap(async (options: {
    level?: string
    follow?: boolean
    lines?: string
    idle?: string
    grep?: string
    json?: boolean
  }) => runLogs(resolveConfig(), options)))

program
  .command('reload')
  .description('让内核热重载配置文件（本程序不写配置，只触发重读）')
  .option('-p, --path <path>', '配置文件路径，省略则用内核启动时的路径')
  .option('--json', '输出原始 JSON')
  .action(wrap(async (options: { json?: boolean; path?: string }) =>
    runReload(resolveConfig(), options),
  ))

program.action(async () => {
  // 无子命令 → 进入 TUI。
  // 先握一次 REST：内核不可达时给退出码 3，而不是渲染一个空界面让人猜。
  const config = resolveConfig()
  const client = new MihomoClient(config)
  let version: string | undefined
  let mode: 'rule' | 'global' | 'direct' | undefined
  let port: number | undefined
  try {
    const [v, c] = await Promise.all([client.version(), client.configs()])
    version = v.version
    mode = c.mode
    port = c['mixed-port']
  } catch (err) {
    reportError(err)
  }

  if (!process.stdout.isTTY) {
    process.stderr.write('TUI 需要交互式终端。管道场景请使用子命令，如 mihomo-tui proxy ls --json\n')
    process.exit(EXIT.usage)
  }

  const { render } = await import('ink')
  const { App } = await import('./App.js')
  const instance = render(<App config={config} version={version} mode={mode} port={port} />)
  await instance.waitUntilExit()
  // mihomo 不回 WebSocket close 帧，句柄不释放 → 必须显式退出（SPEC 3.6）
  await exitAfterFlush(EXIT.ok)
})

program.parseAsync(process.argv).catch(reportError)
