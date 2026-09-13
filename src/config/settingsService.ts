/**
 * 设置事务（spec 2026-09-13 settings-kernel §3.2）：把设置页的修改写入
 * config.yaml 并重启服务生效。与订阅事务同一套骨架——备份 → mihomo -t 校验
 * → 原子写 → 写后复验 → 重启 → 确认——但不触碰订阅清单。
 *
 * 回滚表同设计稿 6.1：动了配置就从备份还原并再重启；回滚本身失败时把
 * 原错误与回滚错误一起上抛，绝不静默。
 *
 * 变更字段全部是 buildSkeleton 的 pick* 管辖字段：改完写回 oldConfig 再
 * 重新生成骨架即可持久化（后续增删订阅不会丢）。dns.enable 由骨架从旧配置
 * 派生（本模块直接写 dns 段），因此同样持久。
 */
import YAML from 'yaml'
import { ConfigManager } from './manager.js'
import { ServiceManager } from './service.js'
import { buildSkeleton } from './skeleton.js'
import { loadSubscriptions } from './subscriptions.js'
import type { LogLevel } from '../api/types.js'
import type { AppConfig } from '../config.js'
import type { ParsedYaml } from './types.js'

export interface SettingsChanges {
  'mixed-port'?: number
  'allow-lan'?: boolean
  ipv6?: boolean
  'unified-delay'?: boolean
  'tcp-concurrent'?: boolean
  'log-level'?: LogLevel
  /** DNS 接管（config.yaml 的 dns.enable） */
  dnsEnable?: boolean
}

export interface SettingsStep {
  key: string
  label: string
}

export type SettingsProgress = (current: SettingsStep, completed: SettingsStep[]) => void

export const SETTINGS_STEPS: SettingsStep[] = [
  { key: 'read', label: '读取配置' },
  { key: 'generate', label: '生成新配置' },
  { key: 'backup', label: '备份旧配置' },
  { key: 'write', label: '校验并写入' },
  { key: 'restart', label: '重启服务' },
  { key: 'verify', label: '确认服务状态' },
]

export class SettingsError extends Error {
  constructor(
    message: string,
    readonly step: string,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'SettingsError'
  }
}

export interface SettingsDeps {
  /** 订阅清单路径，默认 ~/.config/mihomo-tui/subscriptions.json */
  subscriptionsPath?: string
  manager?: ConfigManager
  service?: ServiceManager
  /** 重启后确认前的宽限毫秒数，默认 1500 */
  graceMs?: number
  sleep?: (ms: number) => Promise<void>
  onProgress?: SettingsProgress
}

/** 从应用配置构造事务依赖；测试通过 overrides 注入临时目录与 stub 二进制 */
export function settingsDepsFromAppConfig(
  config: AppConfig,
  overrides: Partial<SettingsDeps> = {},
): SettingsDeps {
  return {
    manager: new ConfigManager(config.mihomoDir, config.mihomoBin),
    service: new ServiceManager(),
    ...overrides,
  }
}

export const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warning', 'error', 'silent']

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 变更合法性在改动任何文件之前完成；非法输入抛 SettingsError（step 'validate'） */
export function validateChanges(changes: SettingsChanges): void {
  const port = changes['mixed-port']
  if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
    throw new SettingsError(`端口必须是 1024–65535 的整数，收到 ${port}`, 'validate')
  }
  const level = changes['log-level']
  if (level !== undefined && !LOG_LEVELS.includes(level)) {
    throw new SettingsError(`日志级别必须是 ${LOG_LEVELS.join('/')}，收到 ${level}`, 'validate')
  }
}

