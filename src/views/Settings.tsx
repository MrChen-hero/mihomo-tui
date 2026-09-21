/**
 * 标签页 5：设置（spec 2026-09-13 settings-kernel §3.1）。
 *
 * 基础设置：显示值一律读 config.yaml（「下次重启将生效」语义）；每次修改独立
 * 走「写配置 → 重启服务」事务（settingsService）：编辑对话框 → ConfirmDialog
 * 明示 旧值 → 新值 → 进度 → 结果。
 *
 * mihomo 内核区块：当前版本复用启动时 GET /version 的结果；进入本页自动检查
 * 更新（镜像回退，结果缓存）；切换版本走 installer 四段式（下载→校验→替换→
 * 重启确认，失败自动回滚）；下载源存 TUI 自身 config.json，与内核无关。
 *
 * 光标只在可操作行间移动，只读行（外部控制/当前版本/可用更新）dim 且跳过。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Box, Text, useInput } from 'ink'
import { ConfigManager } from '../config/manager.js'
import {
  LOG_LEVELS,
  SETTINGS_STEPS,
  SettingsError,
  applySettings,
  settingsDepsFromAppConfig,
  type SettingsChanges,
  type SettingsDeps,
} from '../config/settingsService.js'
import { ServiceManager } from '../config/service.js'
import { loadConfig, saveConfig, CONFIG_PATH, type DownloadSourceConfig } from '../config.js'
import {
  KERNELS_DIR_DEFAULT,
  InstallError,
  archiveKeyFor,
  archivedBinPath,
  installKernel,
  listArchivedTags,
  type InstallProgress,
} from '../kernel/installer.js'
import {
  fetchAlphaRelease,
  isNewerVersion,
  listStableReleases,
  selectAlphaAsset,
  selectAsset,
  type ReleaseAsset,
  type ReleaseInfo,
} from '../kernel/releases.js'
import { MihomoClient } from '../api/client.js'
import type { ParsedYaml } from '../config/types.js'
import type { AppConfig } from '../config.js'
import { ConfirmDialog } from '../components/ConfirmDialog.js'
import { InputDialog } from '../components/InputDialog.js'
import { ListDialog, type ListItem } from '../components/ListDialog.js'
import { ProgressDialog } from '../components/ProgressDialog.js'
import { Panel } from '../ui/Panel.js'
import { FooterLine } from '../ui/FooterLine.js'
import { colors, styles } from '../ui/theme.js'
import { displayWidth, padDisplay, truncateDisplay } from '../commands/output.js'
import type { LogLevel } from '../api/types.js'

export interface SettingsViewProps {
  config: AppConfig
  /** 启动时 GET /version 取到的内核版本 */
  version: string | undefined
  height: number
  width: number
  active: boolean
  onMessage: (text: string) => void
  /** 测试注入用；缺省时由 config 构造（真实 ConfigManager/ServiceManager） */
  serviceDeps?: SettingsDeps
  /** TUI 自身 config.json 路径（下载源保存目标）；测试注入 tmp 路径，默认真实路径 */
  configPath?: string
  /** 内核归档目录；测试注入 tmp 目录，默认 ~/.local/share/mihomo-tui/kernels */
  kernelsDir?: string
}

type RowKey =
  | 'port'
  | 'allowLan'
  | 'ipv6'
  | 'unifiedDelay'
  | 'tcpConcurrent'
  | 'logLevel'
  | 'dns'
  | 'controller'
  | 'version'
  | 'update'
  | 'switch'
  | 'source'

interface RowDef {
  key: RowKey
  label: string
  editable: boolean
  section: '基础设置' | 'mihomo 内核'
  /** 右栏「说明」行 */
  description?: string
  /** 右栏「取值」行（合法范围/可选值/开关枚举） */
  constraint?: string
  /** 右栏「影响」行（缺省时基础设置可编辑项用 IMPACT） */
  impact?: string
}

