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
import { runProxyInit, runProxyOff, runProxyOn, runProxyStatus } from './commands/proxyEnv.js'
import { runProviderCheck, runProviderLs, runProviderUpdate } from './commands/provider.js'
import { runKernelInstall, runKernelLs, type KernelInstallOptions } from './commands/kernel.js'
import { runConnClose, runConnLs, runReload } from './commands/conn.js'
import { runLogs } from './commands/logs.js'
import { runRuleProviderLs, runRuleProviderUpdate, runRulesLs, runRulesTest } from './commands/rules.js'
import { EXIT, exitAfterFlush, reportError } from './commands/output.js'
import { VERSION } from './version.js'

const program = new Command()

program
  .name('mihomo-tui')
  .description('mihomo 内核的 CLI + TUI 管理工具（API 驱动，写配置仅限带备份与回滚的事务层）')
  .version(VERSION, '-V, --version', '显示本工具版本')
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

const proxy = program.command('proxy').description('代理组与节点操作；on/off 切换本 shell 的系统代理环境变量')

proxy
  .command('on')
  .description('开启系统代理：输出 export 代码（eval 执行），把本 shell 流量指向本机 mihomo 混合端口')
  .option('--json', '输出原始 JSON（含端口与 script）')
  .option('--port <n>', '显式指定混合端口，默认按「内核 /configs → config.yaml」发现')
  .option('--lan', 'no_proxy 追加私有网段（旧版 curl/wget 不识别 CIDR，默认关闭）')
  .option('--all', '同时设置 all_proxy（部分工具按 socks 语义解释，默认不设）')
  .option('--start', '内核离线时先拉起 systemd 用户服务')
  .action(wrap(async (options: { json?: boolean; port?: string; lan?: boolean; all?: boolean; start?: boolean }) =>
    runProxyOn(resolveConfig(), options),
  ))

proxy
  .command('off')
  .description('关闭系统代理：输出 unset 代码（eval 执行）；不访问内核，离线可用')
  .option('--json', '输出原始 JSON')
  .action(wrap(async (options: { json?: boolean }) => runProxyOff(resolveConfig(), options)))

proxy
  .command('status')
  .description('查看内核 mixed-port 与本 shell 代理环境变量的一致性')
  .option('--json', '输出原始 JSON')
  .action(wrap(async (options: { json?: boolean }) => runProxyStatus(resolveConfig(), options)))

proxy
  .command('init')
  .description('输出 shell 集成函数（proxy / proxy-on / proxy-off / proxy-tui）')
  .option('--json', '输出原始 JSON')
  .action(wrap(async (options: { json?: boolean }) => runProxyInit(resolveConfig(), options)))

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

const kernel = program.command('kernel').description('mihomo 内核版本管理（下载 / 安装 / 查看）')

kernel
  .command('ls')
  .description('查看生效与本地归档的内核版本，及远端最新稳定版')
  .option('--json', '输出原始 JSON')
  .action(wrap(async (options: { json?: boolean }) => runKernelLs(resolveConfig(), options)))

kernel
  .command('install')
  .argument('[version]', '内核版本（如 1.19.30 或 v1.19.30），缺省安装最新稳定版')
  .description('下载并安装内核；官方源失败自动回退镜像，并生成引导配置')
  .option('--alpha', '安装最新 alpha 版（按资产 sha 键控，避免装到陈旧构建）')
  .option('--port <n>', '引导配置的 external-controller 端口，默认 19090')
  .option('--mirror <prefix>', '自定义下载镜像前缀（形如 https://gh-proxy.com/），指定后不再回退其他源')
  .option('--json', '输出原始 JSON')
  .action(wrap(async (version: string | undefined, options: KernelInstallOptions) =>
    runKernelInstall(resolveConfig(), version, options),
  ))


const rules = program.command('rules').description('查看当前生效规则并测试命中')

rules
  .command('ls')
  .description('列出当前生效规则（按匹配优先级）')
  .option('--type <type>', '只看指定类型，如 DOMAIN-SUFFIX')
  .option('--json', '输出原始 JSON')
  .action(wrap(async (options: { json?: boolean; type?: string }) =>
    runRulesLs(resolveConfig(), options),
  ))

rules
  .command('test')
  .argument('<host>', '要测试的域名或 IP')
  .description('保守本地匹配域名/IP；依赖内核数据时返回无法判定')
  .option('--json', '输出原始 JSON')
  .action(wrap(async (host: string, options: { json?: boolean }) =>
    runRulesTest(resolveConfig(), host, options),
  ))

const ruleProvider = program
  .command('rule-provider')
  .description('规则集（rule-providers）管理')

ruleProvider
  .command('ls')
  .description('列出所有规则集')
  .option('--json', '输出原始 JSON')
  .action(wrap(async (options: { json?: boolean }) => runRuleProviderLs(resolveConfig(), options)))

ruleProvider
  .command('update')
  .argument('<name>', '规则集名称')
  .description('更新指定规则集（内核重新拉取）')
  .option('--json', '输出 JSON')
  .action(wrap(async (name: string, options: { json?: boolean }) => runRuleProviderUpdate(resolveConfig(), name, options)))

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
  try {
    const [v, c] = await Promise.all([client.version(), client.configs()])
    version = v.version
    mode = c.mode
  } catch (err) {
    reportError(err)
  }

  if (!process.stdout.isTTY) {
    process.stderr.write('TUI 需要交互式终端。管道场景请使用子命令，如 mihomo-tui proxy ls --json\n')
    process.exit(EXIT.usage)
  }

  const { render } = await import('ink')
  const { App } = await import('./App.js')
  const instance = render(<App config={config} version={version} mode={mode} />, {
    // 使用备用屏幕：TUI 运行在独立屏幕，退出后恢复到进入前的终端状态（类似 vim/htop）
    alternateScreen: true,
    exitOnCtrlC: false,
  })
  await instance.waitUntilExit()
  // mihomo 不回 WebSocket close 帧，句柄不释放 → 必须显式退出（SPEC 3.6）
  await exitAfterFlush(EXIT.ok)
})

program.parseAsync(process.argv).catch(reportError)
