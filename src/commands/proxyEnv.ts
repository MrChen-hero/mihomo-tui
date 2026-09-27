/**
 * proxy on/off/status/init：本 shell 系统代理环境变量的开关。
 *
 * 核心约束：CLI 子进程改不了父 shell 的环境变量，所以「开关」由这里算好、
 * 打印成 shell 代码（emit-eval 模式），由父 shell eval 执行。
 * stdout 纯净契约：成功时 stdout 只能是 shell 代码（诊断走 stderr）；
 * 失败时 stdout 必须为空——`eval "$(…)"` 才是安全空操作。
 */
import { MihomoClient, KernelUnreachableError } from '../api/client.js'
import type { AppConfig } from '../config.js'
import { ConfigManager } from '../config/manager.js'
import { ServiceManager } from '../config/service.js'
import { EXIT, printJson } from './output.js'

/** proxy on 设置的固定变量；off 的 unset 全集必须覆盖它（含 all_proxy） */
export const ON_VARS = ['http_proxy', 'https_proxy', 'no_proxy', 'MIHOMO_PROXY_ENV'] as const
/** --all 时追加；部分工具把 all_proxy 按 socks 语义解释，故默认不设 */
export const OPTIONAL_VARS = ['all_proxy'] as const
/** off 清空的全集 = on 的全集。改 ON_VARS/OPTIONAL_VARS 必须同步这里 */
export const UNSET_VARS: readonly string[] = [...ON_VARS, ...OPTIONAL_VARS]

/** no_proxy 默认最小集：CIDR 写法在旧版 curl/wget 中不被识别，私有网段交给 --lan 显式追加 */
const NO_PROXY_BASE = ['localhost', '127.0.0.1', '::1']
const NO_PROXY_LAN = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']

const USAGE_HINT =
  '提示：已输出 shell 代码，请 eval 执行（如 eval "$(mihomo-tui proxy on)"）；或先装集成：eval "$(mihomo-tui proxy init)"'

export interface ProxyOnScriptOptions {
  port: number
  lan?: boolean
  all?: boolean
}

/** 生成 proxy on 的 shell 代码。port 必须是 1-65535 整数（调用方保证，防注入） */
export function buildProxyOnScript({ port, lan = false, all = false }: ProxyOnScriptOptions): string {
  const host = `http://127.0.0.1:${port}`
  const noProxy = lan ? [...NO_PROXY_BASE, ...NO_PROXY_LAN] : [...NO_PROXY_BASE]
  const lines = [
    `export http_proxy='${host}'`,
    `export https_proxy='${host}'`,
    ...(all ? [`export all_proxy='${host}'`] : []),
    `export no_proxy='${noProxy.join(',')}'`,
    `export MIHOMO_PROXY_ENV='${port}'`,
  ]
  return lines.join('\n') + '\n'
}

/** 生成 proxy off 的 shell 代码：清空全集，不触碰清单之外的用户变量 */
export function buildProxyOffScript(): string {
  return UNSET_VARS.map((name) => `unset ${name}`).join('\n') + '\n'
}

export const PROXY_INIT_HINT = 'eval "$(mihomo-tui proxy init)"'

/** 生成 shell 集成函数：bash/zsh。函数名含连字符非严格 POSIX（dash 不可用），属有意取舍 */
export function buildProxyInitScript(): string {
  return [
    '# mihomo-tui shell integration —— 安装：echo \'eval "$(mihomo-tui proxy init)"\' >> ~/.bashrc',
    'proxy() {',
    '  case "${1:-tui}" in',
    '    on)     shift; eval "$(command mihomo-tui proxy on "$@")";;',
    '    off)    shift; eval "$(command mihomo-tui proxy off "$@")";;',
    '    status) shift; command mihomo-tui proxy status "$@";;',
    '    tui)    shift; command mihomo-tui "$@";;',
    '    *)      command mihomo-tui "$@";;',
    '  esac',
    '}',
    'proxy-on()  { proxy on "$@"; }',
    'proxy-off() { proxy off "$@"; }',
    'proxy-tui() { proxy tui "$@"; }',
    '',
  ].join('\n')
}

/**
 * 端口发现链：--port > 内核 GET /configs 的 mixed-port > config.yaml 兜底。
 * 绝不硬编码默认端口。内核不可达且文件兜底失败时重抛 KernelUnreachableError
 * （reportError 翻译为退出码 3）；仅文件缺失时抛普通错误（退出码 1）。
 */