const ROWS: RowDef[] = [
  {
    key: 'port',
    label: '混合端口',
    editable: true,
    section: '基础设置',
    description: 'HTTP/SOCKS 混合代理监听端口',
    constraint: '1024 – 65535',
  },
  {
    key: 'allowLan',
    label: '允许局域网',
    editable: true,
    section: '基础设置',
    description: '允许局域网内其他设备经本机代理',
    constraint: '开 / 关',
  },
  {
    key: 'ipv6',
    label: 'IPv6',
    editable: true,
    section: '基础设置',
    description: '是否启用 IPv6 解析与出站',
    constraint: '开 / 关',
  },
  {
    key: 'unifiedDelay',
    label: '统一延迟',
    editable: true,
    section: '基础设置',
    description: '测速时去除节点固定延迟差，便于横向比较',
    constraint: '开 / 关',
  },
  {
    key: 'tcpConcurrent',
    label: 'TCP 并发',
    editable: true,
    section: '基础设置',
    description: '建立连接时并发探测多个地址，取最快者',
    constraint: '开 / 关',
  },
  {
    key: 'logLevel',
    label: '日志级别',
    editable: true,
    section: '基础设置',
    description: '内核日志输出级别，对应日志页可过滤',
    constraint: LOG_LEVELS.join(' / '),
  },
  {
    key: 'dns',
    label: 'DNS 接管',
    editable: true,
    section: '基础设置',
    description: '由内核接管系统 DNS 解析（fake-ip / 防污染）',
    constraint: '开 / 关',
  },
  {
    key: 'controller',
    label: '外部控制',
    editable: false,
    section: '基础设置',
    description: 'External Controller 地址，本工具经它读写内核',
  },
  {
    key: 'version',
    label: '当前版本',
    editable: false,
    section: 'mihomo 内核',
    description: '正在运行的 mihomo 内核版本（只读）',
  },
  {
    key: 'update',
    label: '可用更新',
    editable: true,
    section: 'mihomo 内核',
    description: '检查是否有更新的稳定版内核，Enter 重新检查',
    impact: '仅联网查询，不修改系统',
  },
  {
    key: 'switch',
    label: '切换版本',
    editable: true,
    section: 'mihomo 内核',
    description: '下载并切换到指定内核版本，失败自动回滚',
    impact: '下载 → 校验 → 替换二进制 → 重启服务',
  },
  {
    key: 'source',
    label: '下载源',
    editable: true,
    section: 'mihomo 内核',
    description: '内核与 release 信息的下载镜像源',
    impact: '仅影响后续下载，不重启服务',
  },
]

const ACTIONABLE: RowKey[] = ROWS.filter((row) => row.editable).map((row) => row.key)

/** 开关行：从显示值取当前态 + 构造对应变更 */
const TOGGLES: Partial<
  Record<RowKey, { get: (values: SettingsValues) => boolean; build: (next: boolean) => SettingsChanges }>
> = {
  allowLan: { get: (values) => values.allowLan, build: (next) => ({ 'allow-lan': next }) },
  ipv6: { get: (values) => values.ipv6, build: (next) => ({ ipv6: next }) },
  unifiedDelay: { get: (values) => values.unifiedDelay, build: (next) => ({ 'unified-delay': next }) },
  tcpConcurrent: { get: (values) => values.tcpConcurrent, build: (next) => ({ 'tcp-concurrent': next }) },
  dns: { get: (values) => values.dnsEnable, build: (next) => ({ dnsEnable: next }) },
}

/** 确认文案的影响行（所有基础设置修改共用） */
const IMPACT = '将写入 config.yaml 并重启服务，活动连接会瞬断数秒'

/** 右栏配置行：标签 + 内容 + 着色 + 是否可点改（editable=false 的行不可选） */
export interface PanelLine {
  /** 行标签（当前值/说明/取值/影响） */
  label: string
  text: string
  /** 内容着色（当前值用语义色，说明/取值/影响 dim） */
  color?: string
  /** 说明行：斜体 + dim（层次弱化，终端无字号概念） */
  italic?: boolean
  /** 是否可被选中并按 Enter 修改 */
  editable: boolean
}

/** 右栏配置行标签列宽（当前值/说明/取值/影响，CJK 各 6 显示列，+1 空格 = 7） */
const PANEL_LABEL_COL = 7

/**
 * 把一项设置收敛为右栏配置行列表（纯函数，可测）。
 * 行序固定：当前值 → 说明 → 取值 → 影响；缺省字段省略。
 * 可操作项（editable）所有行都可点改；只读项各行 editable=false。
 * 影响段：行定制 impact 优先，基础设置可编辑项回退 IMPACT，只读项无影响行。
 */
export function panelLines(
  row: RowDef,
  value: { text: string; color?: string },
): PanelLine[] {
  const lines: PanelLine[] = []
  // 当前值行恒存在
  lines.push({ label: '当前值', text: value.text, color: value.color, editable: row.editable })
  if (row.description) {
    lines.push({ label: '说明', text: row.description, color: colors.muted, italic: true, editable: row.editable })
  }
  if (row.constraint) {
    lines.push({ label: '取值', text: row.constraint, color: colors.muted, editable: row.editable })
  }
  const impact = row.impact ?? (row.editable && row.section === '基础设置' ? IMPACT : undefined)
  if (impact) {
    lines.push({ label: '影响', text: impact, color: colors.muted, editable: row.editable })
  }
  return lines
}

/** 标签列宽：取全部标签的最大显示宽 + 2（允许局域网 10 列 → 12） */
const LABEL_COL = Math.max(...ROWS.map((row) => displayWidth(row.label))) + 2

