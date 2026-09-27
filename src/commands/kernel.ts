/**
 * kernel 命令组：CLI 侧的内核版本管理。
 *
 * 下载 / 校验 / 替换全部复用 src/kernel/installer.ts（与设置页同一套服务），
 * 这里只做三件事：版本与源的编排、无内核新机器的引导配置生成、收尾指引。
 * 引导配置是全项目唯一「创建而非事务修改」config.yaml 的路径：仅在文件
 * 不存在时写入最小骨架（存在则绝不触碰），因此不需要走备份回滚事务。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  KERNELS_DIR_DEFAULT,
  archivedBinPath,
  listArchivedTags,
  installKernel,
  type InstallProgress,
} from '../kernel/installer.js'
import {
  fetchAlphaRelease,
  listStableReleases,
  selectAlphaAsset,
  selectAsset,
} from '../kernel/releases.js'
import { MihomoClient } from '../api/client.js'
import { ServiceManager } from '../config/service.js'
import {
  installService,
  uninstallService,
  type ServiceExec,
  type ServiceFlavor,
} from '../kernel/serviceSetup.js'
import {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  type AppConfig,
  type DownloadSourceConfig,
} from '../config.js'
import { MIHOMO_BIN_DEFAULT, MIHOMO_DIR_DEFAULT } from '../config/manager.js'
import { EXIT, printJson } from './output.js'

/** controller 端口合法域，与 settingsService 的端口约束一致 */
const PORT_MIN = 1024
const PORT_MAX = 65535
/** 引导配置的代理端口：避开 7890 惯用值，降低与已有软件冲突的概率 */
const BOOTSTRAP_MIXED_PORT = 17890
const BOOTSTRAP_CONTROLLER_PORT = 19090

export interface KernelLsOptions {
  json?: boolean
}

export interface KernelInstallOptions {
  alpha?: boolean
  port?: string
  mirror?: string
  json?: boolean
}

/** 测试注入点：config.json 读写路径与 fetch 实现与归档目录；hasService=false 屏蔽服务接管 */
export interface KernelCommandDeps {
  configPath?: string
  fetchImpl?: typeof fetch
  kernelsDir?: string
  /** 缺省探测 systemd --user mihomo 单元；测试显式传 false 避免触达真实服务 */
  hasService?: boolean
}

function usageExit(message: string): never {
  process.stderr.write(`错误：${message}\n`)
  process.exit(EXIT.usage)
}

/** 控制口探活：端口上有任何 HTTP 响应（含 401）都视为「有实例在运行」 */
export async function probeController(port: number, fetchImpl?: typeof fetch): Promise<boolean> {
  try {
    await (fetchImpl ?? fetch)(`http://127.0.0.1:${port}/version`, {
      signal: AbortSignal.timeout(1500),
    })
    return true
  } catch {
    return false
  }
}

function controllerPortFromApi(api: string): number {
  try {
    const port = Number(new URL(api).port)
    if (Number.isInteger(port) && port > 0) return port
  } catch {
    // api 非法时走默认端口
  }
  return 19090
}

/** 本机的 systemd --user mihomo 服务是否处于运行态 */
function isServiceActiveHere(): boolean {
  const probe = spawnSync('systemctl', ['--user', 'is-active', 'mihomo'], { timeout: 2000 })
  return probe.stdout?.toString().trim() === 'active'
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return BOOTSTRAP_CONTROLLER_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    usageExit(`--port 必须是 ${PORT_MIN}-${PORT_MAX} 之间的整数，收到：${raw}`)
  }
  return port
}

function resolveSourceConfig(config: AppConfig, mirror: string | undefined): DownloadSourceConfig {
  if (mirror === undefined) return config.downloadSource
  if (!/^https?:\/\//.test(mirror)) {
    usageExit(`--mirror 必须是以 http(s):// 开头的镜像前缀，收到：${mirror}`)
  }
  return { mode: 'custom', customPrefix: mirror }
}

