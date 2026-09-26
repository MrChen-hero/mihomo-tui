/**
 * 代理链的写入事务。
 *
 * relay 组定义在 config.yaml 的 proxy-groups 里，内核没有新增代理组的热更新接口，
 * 所以增删必须落盘。与订阅事务不同：这里只改 proxy-groups，reload 即可生效，
 * 不重启 systemd 服务。
 *
 * 流程：校验 → 备份 → mihomo -t 校验 → 原子写 → 写后复验 → reload。
 * 任一步失败回滚 config；reload 失败则回滚后再次 reload，把内核拉回旧配置。
 */
import YAML from 'yaml'
import type { MihomoClient } from '../api/client.js'
import { ConfigManager } from '../config/manager.js'
import { loadSubscriptions } from '../config/subscriptions.js'
import { buildSkeleton } from '../config/skeleton.js'
import {
  applyRelayGroups,
  extractRelayGroups,
  validateRelay,
  type RelayGroup,
  type RelayValidation,
} from './editor.js'

export interface RelayApplyDeps {
  manager?: ConfigManager
  /** 订阅清单路径：骨架重生成时需要当前订阅 */
  subscriptionsPath?: string
  /** 触发内核 reload；缺省时由调用方保证已注入 */
  reload?: () => Promise<void>
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(detail ? `${message}\n${detail}` : message)
    this.name = 'RelayError'
  }
}

export interface RelayApplyResult {
  warnings: string[]
}

/**
 * 用一份完整的 relay 组列表替换配置中的全部 relay 组。
 * relays 必须已通过 validateRelay；这里仍会再校验一次，拒绝就不写盘。
 */
export async function applyRelays(
  relays: RelayGroup[],
  candidates: string[],
  deps: RelayApplyDeps,
): Promise<RelayApplyResult> {
  const manager = deps.manager ?? new ConfigManager()
  const old = manager.loadConfig()
  const existing = extractRelayGroups(old['proxy-groups'])

  for (const relay of relays) {
    const others = relays.filter((candidate) => candidate.name !== relay.name)
    const groupNames = groupNamesOf(old).filter(
      (name) => !existing.some((item) => item.name === name),
    )
    const validation = validateRelay(relay, candidates, others, groupNames)
    if (!validation.ok) throw new RelayError(validation.error)
  }

  const subs = loadSubscriptions(deps.subscriptionsPath)
  const { skeleton, warnings } = buildSkeleton(old, subs)
  skeleton['proxy-groups'] = applyRelayGroups(
    (skeleton['proxy-groups'] as Record<string, unknown>[]) ?? [],
    relays,
  )
  const yamlText = YAML.stringify(skeleton, { lineWidth: 0, singleQuote: true })

  // 订阅更新可能删掉了既有 relay 引用的节点：不改那些组，只警告
  const staleWarnings = staleHopWarnings(existing, relays, candidates)

  const backupPath = manager.backup()
  const pre = manager.validate(yamlText)
  if (!pre.ok) throw new RelayError('配置校验失败，未写入', pre.output)

  manager.writeConfig(yamlText)
  const post = manager.validate(manager.readConfigText())
  if (!post.ok) {
    manager.rollback(backupPath)
    throw new RelayError('写入后校验失败（已回滚）', post.output)
  }

  if (deps.reload) {
    try {
      await deps.reload()
    } catch (err) {
      manager.rollback(backupPath)
      try {
        await deps.reload()
      } catch (rollbackErr) {
        const reason = err instanceof Error ? err.message : String(err)
        const rollbackReason = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        throw new RelayError(`reload 失败且回滚后的 reload 也失败：${reason}`, rollbackReason)
      }
      const reason = err instanceof Error ? err.message : String(err)
      throw new RelayError(`reload 失败（配置已回滚）：${reason}`)
    }
  }

  return { warnings: [...warnings, ...staleWarnings] }
}

/** 既有 relay 组里、提交后仍保留、但已不在候选集中的跳 */
function staleHopWarnings(before: RelayGroup[], after: RelayGroup[], candidates: string[]): string[] {
  const warnings: string[] = []
  for (const relay of after) {
    const previous = before.find((item) => item.name === relay.name)
    if (!previous) continue
    const stale = relay.proxies.filter((hop) => previous.proxies.includes(hop) && !candidates.includes(hop))
    if (stale.length > 0) {
      warnings.push(`代理链 ${relay.name} 的节点已失效：${stale.join('、')}（未自动修改，请手动编辑）`)
    }
  }
  return warnings
}

function groupNamesOf(config: Record<string, unknown>): string[] {
  const groups = config['proxy-groups']
  if (!Array.isArray(groups)) return []
  return groups
    .map((group) =>
      typeof group === 'object' && group !== null ? (group as Record<string, unknown>)['name'] : undefined,
    )
    .filter((name): name is string => typeof name === 'string')
}

/** 供视图层把内核客户端适配成 reload 回调 */
export function reloadWith(client: MihomoClient): () => Promise<void> {
  return () => client.reload()
}

export type { RelayGroup, RelayValidation }