/** 把变更套到已解析的 config.yaml 对象上（就地修改） */
export function applyChangesToConfig(old: ParsedYaml, changes: SettingsChanges): void {
  if (changes['mixed-port'] !== undefined) old['mixed-port'] = changes['mixed-port']
  if (changes['allow-lan'] !== undefined) old['allow-lan'] = changes['allow-lan']
  if (changes['ipv6'] !== undefined) old['ipv6'] = changes['ipv6']
  if (changes['unified-delay'] !== undefined) old['unified-delay'] = changes['unified-delay']
  if (changes['tcp-concurrent'] !== undefined) old['tcp-concurrent'] = changes['tcp-concurrent']
  if (changes['log-level'] !== undefined) old['log-level'] = changes['log-level']
  if (changes.dnsEnable !== undefined) {
    const dns = isRecord(old['dns']) ? (old['dns'] as ParsedYaml) : (old['dns'] = {} as ParsedYaml)
    dns['enable'] = changes.dnsEnable
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 应用设置变更：写 config.yaml 并重启服务。进度经 onProgress 上报（步骤引用取自 SETTINGS_STEPS）。 */
export async function applySettings(
  changes: SettingsChanges,
  deps: SettingsDeps = {},
): Promise<{ warnings: string[] }> {
  validateChanges(changes)
  // 全空变更不动文件也不重启（防御；正常调用方总是带一个明确变更）
  if (Object.values(changes).every((value) => value === undefined)) {
    return { warnings: [] }
  }
  const manager = deps.manager ?? new ConfigManager()
  const service = deps.service ?? new ServiceManager()
  const sleep = deps.sleep ?? defaultSleep
  const graceMs = deps.graceMs ?? 1500
  const onProgress = deps.onProgress

  const completed: SettingsStep[] = []
  const begin = (step: SettingsStep): void => onProgress?.(step, [...completed])
  const finish = (step: SettingsStep): void => {
    completed.push(step)
  }
  const stepOf = (key: string): SettingsStep => {
    const found = SETTINGS_STEPS.find((candidate) => candidate.key === key)
    if (!found) throw new SettingsError(`未知步骤 ${key}`, key)
    return found
  }

  let backupPath: string | undefined
  let configWritten = false

  try {
    begin(stepOf('read'))
    const subs = loadSubscriptions(deps.subscriptionsPath)
    const old = manager.loadConfig()
    finish(stepOf('read'))

    begin(stepOf('generate'))
    applyChangesToConfig(old, changes)
    const { skeleton, warnings } = buildSkeleton(old, subs)
    const yamlText = YAML.stringify(skeleton, { lineWidth: 0, singleQuote: true })
    finish(stepOf('generate'))

    begin(stepOf('backup'))
    backupPath = manager.backup()
    finish(stepOf('backup'))

    begin(stepOf('write'))
    const pre = manager.validate(yamlText)
    if (!pre.ok) {
      throw new SettingsError('生成的配置未通过校验，已中止写入', 'write', pre.output)
    }
    manager.writeConfig(yamlText)
    configWritten = true
    const post = manager.validate(manager.readConfigText())
    if (!post.ok) {
      manager.rollback(backupPath)
      configWritten = false
      throw new SettingsError('配置写入后校验失败（配置已回滚）', 'write', post.output)
    }
    manager.ensureProvidersDir()
    finish(stepOf('write'))

    begin(stepOf('restart'))
    await service.restart()
    await sleep(graceMs)
    finish(stepOf('restart'))

    begin(stepOf('verify'))
    if (!(await service.isActive())) {
      manager.rollback(backupPath!)
      configWritten = false
      await service.restart()
      throw new SettingsError('服务启动失败（已回滚）', 'verify', await service.status())
    }
    finish(stepOf('verify'))

    return { warnings }
  } catch (err) {
    if (configWritten && backupPath) {
      try {
        manager.rollback(backupPath)
        await service.restart()
      } catch (rollbackErr) {
        throw new SettingsError(
          `${msg(err)}；回滚失败：${msg(rollbackErr)}`,
          err instanceof SettingsError ? err.step : 'write',
        )
      }
    }
    throw err
  }
}