/** systemd --user 下是否存在 mihomo 单元（决定安装后是否自动重启服务） */
function hasSystemdUnit(): boolean {
  const probe = spawnSync('systemctl', ['--user', 'cat', 'mihomo'], { timeout: 2000 })
  return !probe.error && probe.status === 0
}

/** 生效二进制的版本行（mihomo -v 首行）；读不到返回 undefined */
function activeVersionLine(binPath: string): string | undefined {
  const probe = spawnSync(binPath, ['-v'], { timeout: 3000 })
  if (probe.error || probe.status !== 0) return undefined
  const line = (probe.stdout?.toString() ?? '').split('\n')[0]?.trim()
  return line ? line : undefined
}

function progressLine(progress: InstallProgress, lastPct: { value: number }): string | undefined {
  if (progress.phase === 'download' && progress.total) {
    const pct = Math.min(100, Math.floor((progress.received ?? 0) / progress.total * 100))
    if (pct - lastPct.value < 10 && pct < 100) return undefined
    lastPct.value = pct
    return `${progress.message} ${pct}%`
  }
  if (progress.phase === 'download') return progress.received ? `${progress.message} ${(progress.received / 1048576).toFixed(1)} MB` : undefined
  return progress.message
}

export interface ProgressWriterOptions {
  /** 缺省取 process.stderr.isTTY */
  tty?: boolean
  columns?: number
  /** 缺省写 stderr */
  write?: (text: string) => void
  /** 缺省 Date.now（测试注入） */
  now?: () => number
}

/**
 * 安装进度输出：TTY 用 \r 原位刷新单行进度条（与 TUI 用量条同款 #/- 字符，
 * 100ms 节流），非 TTY 退化为按 10% 分行（管道与 --json 消费者按行读取）。
 * 阶段切换（校验/替换/重启）先补换行收掉进度条，保证后续 ✓ 行落在行首。
 */
export function makeProgressWriter(options: ProgressWriterOptions = {}): (progress: InstallProgress) => void {
  const tty = options.tty ?? process.stderr.isTTY === true
  const write = options.write ?? ((text: string) => process.stderr.write(text))
  const now = options.now ?? Date.now
  const columns = options.columns ?? process.stderr.columns ?? 80
  let lastDrawAt = 0
  let lastDrawn = ''
  let lastPct = -100
  return (progress) => {
    if (!tty) {
      if (progress.phase === 'download' && progress.total) {
        const pct = Math.min(100, Math.floor((progress.received ?? 0) / progress.total * 100))
        if (pct - lastPct < 10 && pct < 100) return
        lastPct = pct
        write(`${progress.message} ${pct}%\n`)
        return
      }
      if (progress.phase === 'download') {
        if (progress.received) write(`${progress.message} ${(progress.received / 1048576).toFixed(1)} MB\n`)
        return
      }
      write(`${progress.message}\n`)
      return
    }
    if (progress.phase !== 'download') {
      if (lastDrawn) {
        write('\n')
        lastDrawn = ''
      }
      write(`${progress.message}\n`)
      return
    }
    const pct = progress.total ? Math.min(100, Math.floor((progress.received ?? 0) / progress.total * 100)) : undefined
    const t = now()
    if (t - lastDrawAt < 100 && lastDrawn && pct !== 100) return
    if (pct === undefined && !progress.received) return
    lastDrawAt = t
    const mb = (bytes: number | undefined): string => ((bytes ?? 0) / 1048576).toFixed(1)
    let line: string
    if (pct === undefined) {
      line = `${progress.message} ${mb(progress.received)} MB`
    } else {
      const barWidth = Math.max(10, Math.min(24, columns - progress.message.length - 18))
      const filled = Math.round((barWidth * pct) / 100)
      const bar = '#'.repeat(filled) + '-'.repeat(barWidth - filled)
      line = `${progress.message} [${bar}] ${pct}%${progress.total ? ` ${mb(progress.received)}/${mb(progress.total)} MB` : ''}`
    }
    write('\r' + line.padEnd(lastDrawn.length))
    lastDrawn = line
  }
}

