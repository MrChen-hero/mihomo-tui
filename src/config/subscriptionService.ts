/**
 * 订阅生命周期编排（设计稿 §6，补齐其 3.2 依赖图中缺失的 SubscriptionService 层）。
 *
 * 事务模型：订阅清单（subscriptions.json）、config.yaml、mihomo 服务三者
 * 必须一起变更或一起回到原状。任何一步失败按设计稿 6.1 回滚表恢复：
 *   - 动过 config.yaml → 从备份回滚并重启服务；
 *   - 动过清单 → 从内存中的旧清单恢复；
 *   - 回滚本身失败 → 把原错误与回滚错误一起上抛，绝不静默。
 *
 * 本模块不直接被 TUI 之外的入口调用；进度通过 onProgress 上报，
 * 重启后的 1.5s 宽限等待与 sleep 都可注入，测试无需真实计时。
 */
import YAML from 'yaml'
import { existsSync, writeFileSync } from 'node:fs'
import type { AppConfig } from '../config.js'
import { ConfigManager } from './manager.js'
import { ServiceManager } from './service.js'
import { buildSkeleton } from './skeleton.js'
import {
  isDuplicateName,
  loadSubscriptions,
  prefixFromName,
  saveSubscriptions,
  validateSubscription,
} from './subscriptions.js'
import type { Subscription } from './types.js'

export type StepKey =
  | 'validate'
  | 'manifest'
  | 'generate'
  | 'backup'
  | 'write'
  | 'cache'
  | 'restart'
  | 'verify'

export interface Step {
  key: StepKey
  label: string
}

export type ProgressFn = (current: Step, completed: Step[]) => void

export interface ServiceDeps {
  /** 订阅清单路径，默认 ~/.config/mihomo-tui/subscriptions.json */
  subscriptionsPath?: string
  manager?: ConfigManager
  service?: ServiceManager
  /** 重启后确认前的宽限毫秒数，默认 1500 */
  graceMs?: number
  sleep?: (ms: number) => Promise<void>
  onProgress?: ProgressFn
}

export class SubscriptionError extends Error {
  constructor(
    message: string,
    readonly step: StepKey,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'SubscriptionError'
  }
}

export const ADD_STEPS: Step[] = [
  { key: 'validate', label: '校验输入' },
  { key: 'manifest', label: '更新订阅清单' },
  { key: 'generate', label: '生成新配置' },
  { key: 'backup', label: '备份旧配置' },
  { key: 'write', label: '校验并写入' },
  { key: 'restart', label: '重启服务' },
  { key: 'verify', label: '确认服务状态' },
]

export const DELETE_STEPS: Step[] = [
  ...ADD_STEPS,
  { key: 'cache', label: '清理订阅缓存' },
]

/** 编辑与新增共用同一套步骤（差异只在第 1 步的校验内容） */
export const EDIT_STEPS: Step[] = ADD_STEPS

export interface AddSubscriptionInput {
  name: string
  url?: string
  prefix?: string
  /** 缺省 remote，保持旧调用兼容 */
  type?: 'remote' | 'local'
  group?: string
  /** 自动更新间隔（分钟），空表示禁用 */
  interval?: number
}

/** 编辑订阅的可改字段；name 变化即触发重命名 */
export interface EditSubscriptionInput {
  name?: string
  url?: string
  prefix?: string
  type?: 'remote' | 'local'
  group?: string
  interval?: number
  /** 传 null 表示清除锁定、恢复自动更新 */
  locked?: boolean | null
}

