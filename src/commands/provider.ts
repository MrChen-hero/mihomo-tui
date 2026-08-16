/** proxy_tui provider ls / update / check */
import { ApiBusinessError, HttpStatusError, MihomoClient } from '../api/client.js'
import type { ProviderItem, SubscriptionInfo } from '../api/types.js'
import type { AppConfig } from '../config.js'
import { countAlive, realProviders } from './status.js'
import { EXIT, formatBytes, formatRelativeTime, printJson, renderTable } from './output.js'

/** 剩余流量：total - (upload + download)。total 为 0 表示机场未下发 */
function formatUsage(info: SubscriptionInfo | undefined): string {
  if (!info || !info.Total) return '---'
  const used = (info.Upload ?? 0) + (info.Download ?? 0)
  return `${formatBytes(Math.max(0, info.Total - used))} 剩余`
}

/** Expire 为 Unix 秒；0 表示机场未下发到期时间（实测三家订阅均为 0） */
function formatExpire(info: SubscriptionInfo | undefined): string {
  if (!info || !info.Expire) return '长期有效'
  const date = new Date(info.Expire * 1000)
  const days = Math.floor((date.getTime() - Date.now()) / 86_400_000)
  return `${date.toISOString().slice(0, 10)}（${days} 天）`
}

function providerNotFound(name: string, providers: Record<string, ProviderItem>): never {
  process.stderr.write(`错误：provider 不存在：${name}\n`)
  const names = realProviders(providers).map(([key]) => key)
  process.stderr.write(
    names.length > 0
      ? `可用 provider：${names.join(', ')}\n`
      : '当前配置没有任何 proxy-providers（见 SPEC 检查点 4 的迁移脚本）\n',
  )
  process.exit(EXIT.error)
}

export async function runProviderLs(
  config: AppConfig,
  options: { json?: boolean },
): Promise<void> {
  const client = new MihomoClient(config)
  const providers = await client.providers()
  const subs = realProviders(providers)

  if (options.json) {
    printJson(
      subs.map(([name, provider]) => ({
        name,
        type: provider.vehicleType,
        nodes: provider.proxies.length,
        alive: countAlive(provider.proxies),
        subscriptionInfo: provider.subscriptionInfo ?? null,
        updatedAt: provider.updatedAt ?? null,
      })),
    )
    return
  }

  if (subs.length === 0) {
    process.stdout.write(
      '当前配置没有 proxy-providers。\n节点直接写在 config.yaml 的 proxies 段，订阅更新会覆盖手工修改（SPEC P1/P2）。\n',
    )
    return
  }

  const rows = subs.map(([name, provider]) => [
    name,
    provider.vehicleType.toLowerCase(),
    String(provider.proxies.length),
    // file 类型 provider 无 health-check 数据时不该显示 0，避免与「全部失效」混淆
    provider.vehicleType === 'File' && provider.proxies.every((p) => p.history.length === 0)
      ? '---'
      : String(countAlive(provider.proxies)),
    formatUsage(provider.subscriptionInfo),
    formatExpire(provider.subscriptionInfo),
    formatRelativeTime(provider.updatedAt),
  ])
  process.stdout.write(
    `${renderTable(['NAME', 'TYPE', 'NODES', 'ALIVE', 'USAGE', 'EXPIRE', 'UPDATED'], rows)}\n`,
  )
}

export async function runProviderUpdate(
  config: AppConfig,
  name: string | undefined,
  options: { json?: boolean },
): Promise<void> {
  const client = new MihomoClient(config)
  const providers = await client.providers()
  const subs = realProviders(providers)

  if (name !== undefined && !providers[name]) providerNotFound(name, providers)

  const targets = name !== undefined ? [name] : subs.map(([key]) => key)
  if (targets.length === 0) {
    process.stderr.write('当前配置没有可更新的 proxy-providers\n')
    process.exit(EXIT.error)
  }

  const results: { name: string; ok: boolean; error?: string }[] = []
  for (const target of targets) {
    if (!options.json) process.stdout.write(`更新 ${target} ... `)
    try {
      await client.updateProvider(target)
      results.push({ name: target, ok: true })
      if (!options.json) process.stdout.write('成功\n')
    } catch (err) {
      // 订阅域名失效是常态，错误必须完整可见且不中断其余 provider
      const message =
        err instanceof ApiBusinessError || err instanceof HttpStatusError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      results.push({ name: target, ok: false, error: message })
      if (!options.json) process.stdout.write(`失败：${message}\n`)
    }
  }

  const after = await client.providers()
  const detailed = results.map((item) => ({
    ...item,
    nodes: after[item.name]?.proxies.length ?? null,
    updatedAt: after[item.name]?.updatedAt ?? null,
  }))

  if (options.json) {
    printJson(detailed)
  } else {
    const rows = detailed.map((item) => [
      item.name,
      item.ok ? '成功' : '失败',
      item.nodes === null ? '---' : String(item.nodes),
      formatRelativeTime(item.updatedAt ?? undefined),
    ])
    process.stdout.write(`\n${renderTable(['NAME', 'RESULT', 'NODES', 'UPDATED'], rows)}\n`)
  }

  if (detailed.some((item) => !item.ok)) process.exit(EXIT.error)
}

export async function runProviderCheck(
  config: AppConfig,
  name: string,
  options: { json?: boolean },
): Promise<void> {
  const client = new MihomoClient(config)
  const providers = await client.providers()
  if (!providers[name]) providerNotFound(name, providers)

  await client.healthCheckProvider(name)
  const after = await client.providers()
  const provider = after[name]
  const alive = provider ? countAlive(provider.proxies) : 0
  const total = provider?.proxies.length ?? 0

  if (options.json) {
    printJson({
      name,
      total,
      alive,
      proxies: (provider?.proxies ?? []).map((proxy) => ({
        name: proxy.name,
        alive: proxy.alive,
        delay: proxy.history.at(-1)?.delay ?? null,
      })),
    })
    return
  }
  process.stdout.write(`${name}：健康检查完成，${total} 个节点中 ${alive} 个可用\n`)
}