export async function runKernelLs(
  config: AppConfig,
  options: KernelLsOptions = {},
  deps: KernelCommandDeps = {},
): Promise<void> {
  const binPath = config.mihomoBin ?? MIHOMO_BIN_DEFAULT
  const kernelsDir = deps.kernelsDir ?? KERNELS_DIR_DEFAULT
  const archived = listArchivedTags(kernelsDir)
  const active = activeVersionLine(binPath)

  let remote: { tag: string; publishedAt?: string }[] = []
  let remoteError: string | undefined
  try {
    const releases = await listStableReleases({ fetchImpl: deps.fetchImpl, sourceConfig: config.downloadSource })
    remote = releases.slice(0, 5).map((r) => ({ tag: r.tag, publishedAt: r.publishedAt }))
  } catch (err) {
    remoteError = err instanceof Error ? err.message : String(err)
  }

  if (options.json) {
    printJson({ active, archived, remote, ...(remoteError ? { remoteError } : {}) })
    return
  }
  const lines = [
    `生效内核：${active ?? '未检测到（' + binPath + '）'}`,
    `本地归档：${archived.length ? archived.join('、') : '无'}`,
  ]
  if (remoteError) lines.push(`远端查询失败：${remoteError}`)
  else
    lines.push(
      '远端最新稳定版：' +
        (remote.length ? remote.map((r) => r.tag).join('、') : '无'),
    )
  process.stdout.write(lines.join('\n') + '\n')
}

