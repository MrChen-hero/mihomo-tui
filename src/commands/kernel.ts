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
  if (progress.phase === 'download') return progress.received ? `${progress.message} ${(progress.received / 1024 / 1024).toFixed(1)} MB` : undefined
  return progress.message
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

  const lastPct = { value: -100 }
  const serviceAttached = deps.hasService ?? hasSystemdUnit()
  // 全新机器上 ~/bin 往往不存在，installer 的原子替换（tmp 放目标同目录）会 ENOENT
  const binPath = config.mihomoBin ?? MIHOMO_BIN_DEFAULT
  mkdirSync(dirname(binPath), { recursive: true })
  const result = await installKernel(    { tag, ...(asset ? { asset } : {}), ...(alpha ? { alpha: true } : {}) },
    {
      ...(config.mihomoBin ? { mihomoBin: config.mihomoBin } : {}),
      ...(deps.kernelsDir ? { kernelsDir: deps.kernelsDir } : {}),
      sourceConfig,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      onProgress: (progress) => {
        const line = progressLine(progress, lastPct)
        if (line) process.stderr.write(`${line}\n`)
      },
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
    configCreated
      ? `✓ 已生成引导配置 ${configYaml}（mixed-port ${BOOTSTRAP_MIXED_PORT}，控制口 127.0.0.1:${port}）`
      : `已有内核配置 ${configYaml}，未改动`,
    apiState === 'updated'
      ? `✓ 控制口地址已写入 ${deps.configPath ?? '~/.config/mihomo-tui/config.json'}`
      : apiState === 'kept-custom'
        ? `已有自定义 api（${fresh.api}），未改动；新内核控制口为 ${desiredApi}`
        : `控制口地址 ${desiredApi} 与现有配置一致`,
    serviceAttached
      ? '检测到 systemd --user 服务：已自动重启内核并确认版本'
      : `下一步：${binPath} -d ${mihomoDir}     # 启动内核（前台；长期运行建议配置 systemd --user 服务）`,
    '然后：mihomo-tui status               # 确认连接后即可正常使用',
  ]
  process.stdout.write(lines.join('\n') + '\n')
}