export async function resolveProxyPort(
  config: AppConfig,
  portFlag: number | undefined,
  start = false,
): Promise<number> {
  if (portFlag !== undefined) return portFlag
  const client = new MihomoClient(config)
  let unreachable: unknown
  try {
    const mixed = validPort((await client.configs())['mixed-port'])
    if (mixed !== undefined) return mixed
  } catch (err) {
    if (!(start && err instanceof KernelUnreachableError)) {
      unreachable = err
    } else {
      // --start：先拉起 systemd 用户服务再等控制口就绪；等待超时如实抛 unreachable
      await new ServiceManager().start()
      await waitKernelReady(client)
      const mixed = validPort((await client.configs())['mixed-port'])
      if (mixed !== undefined) return mixed
    }
  }
  const fromFile = configYamlPort(config)
  if (fromFile !== undefined) return fromFile
  throw unreachable ?? new Error('无法确定混合端口：config.yaml 未配置有效的 mixed-port')
}

/** 控制口就绪轮询：ServiceManager.start 返回 ≠ API 已监听，最多等 10 秒 */
async function waitKernelReady(client: MihomoClient): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      await client.version()
      return
    } catch (err) {
      if (Date.now() > deadline) throw err
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

/** 端口合法性：1-65535 整数。非法值视同「未发现」，落到发现链下一级 */
function validPort(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
    ? value
    : undefined
}

/** 只读兜底：config.yaml 的 mixed-port（复用事务层的只读解析入口） */
function configYamlPort(config: AppConfig): number | undefined {
  try {
    const parsed = new ConfigManager(config.mihomoDir, config.mihomoBin).loadConfig()
    return validPort(parsed['mixed-port'])
  } catch {
    return undefined
  }
}

function parsePortFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const port = validPort(Number(value))
  if (port === undefined) {
    process.stderr.write(`错误：--port 必须是 1-65535 的整数：${value}\n`)
    process.exit(EXIT.usage)
  }
  return port
}

/** stdout 只写 shell 代码；TTY 场景把用法提示放 stderr，管道场景保持纯净 */
function emitScript(script: string): void {
  process.stdout.write(script)
  if (process.stdout.isTTY) process.stderr.write(USAGE_HINT + '\n')
}

export interface ProxyOnFlags {
  json?: boolean
  port?: string
  lan?: boolean
  all?: boolean
  start?: boolean
}

export async function runProxyOn(config: AppConfig, options: ProxyOnFlags): Promise<void> {
  const port = await resolveProxyPort(config, parsePortFlag(options.port), options.start ?? false)
  if (options.json) {
    printJson({ port, lan: options.lan ?? false, all: options.all ?? false, script: buildProxyOnScript({ port, lan: options.lan, all: options.all }) })
    return
  }
  emitScript(buildProxyOnScript({ port, lan: options.lan, all: options.all }))
}

export async function runProxyOff(_config: AppConfig, options: { json?: boolean }): Promise<void> {
  if (options.json) {
    printJson({ unset: UNSET_VARS })
    return
  }
  emitScript(buildProxyOffScript())
}

export async function runProxyStatus(config: AppConfig, options: { json?: boolean }): Promise<void> {
  let kernelPort: number | undefined
  let reachable = true
  try {
    kernelPort = (await new MihomoClient(config).configs())['mixed-port']
    if (typeof kernelPort !== 'number' || kernelPort <= 0) kernelPort = undefined
  } catch {
    reachable = false
  }
  const probe = process.env['MIHOMO_PROXY_ENV']
  const active = probe !== undefined && probe !== ''
  const httpProxy = process.env['http_proxy']
  const consistent = active && reachable && kernelPort !== undefined ? String(kernelPort) === probe : null

  if (options.json) {
    printJson({
      kernel: { reachable, mixedPort: kernelPort ?? null },
      shell: { active, port: active ? (probe ?? null) : null, httpProxy: httpProxy || null, consistent },
    })
    return
  }
  const lines = [
    reachable && kernelPort !== undefined ? `内核：可达，mixed-port ${kernelPort}` : '内核：不可达或未报告 mixed-port',
    active ? `本 shell：已开启（MIHOMO_PROXY_ENV=${probe}）` : '本 shell：未开启',
    `http_proxy：${httpProxy || '未设置'}`,
  ]
  if (consistent === false) lines.push('端口不一致：内核 mixed-port 已变化，请重新执行 proxy on')
  process.stdout.write(lines.join('\n') + '\n')
}

export async function runProxyInit(_config: AppConfig, options: { json?: boolean }): Promise<void> {
  if (options.json) {
    printJson({ shell: 'bash/zsh（POSIX sh）', install: `echo '${PROXY_INIT_HINT}' >> ~/.bashrc` })
    return
  }
  process.stdout.write(buildProxyInitScript())
}