export async function runKernelInstall(
  config: AppConfig,
  versionArg: string | undefined,
  options: KernelInstallOptions = {},
  deps: KernelCommandDeps = {},
): Promise<void> {
  const port = parsePort(options.port)
  const sourceConfig = resolveSourceConfig(config, options.mirror)
  const fetchOptions = { fetchImpl: deps.fetchImpl, sourceConfig }
  const mihomoDir = config.mihomoDir || MIHOMO_DIR_DEFAULT
  const configYaml = join(mihomoDir, 'config.yaml')

  // 版本编排：--alpha → 滚动 alpha release；显式版本 → 列表里找 digest，找不到按
  // 命名规则构造（installer 会放弃 digest 校验但保留 -v 标记验证）；缺省 → 最新稳定版
  let tag: string
  let alpha = false
  let asset = undefined
  if (options.alpha) {
    const release = await fetchAlphaRelease(fetchOptions)
    const candidate = selectAlphaAsset(release)
    if (!candidate) throw new Error(`alpha release ${release.tag} 没有当前平台（${process.platform}/${process.arch}）的资产`)
    tag = release.tag
    asset = candidate
    alpha = true
  } else if (versionArg) {
    tag = versionArg.startsWith('v') ? versionArg : `v${versionArg}`
    if (!/^v\d/.test(tag)) usageExit(`版本号形如 1.19.30 或 v1.19.30，收到：${versionArg}`)
    // 显式版本且归档已存在 → 离线直装，不查远端（对齐设置页离线切换语义）
    const kernelsDir = deps.kernelsDir ?? KERNELS_DIR_DEFAULT
    if (!existsSync(archivedBinPath(kernelsDir, tag))) {
      const releases = await listStableReleases(fetchOptions)
      const release = releases.find((r) => r.tag === tag)
      asset = release ? selectAsset(release, tag) : undefined
    }
  } else {
    const releases = await listStableReleases(fetchOptions)
    const release = releases[0]
    if (!release) throw new Error('远端没有可用的稳定版 release')
    tag = release.tag
    asset = selectAsset(release, tag)
  }

  const serviceAttached = deps.hasService ?? hasSystemdUnit()
  // 全新机器上 ~/bin 往往不存在，installer 的原子替换（tmp 放目标同目录）会 ENOENT
  const binPath = config.mihomoBin ?? MIHOMO_BIN_DEFAULT
  mkdirSync(dirname(binPath), { recursive: true })
  const result = await installKernel(
    { tag, ...(asset ? { asset } : {}), ...(alpha ? { alpha: true } : {}) },
    {
      ...(config.mihomoBin ? { mihomoBin: config.mihomoBin } : {}),
      ...(deps.kernelsDir ? { kernelsDir: deps.kernelsDir } : {}),
      sourceConfig,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      onProgress: makeProgressWriter(),
      // systemd --user 单元存在时才接管重启与确认（与设置页同源）；新机器没有
      // 服务可重启，installer 对缺省 deps 自动跳过这两个阶段
      ...(serviceAttached
        ? {
            restart: () => new ServiceManager().restart(),
            isActive: () => new ServiceManager().isActive(),
            probeVersion: async () => {
              try {
                return (await new MihomoClient(config).version()).version
              } catch {
                return undefined
              }
            },
          }
        : {}),
    },
  )

  // 引导配置：仅创建、零覆盖。config.yaml 已存在说明用户有自己的配置，
  // 任何改动都必须走 ConfigManager 事务，这里碰都不碰。
  let configCreated = false
  if (!existsSync(configYaml)) {
    const body =
      `mixed-port: ${BOOTSTRAP_MIXED_PORT}\n` +
      `external-controller: 127.0.0.1:${port}\n` +
      'mode: rule\n' +
      'log-level: info\n'
    mkdirSync(mihomoDir, { recursive: true })
    const tmp = `${configYaml}.tmp`
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, configYaml)
    configCreated = true
  }

  // 控制口端口落到工具自身配置：仅当用户仍是默认 api 时改写；--api 是会话级
  // 覆盖（resolveConfig），不影响这里的持久化判断
  const desiredApi = `http://127.0.0.1:${port}`
  const fresh = loadConfig(deps.configPath)
  let apiState: 'updated' | 'already' | 'kept-custom' = 'already'
  if (fresh.api !== desiredApi) {
    if (fresh.api === DEFAULT_CONFIG.api) {
      saveConfig({ ...fresh, api: desiredApi }, deps.configPath)
      apiState = 'updated'
    } else {
      apiState = 'kept-custom'
    }
  }

  if (options.json) {
    printJson({
      tag: result.tag,
      alpha,
      fromArchive: result.fromArchive,
      bin: binPath,
      bootstrapConfig: { created: configCreated, path: configYaml, mixedPort: BOOTSTRAP_MIXED_PORT, controllerPort: port },
      api: { desired: desiredApi, state: apiState },
    })
    return
  }

  const lines = [
    `✓ 内核 ${result.tag}${alpha ? '（alpha）' : ''} 已安装：${binPath}` +
      (result.fromArchive ? '（离线归档复用）' : ''),
    configCreated ? `✓ 已生成引导配置 ${configYaml}` : `已有内核配置 ${configYaml}，未改动`,
  ]
  if (apiState === 'updated') lines.push(`✓ 控制口地址已写入工具配置（${desiredApi}）`)
  if (apiState === 'kept-custom') {
    lines.push(`已有自定义 api（${fresh.api}），未改动；新内核控制口为 ${desiredApi}`)
  }
  lines.push('')
  // 前台/守护进程冲突防呆：控制口已有实例在响应（且不是刚被我们重启的服务），
  // 说明旧实例还占着端口——提示重启它，而不是再起一个新实例
  const controllerBusy = serviceAttached ? false : await probeController(port, deps.fetchImpl)
  if (serviceAttached) {
    lines.push('检测到 systemd --user 服务：已自动重启内核并确认版本')
  } else if (controllerBusy) {
    lines.push(`⚠ 检测到端口 ${port} 已有内核实例在运行——重启它以加载新装的内核`)
    lines.push('或配置开机自启：mihomo-tui kernel service install（含冲突检测）')
  } else {
    lines.push(`下一步：${binPath} -d ${mihomoDir}     # 启动内核`)
    lines.push('或配置开机自启：mihomo-tui kernel service install')
  }
  lines.push('然后：mihomo-tui status     # 确认连接')
  process.stdout.write(lines.join('\n') + '\n')
}