/** 内核安装的进度步骤（与 InstallPhase 一一对应） */
const INSTALL_STEPS = ['下载内核', '校验', '替换二进制', '重启服务', '确认状态'] as const
const PHASE_STEP: Record<InstallProgress['phase'], (typeof INSTALL_STEPS)[number]> = {
  download: '下载内核',
  verify: '校验',
  replace: '替换二进制',
  restart: '重启服务',
  confirm: '确认状态',
}

/** 内核版本候选：release 信息 + 资产 + 是否 alpha */
interface KernelCandidate {
  release?: ReleaseInfo
  asset?: ReleaseAsset
  alpha?: boolean
}

export interface SettingsValues {
  port: number | undefined
  allowLan: boolean
  ipv6: boolean
  unifiedDelay: boolean
  tcpConcurrent: boolean
  logLevel: string
  dnsEnable: boolean
  controller: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const boolText = (value: boolean): string => (value ? '开' : '关')

/** 绝对路径缩略显示（$HOME → ~） */
function prettyPath(path: string): string {
  const home = homedir()
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function downloadDetail(progress: InstallProgress): string | undefined {
  if (progress.phase !== 'download' || progress.received === undefined) return undefined
  return progress.total
    ? `${mb(progress.received)} / ${mb(progress.total)}（${Math.min(100, Math.round((progress.received / progress.total) * 100))}%）`
    : `已下载 ${mb(progress.received)}`
}

/** 从已解析的 config.yaml 收敛设置页显示值（与骨架同款兜底语义） */
export function parseSettingsValues(parsed: ParsedYaml): SettingsValues {
  const dns = isRecord(parsed['dns']) ? (parsed['dns'] as ParsedYaml) : undefined
  return {
    port: typeof parsed['mixed-port'] === 'number' ? parsed['mixed-port'] : undefined,
    allowLan: parsed['allow-lan'] === true,
    ipv6: parsed['ipv6'] !== false,
    unifiedDelay: parsed['unified-delay'] !== false,
    tcpConcurrent: parsed['tcp-concurrent'] !== false,
    logLevel: typeof parsed['log-level'] === 'string' ? parsed['log-level'] : 'info',
    dnsEnable: dns ? dns['enable'] !== false : true,
    controller:
      typeof parsed['external-controller'] === 'string' ? parsed['external-controller'] : '',
  }
}

type DialogState =
  | { type: 'port' }
  | { type: 'loglevel' }
  | { type: 'confirm'; changes: SettingsChanges; message: string[] }
  | { type: 'progress'; stepIndex: number; current: string; completed: string[] }
  | { type: 'error'; lines: string[] }
  | { type: 'versionLoading' }
  | { type: 'version'; items: ListItem[]; candidates: Map<string, KernelCandidate> }
  | {
      type: 'installConfirm'
      tag: string
      alpha: boolean
      asset?: ReleaseAsset
      fromArchive: boolean
      message: string[]
    }
  | { type: 'installProgress'; stepIndex: number; current: string; completed: string[]; detail?: string }
  | { type: 'source' }
  | { type: 'customSource' }

type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; latestTag: string }
  | { status: 'latest' }
  | { status: 'error'; error: string }

// 模块级缓存：SettingsView 随 tab 切换条件卸载，缓存放模块级才能做到
// 「结果缓存不随 tab 切换重查」（spec §3.1）
let moduleReleases: ReleaseInfo[] | undefined
let moduleUpdate: UpdateState | undefined

/** 测试用：清空模块级更新缓存（测试间隔离） */
export function resetSettingsCacheForTests(): void {
  moduleReleases = undefined
  moduleUpdate = undefined
}

export function SettingsView({
  config,
  version,
  height,
  width,
  active,
  onMessage,
  serviceDeps,
  configPath = CONFIG_PATH,
  kernelsDir = KERNELS_DIR_DEFAULT,
}: SettingsViewProps) {
  const [values, setValues] = useState<SettingsValues | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [dialog, setDialog] = useState<DialogState | undefined>(undefined)
  const [cursor, setCursor] = useState(0)
  // 左右栏焦点 + 右栏配置行光标（复用节点页双栏焦点模型）
  const [focus, setFocus] = useState<'nav' | 'panel'>('nav')
  const [panelCursor, setPanelCursor] = useState(0)
  const [update, setUpdateRaw] = useState<UpdateState>(moduleUpdate ?? { status: 'idle' })
  // 归一化：config 可能来自未含 downloadSource 的旧配置（缺省 auto）
  const [source, setSource] = useState<DownloadSourceConfig>(config.downloadSource ?? { mode: 'auto' })
  // release 列表缓存：更新检查与版本对话框共用，避免重复请求
  const [releases, setReleasesRaw] = useState<ReleaseInfo[] | undefined>(moduleReleases)

  // 写 state 的同时落模块级缓存（组件随 tab 切换卸载，缓存存活于模块）
  const setUpdate = (next: UpdateState): void => {
    moduleUpdate = next
    setUpdateRaw(next)
  }
  const setReleases = (list: ReleaseInfo[]): void => {
    moduleReleases = list
    setReleasesRaw(list)
  }

  const reload = (): void => {
    try {
      const parsed = new ConfigManager(config.mihomoDir, config.mihomoBin).loadConfig()
      setValues(parseSettingsValues(parsed))
      setLoadError(undefined)
    } catch (err) {
      setLoadError(errText(err))
    }
  }

  // 每次进入本页重读 config.yaml（覆盖本页外部的修改，如订阅事务的重生成）
  useEffect(() => {
    if (active) reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const sourceRef = useRef(source)
  sourceRef.current = source
  const releasesRef = useRef(releases)
  releasesRef.current = releases

  /** 更新检查：稳定版最新一版与当前比较；结果缓存，不随 tab 切换重查 */
  const checkUpdate = async (force = false): Promise<void> => {
    if (releasesRef.current?.length && !force) {
      applyUpdateResult(releasesRef.current)
      return
    }
    setUpdate({ status: 'checking' })
    try {
      const list = await listStableReleases({ sourceConfig: sourceRef.current })
      setReleases(list)
      applyUpdateResult(list)
    } catch (err) {
      setUpdate({ status: 'error', error: errText(err) })
    }
  }

  const applyUpdateResult = (list: ReleaseInfo[]): void => {
    const latest = list[0]?.tag
    if (!latest) {
      setUpdate({ status: 'error', error: 'release 列表为空' })
      return
    }
    setUpdate(
      version && !isNewerVersion(latest, version)
        ? { status: 'latest' }
        : { status: 'ok', latestTag: latest },
    )
  }

  // 进入本页触发一次性更新检查（只读 GET，失败不打扰）
  useEffect(() => {
    if (active && update.status === 'idle') void checkUpdate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const moveCursor = (step: 1 | -1): void => {
    setCursor((current) => (current + step + ACTIONABLE.length) % ACTIONABLE.length)
    // 左栏切项 → 右栏详情切换，面板光标归零到首行
    setPanelCursor(0)
  }

  const applyNow = (changes: SettingsChanges): void => {
    setDialog({ type: 'progress', stepIndex: 0, current: SETTINGS_STEPS[0]!.label, completed: [] })
    applySettings(changes, {
      ...(serviceDeps ?? settingsDepsFromAppConfig(config)),
      onProgress: (current, completed) => {
        setDialog({
          type: 'progress',
          stepIndex: SETTINGS_STEPS.indexOf(current),
          current: current.label,
          completed: completed.map((step) => step.label),
        })
      },
    })
      .then(() => {
        setDialog(undefined)
        reload()
        onMessage('设置已应用，服务已重启')
      })
      .catch((err) => {
        showError(err)
      })
  }

  const showError = (err: unknown): void => {
    const lines = [errText(err)]
    const detail =
      err instanceof SettingsError || err instanceof InstallError ? err.detail : undefined
    if (detail) {
      const inner = Math.max(20, width - 6)
      lines.push(
        ...detail
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => truncateDisplay(line, inner)),
      )
    }
    setDialog({ type: 'error', lines })
  }

  const confirmFor = (key: RowKey): void => {
    if (!values) return
    const row = ROWS.find((candidate) => candidate.key === key)
    if (!row) return
    if (key === 'port') {
      setDialog({ type: 'port' })
      return
    }
    if (key === 'logLevel') {
      setDialog({ type: 'loglevel' })
      return
    }
    const toggle = TOGGLES[key]
    if (!toggle) return
    const current = toggle.get(values)
    const next = !current
    setDialog({
      type: 'confirm',
      changes: toggle.build(next),
      message: [`${row.label}：${boolText(current)} → ${boolText(next)}`, IMPACT],
    })
  }

  /** 版本对话框：稳定版列表 + Alpha 最新 + 本机已下载（离线切换） */
  const openVersionDialog = async (): Promise<void> => {
    setDialog({ type: 'versionLoading' })
    try {
      const list = releasesRef.current?.length
        ? releasesRef.current
        : await listStableReleases({ sourceConfig: sourceRef.current })
      setReleases(list)
      let alpha: ReleaseInfo | undefined
      try {
        alpha = await fetchAlphaRelease({ sourceConfig: sourceRef.current })
      } catch {
        // alpha 为可选通道：拉取失败不影响稳定版列表
      }
      const archived = new Set(listArchivedTags(kernelsDir))
      const candidates = new Map<string, KernelCandidate>()
      const items: ListItem[] = [{ label: '稳定版（最近 10 个）', section: true }]
      for (const release of list.slice(0, 10)) {
        const asset = selectAsset(release, release.tag)
        candidates.set(release.tag, { release, asset })
        const hints = [
          release.tag === version ? '当前' : undefined,
          asset === undefined ? '无可用资产' : undefined,
          archived.has(archiveKeyFor(release.tag, false)) ? '已下载' : undefined,
          release.publishedAt?.slice(0, 10),
        ].filter((hint): hint is string => hint !== undefined)
        items.push({ value: release.tag, label: release.tag, ...(hints.length ? { hint: hints.join(' · ') } : {}) })
      }
      if (alpha) {
        const asset = selectAlphaAsset(alpha)
        if (asset) {
          candidates.set(alpha.tag, { release: alpha, asset, alpha: true })
          items.push({ label: '其他通道', section: true })
          const alphaArchived = archived.has(archiveKeyFor(alpha.tag, true, asset))
          items.push({
            value: alpha.tag,
            label: 'Alpha 最新',
            ...(alphaArchived ? { hint: '已下载' } : {}),
          })
        }
      }
      // alpha 归档键（Prerelease-Alpha-<sha>）不进「本机已下载」列表：
      // 离线切回旧 alpha 需要 sha 级验证信息，留作磁盘存档即可
      const archivedOnly = [...archived]
        .filter((key) => !candidates.has(key) && !key.startsWith('Prerelease-Alpha-'))
        .sort()
        .reverse()
      if (archivedOnly.length > 0) {
        items.push({ label: '本机已下载（离线切换）', section: true })
        for (const tag of archivedOnly) {
          items.push({ value: tag, label: tag, hint: '离线切换' })
          candidates.set(tag, {})
        }
      }
      if (candidates.size === 0) {
        throw new Error('没有可选的内核版本')
      }
      setDialog({ type: 'version', items, candidates })
    } catch (err) {
      setDialog({ type: 'error', lines: [errText(err)] })
    }
  }

  const onVersionPicked = (
    candidates: Map<string, KernelCandidate>,
    tag: string,
  ): void => {
    const candidate = candidates.get(tag) ?? {}
    const alpha = candidate.alpha ?? false
    // 同版本短路：目标就是当前稳定版时提示即可，不重复下载替换（spec §3.4）
    if (!alpha && tag === version) {
      setDialog(undefined)
      onMessage('已是该版本，无需切换')
      return
    }
    const asset = candidate.asset
    const fromArchive = existsSync(archivedBinPath(kernelsDir, archiveKeyFor(tag, alpha, asset)))
    const sizeLine = fromArchive
      ? '本机已有该版本，跳过下载直接切换'
      : asset?.size
        ? `下载约 ${mb(asset.size)}，替换 ${prettyPath(config.mihomoBin ?? '') || '~/bin/mihomo'} 并重启服务`
        : `替换 ${prettyPath(config.mihomoBin ?? '') || '~/bin/mihomo'} 并重启服务`
    setDialog({
      type: 'installConfirm',
      tag,
      alpha,
      asset,
      fromArchive,
      message: [`切换内核：${version ?? '未知'} → ${tag}`, sizeLine, '失败自动回滚旧内核'],
    })
  }

  const runInstall = (plan: {
    tag: string
    alpha: boolean
    asset?: ReleaseAsset
    fromArchive: boolean
  }): void => {
    const first = plan.fromArchive ? '校验' : '下载内核'
    setDialog({
      type: 'installProgress',
      stepIndex: INSTALL_STEPS.indexOf(first as (typeof INSTALL_STEPS)[number]),
      current: first,
      completed: [],
    })
    installKernel({ tag: plan.tag, asset: plan.asset, alpha: plan.alpha }, {
      mihomoBin: config.mihomoBin,
      kernelsDir,
      sourceConfig: source,
      // 复用注入的 ServiceManager（测试 stub）；缺省真实服务
      restart: () => (serviceDeps?.service ?? new ServiceManager()).restart(),
      isActive: () => (serviceDeps?.service ?? new ServiceManager()).isActive(),
      probeVersion: async () => {
        try {
          return (await new MihomoClient(config).version()).version
        } catch {
          return undefined
        }
      },
      onProgress: (progress) => {
        const stepName = PHASE_STEP[progress.phase]
        const stepIndex = INSTALL_STEPS.indexOf(stepName)
        setDialog({
          type: 'installProgress',
          stepIndex: Math.max(0, stepIndex),
          current: progress.message,
          completed: [...INSTALL_STEPS.slice(0, Math.max(0, stepIndex))],
          detail: downloadDetail(progress),
        })
      },
    })
      .then(({ fromArchive }) => {
        setDialog(undefined)
        onMessage(
          fromArchive
            ? `内核已切换到 ${plan.tag}（离线）`
            : `内核已切换到 ${plan.tag}`,
        )
      })
      .catch((err) => {
        showError(err)
      })
  }

  /** 下载源保存：写 TUI 自身 config.json（与内核无关，无需重启） */
  const saveSource = (next: DownloadSourceConfig): void => {
    try {
      saveConfig({ ...loadConfig(configPath), downloadSource: next }, configPath)
      setSource(next)
      setDialog(undefined)
      onMessage(
        next.mode === 'custom'
          ? `下载源已保存：自定义 ${next.customPrefix ?? ''}`
          : '下载源已保存',
      )
    } catch (err) {
      setDialog({ type: 'error', lines: [`保存下载源失败：${errText(err)}`] })
    }
  }

  const onRowEnter = (key: RowKey): void => {
    if (key === 'switch') {
      void openVersionDialog()
      return
    }
    if (key === 'source') {
      setDialog({ type: 'source' })
      return
    }
    if (key === 'update') {
      // 可用更新行：Enter 强制重查（检查失败后的重试入口）
      void checkUpdate(true)
      return
    }
    confirmFor(key)
  }

  // 当前项 key（左栏焦点所在的可操作项）；面板行派生见 valueOf 之后
  const currentKey: RowKey | undefined = ACTIONABLE[cursor]

  useInput(
    (input, key) => {
      // 按键期即时派生当前面板行（valueOf 声明在 useInput 之后，无法在模块顶层先算）
      const row = ROWS.find((r) => r.key === currentKey)
      const lines = row ? panelLines(row, valueOf(row)) : []
      const editableCount = lines.filter((line) => line.editable).length
      // ←→/hl 左右栏焦点互切；右栏仅当前项有可点改行时可入
      if (key.leftArrow || input === 'h') {
        setFocus('nav')
        return
      }
      if (key.rightArrow || input === 'l') {
        if (editableCount > 0) setFocus('panel')
        return
      }
      if (key.upArrow || input === 'k') {
        if (focus === 'nav') moveCursor(-1)
        else setPanelCursor((i) => Math.max(0, i - 1))
        return
      }
      if (key.downArrow || input === 'j') {
        if (focus === 'nav') moveCursor(1)
        else setPanelCursor((i) => Math.min(lines.length - 1, i + 1))
        return
      }
      if (key.return) {
        // 左栏与右栏 Enter 同入口：都进入当前项对话框（交互逻辑不变）
        if (currentKey) onRowEnter(currentKey)
      }
    },
    { isActive: active && !dialog },
  )

  // 双栏宽度（复用节点页机制）：左栏导航容纳最长标签+值缩写，右栏=余量
  // 确保双栏总宽与 TopBar 对齐
  const narrow = width < 100
  const navWidth = narrow ? width : Math.min(34, Math.floor(width * 0.34))
  const panelWidth = narrow ? width : width - navWidth
  // 矮终端（80×24 的 body 仅 18 行）去掉区块间空行，保证面板完整可见
  const spacious = height >= 20

  const valueOf = (row: RowDef): { text: string; color?: string } => {
    if (!values) return { text: '…', color: colors.muted }
    switch (row.key) {
      case 'port':
        return { text: values.port !== undefined ? String(values.port) : '—' }
      case 'allowLan':
        return { text: boolText(values.allowLan), color: values.allowLan ? colors.success : colors.muted }
      case 'ipv6':
        return { text: boolText(values.ipv6), color: values.ipv6 ? colors.success : colors.muted }
      case 'unifiedDelay':
        return {
          text: boolText(values.unifiedDelay),
          color: values.unifiedDelay ? colors.success : colors.muted,
        }
      case 'tcpConcurrent':
        return {
          text: boolText(values.tcpConcurrent),
          color: values.tcpConcurrent ? colors.success : colors.muted,
        }
      case 'logLevel':
        return { text: values.logLevel }
      case 'dns':
        return { text: boolText(values.dnsEnable), color: values.dnsEnable ? colors.success : colors.muted }
      case 'controller':
        return { text: values.controller || '—', color: colors.muted }
      case 'version':
        return { text: version ?? '未知', color: version ? undefined : colors.muted }
      case 'update':
        switch (update.status) {
          case 'checking':
            return { text: '检查中…', color: colors.muted }
          case 'ok':
            return { text: `${update.latestTag} 可更新`, color: colors.accent }
          case 'latest':
            return { text: '已是最新', color: colors.success }
          case 'error':
            return { text: '检查失败', color: colors.danger }
          default:
            return { text: '未检查', color: colors.muted }
        }
      case 'source':
        switch (source.mode) {
          case 'auto':
            return { text: '自动', color: colors.success }
          case 'direct':
            return { text: '直连' }
          case 'custom':
            return { text: truncateDisplay(source.customPrefix ?? '自定义', 24), color: colors.info }
          default:
            return { text: source.mode }
        }
      default:
        return { text: '' }
    }
  }

  /** 左栏值缩写：右栏已有完整值，左栏只显示短值（开关/版本/端口），超长截断 */
  const navValueWidth = Math.max(6, navWidth - LABEL_COL - 4)
  // 当前项与其右栏配置行（渲染期派生，供右栏面板与详情标题用）
  const currentRow: RowDef | undefined = ROWS.find((row) => row.key === currentKey)
  const currentPanelLines: PanelLine[] = currentRow ? panelLines(currentRow, valueOf(currentRow)) : []
  const renderNavRows = (): ReactNode[] => {
    const nodes: ReactNode[] = []
    let lastSection: string | undefined
    for (const row of ROWS) {
      if (row.section !== lastSection) {
        if (lastSection !== undefined && spacious) {
          nodes.push(<Box key={`gap-${row.section}`} height={1} />)
        }
        nodes.push(
          <Text key={`section-${row.section}`} {...styles.tableHeader}>{`  ${row.section}`}</Text>,
        )
        lastSection = row.section
      }
      const isCursor = row.editable && currentKey === row.key
      const value = valueOf(row)
      const bar = isCursor ? (focus === 'nav' ? '▌' : '❯') : ' '
      const barColor = isCursor ? (focus === 'nav' ? colors.accent : colors.muted) : undefined
      nodes.push(
        <Text key={row.key} wrap="truncate-end">
          <Text color={barColor} bold={isCursor && focus === 'nav'}>{`${bar} `}</Text>
          <Text {...(isCursor ? styles.rowSelected : {})}>{padDisplay(row.label, LABEL_COL)}</Text>
          {value.text !== '' ? (
            <Text color={value.color ?? (row.editable ? undefined : colors.muted)}>
              {truncateDisplay(value.text, navValueWidth)}
            </Text>
          ) : null}
        </Text>,
      )
    }
    return nodes
  }

  /** 右栏配置面板：当前项展开为可点改配置行（每行可 Enter 修改，等价左栏 Enter） */
  const renderPanel = (): ReactNode => {
    if (!currentRow) {
      return <Text dimColor>无可配置项</Text>
    }
    return (
      <Box flexDirection="column">
        <Box height={1} />
        {currentPanelLines.map((line, index) => {
          const isCursor = focus === 'panel' && line.editable && index === panelCursor
          const bar = isCursor ? '▌' : ' '
          const label = padDisplay(line.label, PANEL_LABEL_COL)
          return (
            <Text key={`${line.label}-${index}`} wrap="truncate-end">
              <Text color={isCursor ? colors.accent : undefined} bold={isCursor}>{`${bar} `}</Text>
              <Text {...(isCursor ? styles.rowSelected : {})} dimColor={!line.editable}>
                {label}
              </Text>
              <Text color={line.color} italic={line.italic} dimColor={line.italic || !line.editable}>
                {line.text}
              </Text>
            </Text>
          )
        })}
        {currentRow.editable ? (
          <Box marginTop={1}>
            <FooterLine
              hints={[{ key: '↑↓', label: '选择' }, { key: 'Enter', label: '修改' }]}
              width={panelWidth - 4}
            />
          </Box>
        ) : (
          <Text dimColor>只读</Text>
        )}
      </Box>
    )
  }

  if (dialog) {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        {dialog.type === 'port' ? (
          <InputDialog
            title="混合端口"
            width={width}
            fields={[
              {
                label: '混合端口',
                key: 'port',
                required: true,
                value: values?.port !== undefined ? String(values.port) : '',
                validate: (raw) => {
                  if (!/^\d+$/.test(raw)) return '端口必须是数字'
                  const port = Number(raw)
                  if (port < 1024 || port > 65535) return '端口必须在 1024–65535 之间'
                  return undefined
                },
              },
            ]}
            onSubmit={(result) => {
              const port = Number(result.port)
              setDialog({
                type: 'confirm',
                changes: { 'mixed-port': port },
                message: [`混合端口：${values?.port ?? '—'} → ${port}`, IMPACT],
              })
            }}
            onCancel={() => setDialog(undefined)}
          />
        ) : null}
        {dialog.type === 'loglevel' ? (
          <ListDialog
            borderTitle="日志级别"
            items={LOG_LEVELS.map((level) => ({
              value: level,
              label: level,
              hint: values?.logLevel === level ? '当前' : undefined,
            }))}
            onSubmit={(level) => {
              setDialog({
                type: 'confirm',
                changes: { 'log-level': level as LogLevel },
                message: [`日志级别：${values?.logLevel ?? '—'} → ${level}`, IMPACT],
              })
            }}
            onCancel={() => setDialog(undefined)}
          />
        ) : null}
        {dialog.type === 'confirm' ? (
          <ConfirmDialog
            message={dialog.message}
            enterConfirms
            width={Math.min(56, Math.max(40, width - 12))}
            onConfirm={() => applyNow(dialog.changes)}
            onCancel={() => setDialog(undefined)}
          />
        ) : null}
        {dialog.type === 'progress' ? (
          <ProgressDialog
            title="应用设置"
            current={dialog.current}
            total={SETTINGS_STEPS.length}
            step={dialog.stepIndex}
            completed={dialog.completed}
            width={48}
          />
        ) : null}
        {dialog.type === 'versionLoading' ? (
          <ProgressDialog
            title="切换内核"
            current="获取版本列表…"
            total={1}
            step={0}
            width={44}
          />
        ) : null}
        {dialog.type === 'version' ? (
          <ListDialog
            borderTitle="切换内核版本"
            items={dialog.items}
            maxVisible={Math.max(6, height - 10)}
            onSubmit={(value) => onVersionPicked(dialog.candidates, value)}
            onCancel={() => setDialog(undefined)}
          />
        ) : null}
        {dialog.type === 'installConfirm' ? (
          <ConfirmDialog
            message={dialog.message}
            enterConfirms
            width={Math.min(60, Math.max(44, width - 10))}
            onConfirm={() => runInstall(dialog)}
            onCancel={() => setDialog(undefined)}
          />
        ) : null}
        {dialog.type === 'installProgress' ? (
          <ProgressDialog
            title="切换内核"
            current={dialog.current}
            total={INSTALL_STEPS.length}
            step={dialog.stepIndex}
            completed={dialog.completed}
            detail={dialog.detail}
            width={52}
          />
        ) : null}
        {dialog.type === 'source' ? (
          <ListDialog
            borderTitle="下载源"
            items={[
              { value: 'auto', label: '自动（推荐）', hint: source.mode === 'auto' ? '当前' : '直连失败时回退镜像' },
              { value: 'direct', label: '直连 GitHub', hint: source.mode === 'direct' ? '当前' : undefined },
              { value: 'gh-proxy.com', label: 'gh-proxy.com', hint: source.mode === 'gh-proxy.com' ? '当前' : undefined },
              { value: 'ghfast.top', label: 'ghfast.top', hint: source.mode === 'ghfast.top' ? '当前' : '仅支持文件下载' },
              {
                value: 'custom',
                label: '自定义前缀…',
                hint: source.mode === 'custom' ? truncateDisplay(source.customPrefix ?? '', 20) : undefined,
              },
            ]}
            onSubmit={(value) => {
              if (value === 'custom') {
                setDialog({ type: 'customSource' })
                return
              }
              saveSource({ mode: value as Exclude<DownloadSourceConfig['mode'], 'custom'> })
            }}
            onCancel={() => setDialog(undefined)}
          />
        ) : null}
        {dialog.type === 'customSource' ? (
          <InputDialog
            title="自定义下载源"
            width={width}
            fields={[
              {
                label: '镜像前缀',
                key: 'prefix',
                required: true,
                value: source.customPrefix ?? '',
                placeholder: 'https://your-mirror.example/',
                validate: (raw) =>
                  /^https?:\/\/\S+$/.test(raw) ? undefined : '前缀必须是 http(s):// 开头的 URL',
              },
            ]}
            onSubmit={(result) => {
              const raw = result.prefix ?? ''
              const prefix = raw.endsWith('/') ? raw : `${raw}/`
              saveSource({ mode: 'custom', customPrefix: prefix })
            }}
            onCancel={() => setDialog(undefined)}
          />
        ) : null}
        {dialog.type === 'error' ? (
          <ConfirmDialog
            borderTitle="操作失败"
            danger
            message={dialog.lines}
            enterConfirms
            width={Math.min(64, Math.max(44, width - 8))}
            onConfirm={() => setDialog(undefined)}
            onCancel={() => setDialog(undefined)}
          />
        ) : null}
      </Box>
    )
  }

  if (loadError) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Panel danger title="配置读取失败" width={width}>
          <Text color={colors.danger} wrap="truncate-end">{loadError}</Text>
        </Panel>
      </Box>
    )
  }

  const navPanel = (
    <Panel title="◆ 设置" width={navWidth} fillHeight>
      {renderNavRows()}
    </Panel>
  )

  const detailPanel = (
    <Panel title={currentRow ? currentRow.label : '详情'} width={panelWidth} fillHeight>
      {renderPanel()}
    </Panel>
  )

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* row 容器让纵轴变交叉轴（默认 stretch）拉伸 Panel——column 直下内层
          flexGrow 是空操作（节点页同款机制） */}
      <Box flexDirection="row" flexGrow={1}>
        {narrow ? (focus === 'nav' ? navPanel : detailPanel) : (
          <>
            {navPanel}
            {detailPanel}
          </>
        )}
      </Box>
      <Box paddingLeft={1}>
        <FooterLine
          hints={[
            { key: '↑↓', label: '移动' },
            { key: '←→', label: '切栏' },
            { key: 'Enter', label: '修改' },
          ]}
          width={width - 2}
        />
      </Box>
    </Box>
  )
}