export interface ChangeResult {
  warnings: string[]
  /** edit 时若前缀没有实际变化则为 true，此时未触碰任何文件与服务 */
  unchanged?: boolean
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 从应用配置构造事务依赖。mihomoDir 来自 config.json（v0.2.0 起是关键配置，
 * 指向内核配置目录）；测试通过 overrides 注入临时目录与 stub 二进制。
 */
export function depsFromAppConfig(
  config: AppConfig,
  overrides: Partial<ServiceDeps> = {},
): ServiceDeps {
  return {
    manager: new ConfigManager(config.mihomoDir, config.mihomoBin),
    service: new ServiceManager(),
    ...overrides,
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sortSubs(subs: Subscription[]): Subscription[] {
  return subs.slice().sort((a, b) => a.name.localeCompare(b.name))
}

/** 三个入口的第一步都是校验：在改动任何文件之前发出该步进度 */
function emitValidate(deps: ServiceDeps, steps: Step[]): void {
  const first = steps[0]
  if (first?.key === 'validate') deps.onProgress?.(first, [])
}

/**
 * 事务主体：从「写入订阅清单」开始到「确认服务状态」结束。
 * oldSubs 由调用方在改文件之前取好，失败回滚用的就是它。
 */
async function applyChange(
  oldSubs: Subscription[],
  newSubs: Subscription[],
  steps: Step[],
  deps: ServiceDeps,
): Promise<ChangeResult> {
  const manager = deps.manager ?? new ConfigManager()
  const service = deps.service ?? new ServiceManager()
  const subsPath = deps.subscriptionsPath
  const sleep = deps.sleep ?? defaultSleep
  const graceMs = deps.graceMs ?? 1500
  const onProgress = deps.onProgress

  const completed: Step[] = []
  // 第 1 步（校验输入）由入口函数在调用本事务之前完成并上报
  if (steps[0]?.key === 'validate') completed.push(steps[0])
  const begin = (key: StepKey): void => {
    const step = steps.find((candidate) => candidate.key === key)
    if (step) onProgress?.(step, [...completed])
  }
  const finish = (key: StepKey): void => {
    const step = steps.find((candidate) => candidate.key === key)
    if (step) completed.push(step)
  }

  let backupPath: string | undefined
  let configWritten = false
  let manifestWritten = false

  try {
    begin('manifest')
    saveSubscriptions(newSubs, subsPath)
    manifestWritten = true
    finish('manifest')

    begin('generate')
    const old = manager.loadConfig()
    // oldSubs 作为「上一轮清单」传入：删除订阅时同步剥离其置顶直连规则
    const { skeleton, warnings } = buildSkeleton(old, newSubs, {
      previousSubscriptions: oldSubs,
    })
    const yamlText = YAML.stringify(skeleton, { lineWidth: 0, singleQuote: true })
    finish('generate')

    begin('backup')
    backupPath = manager.backup()
    finish('backup')

    begin('write')
    const pre = manager.validate(yamlText)
    if (!pre.ok) {
      throw new SubscriptionError('生成的配置未通过校验，已中止写入', 'write', pre.output)
    }
    manager.writeConfig(yamlText)
    configWritten = true
    const post = manager.validate(manager.readConfigText())
    if (!post.ok) {
      manager.rollback(backupPath)
      configWritten = false
      throw new SubscriptionError('配置写入后校验失败（配置已回滚）', 'write', post.output)
    }
    manager.ensureProvidersDir()
    finish('write')

    begin('restart')
    await service.restart()
    await sleep(graceMs)
    finish('restart')

    begin('verify')
    if (!(await service.isActive())) {
      // 服务起不来：完整回滚（配置 + 清单）并再重启，把 systemctl status 带给用户
      manager.rollback(backupPath!)
      configWritten = false
      saveSubscriptions(oldSubs, subsPath)
      manifestWritten = false
      await service.restart()
      throw new SubscriptionError('服务启动失败（已回滚）', 'verify', await service.status())
    }
    finish('verify')

    return { warnings }
  } catch (err) {
    // 兜底回滚（设计稿 6.1）：动了配置才回滚配置并重启；清单尽量恢复原状
    const problems: string[] = []
    if (configWritten && backupPath) {
      try {
        manager.rollback(backupPath)
        await service.restart()
      } catch (rollbackErr) {
        problems.push(msg(rollbackErr))
      }
    }
    if (manifestWritten) {
      try {
        saveSubscriptions(oldSubs, subsPath)
      } catch (rollbackErr) {
        problems.push(msg(rollbackErr))
      }
    }
    if (problems.length > 0) {
      throw new SubscriptionError(
        `${msg(err)}；回滚失败：${problems.join('；')}`,
        err instanceof SubscriptionError ? err.step : 'write',
      )
    }
    throw err
  }
}

/** 新增订阅。任何文件被改动之前先完成全部输入校验。 */
export async function addSubscription(
  input: AddSubscriptionInput,
  deps: ServiceDeps = {},
): Promise<ChangeResult> {
  const oldSubs = loadSubscriptions(deps.subscriptionsPath)
  emitValidate(deps, ADD_STEPS)
  const validated = validateSubscription({ ...input, prefix: prefixFromName(input.name) })
  if (!validated.ok) {
    throw new SubscriptionError(validated.error, 'validate')
  }
  if (isDuplicateName(validated.data.name, oldSubs)) {
    throw new SubscriptionError(`订阅名称 "${validated.data.name}" 已存在`, 'validate')
  }
  const manager = deps.manager ?? new ConfigManager()
  // 本地订阅需要一份内容文件作为 file provider 的起点
  if (validated.data.type === 'local') ensureLocalProxyFile(manager, validated.data.name)
  return applyChange(oldSubs, sortSubs([...oldSubs, validated.data]), ADD_STEPS, deps)
}

/**
 * 编辑订阅：可改名称（重命名）、类型、URL、前缀、分组、更新间隔与锁定状态。
 * 重命名会迁移 provider 缓存文件，失败时连同配置一起回滚。
 */
export async function editSubscription(
  name: string,
  input: EditSubscriptionInput,
  deps: ServiceDeps = {},
): Promise<ChangeResult> {
  const oldSubs = loadSubscriptions(deps.subscriptionsPath)
  emitValidate(deps, EDIT_STEPS)
  const target = oldSubs.find((sub) => sub.name === name)
  if (!target) {
    throw new SubscriptionError(`订阅 "${name}" 不存在`, 'validate')
  }

  const merged: Partial<Subscription> = { ...target }
  if (input.name !== undefined) merged.name = input.name
  if (input.type !== undefined) merged.type = input.type
  if (input.url !== undefined) merged.url = input.url
  if (input.group !== undefined) merged.group = input.group
  if (input.interval !== undefined) merged.interval = input.interval
  if (input.locked !== undefined) merged.locked = input.locked === null ? undefined : input.locked
  // 前缀由名字派生，不接受手工设置；名字变了前缀跟着变
  if (merged.name) merged.prefix = prefixFromName(merged.name)
  // 切到本地类型时清空远程专属字段
  if (merged.type === 'local') {
    merged.url = undefined
    merged.interval = undefined
    merged.locked = undefined
  }

  const validated = validateSubscription(merged)
  if (!validated.ok) {
    throw new SubscriptionError(validated.error, 'validate')
  }
  const next = validated.data
  const renaming = next.name !== target.name
  if (renaming && isDuplicateName(next.name, oldSubs.filter((sub) => sub.name !== name))) {
    throw new SubscriptionError(`订阅名称 "${next.name}" 已存在`, 'validate')
  }
  if (JSON.stringify(next) === JSON.stringify(target)) {
    return { warnings: [], unchanged: true }
  }

  const manager = deps.manager ?? new ConfigManager()
  if (renaming) manager.renameProviderCache(target.name, next.name)
  if (next.type === 'local') ensureLocalProxyFile(manager, next.name)

  try {
    const newSubs = oldSubs.map((sub) => (sub.name === name ? next : sub))
    const result = await applyChange(oldSubs, sortSubs(newSubs), EDIT_STEPS, deps)
    return { ...result, unchanged: false }
  } catch (err) {
    // 事务失败：把已改名的缓存文件改回去（applyChange 只管 config 与清单）
    if (renaming) {
      try {
        manager.renameProviderCache(next.name, target.name)
      } catch {
        // 改回失败不掩盖原始错误
      }
    }
    throw err
  }
}

/** 编辑订阅前缀的兼容入口（只改前缀，名称与 URL 不动）。 */
export async function editSubscriptionPrefix(
  name: string,
  prefix: string | undefined,
  deps: ServiceDeps = {},
): Promise<ChangeResult> {
  return editSubscription(name, { prefix }, deps)
}

/** 本地订阅的内容文件：不存在时创建空的 proxies 骨架。 */
function ensureLocalProxyFile(manager: ConfigManager, name: string): void {
  manager.ensureProvidersDir()
  const path = manager.providerCachePath(name)
  if (!existsSync(path)) writeFileSync(path, 'proxies: []\n', 'utf8')
}

/** 删除订阅（含清理 provider 缓存文件；最后一个订阅不允许删）。 */
export async function deleteSubscription(
  name: string,
  deps: ServiceDeps = {},
): Promise<ChangeResult> {
  const oldSubs = loadSubscriptions(deps.subscriptionsPath)
  emitValidate(deps, DELETE_STEPS)
  if (!oldSubs.some((sub) => sub.name === name)) {
    throw new SubscriptionError(`订阅 "${name}" 不存在`, 'validate')
  }
  if (oldSubs.length <= 1) {
    throw new SubscriptionError('不能删除最后一个订阅', 'validate')
  }
  const result = await applyChange(
    oldSubs,
    oldSubs.filter((sub) => sub.name !== name),
    DELETE_STEPS,
    deps,
  )
  const manager = deps.manager ?? new ConfigManager()
  manager.deleteProviderCache(name)
  const cacheStep = DELETE_STEPS.at(-1)
  if (cacheStep) deps.onProgress?.(cacheStep, DELETE_STEPS.slice(0, -1))
  return result
}