export interface KernelServiceOptions {
  json?: boolean
}

export interface KernelServiceDeps {
  /** 注入执行器（测试用）；缺省 spawnSync */
  exec?: ServiceExec
  home?: string
  flavor?: ServiceFlavor
  user?: string
  /** 控制口探活注入（测试）；缺省真实 fetch */
  fetchImpl?: typeof fetch
  /** 注入服务运行态（测试）；缺省探测 systemctl is-active */
  isServiceActive?: boolean
  /** 注入 systemd 单元存在性（测试）；缺省真实探测。CI 无用户单元，相关测试必须显式注入 */
  hasSystemdUnit?: boolean
}

export async function runKernelServiceInstall(
  config: AppConfig,
  options: KernelServiceOptions = {},
  deps: KernelServiceDeps = {},
): Promise<void> {
  const input = {
    binPath: config.mihomoBin ?? MIHOMO_BIN_DEFAULT,
    mihomoDir: config.mihomoDir || MIHOMO_DIR_DEFAULT,
  }
  // 前台/守护进程冲突防呆：控制口已被一个「非服务实例」占用时（大概率是
  // 按收尾提示前台启动的进程），服务实例会绑定失败并静默劣化，必须先拦下
  const port = controllerPortFromApi(config.api)
  const controllerBusy = await probeController(port, deps.fetchImpl)
  const serviceActive = deps.isServiceActive ?? isServiceActiveHere()
  if (controllerBusy && !serviceActive && (deps.hasSystemdUnit ?? hasSystemdUnit())) {
    process.stderr.write(
      `错误：控制口端口 ${port} 已被其他 mihomo 实例占用（大概率是前台启动的进程）。\n` +
        '请先停止它（前台进程 Ctrl+C；或 pkill -f "bin/mihomo"），再执行 kernel service install。\n',
    )
    process.exit(EXIT.error)
  }

  const result = installService(input, deps)
  if (options.json) {
    printJson(result)
    return
  }
  if (result.flavor === 'unsupported') {
    process.stderr.write(`错误：${result.message}\n`)
    process.exit(EXIT.error)
  }
  const lines = [
    result.definitionCreated
      ? `✓ 服务定义已写入 ${result.definitionPath}`
      : `服务定义已存在（${result.definitionPath}），未改动`,
    result.enabled ? '✓ 服务已启动并设为开机自启' : '✗ 服务启用失败（--json 可查看 errors 明细）',
  ]
  if (result.lingerHint) lines.push(`提示：SSH 断开后保活需要一次提权：${result.lingerHint}`)
  lines.push(...result.errors.map((e) => `⚠ ${e}`))
  // 服务拉起后控制口仍未响应：端口仍被占用或内核启动失败，给排查入口
  if (result.enabled && !(await probeController(port, deps.fetchImpl))) {
    lines.push(`⚠ 控制口 ${port} 未响应——排查：journalctl --user -u mihomo`)
  }
  lines.push('验证：mihomo-tui status')
  process.stdout.write(lines.join('\n') + '\n')
  if (!result.enabled) process.exit(EXIT.error)
}

export async function runKernelServiceUninstall(
  _config: AppConfig,
  options: KernelServiceOptions = {},
  deps: KernelServiceDeps = {},
): Promise<void> {
  const result = uninstallService(deps)
  if (options.json) {
    printJson(result)
    return
  }
  if (result.flavor === 'unsupported') {
    process.stderr.write(`错误：${result.message}\n`)
    process.exit(EXIT.error)
  }
  const lines: string[] = []
  if (result.removed) lines.push('✓ 内核服务已停止并移除开机自启')
  else lines.push('✗ 服务卸载失败（--json 可查看 errors 明细）')
  lines.push(...result.errors.map((e) => `⚠ ${e}`))
  lines.push('内核二进制与配置保留在原位，需要彻底清理请手动删除')
  process.stdout.write(lines.join('\n') + '\n')
  if (!result.removed) process.exit(EXIT.error)
}
