/**
 * proxy_tui status —— 内核版本、模式、端口、provider 概览。
 * 检查点 1 的验证目标：能连上 19090 并打印 v1.19.24。
 */
import { MihomoClient } from '../api/client.js'
import type { ProviderItem, ProxyItem } from '../api/types.js'
import type { AppConfig } from '../config.js'
import { formatRelativeTime, printJson, renderTable } from './output.js'

/** /providers/proxies 会把代理组也列为 vehicleType=Compatible 的伪 provider，需剔除 */
export function realProviders(
  providers: Record<string, ProviderItem>,
): [string, ProviderItem][] {
  return Object.entries(providers).filter(
    ([, provider]) => provider.vehicleType === 'HTTP' || provider.vehicleType === 'File',
  )
}

export function countAlive(proxies: ProxyItem[]): number {
  return proxies.filter((proxy) => proxy.alive && proxy.history.length > 0).length
}

export function isGroup(proxy: ProxyItem): boolean {
  return Array.isArray(proxy.all)
}

export interface StatusOptions {
  json?: boolean
}

export async function runStatus(config: AppConfig, options: StatusOptions): Promise<void> {
  const client = new MihomoClient(config)
  const [version, configs, proxies, providers] = await Promise.all([
    client.version(),
    client.configs(),
    client.proxies(),
    client.providers(),
  ])

  const groups = Object.values(proxies).filter(isGroup)
  const nodes = Object.values(proxies).filter((proxy) => !isGroup(proxy))
  const subs = realProviders(providers)

  if (options.json) {
    printJson({
      api: client.api,
      version,
      mode: configs.mode,
      logLevel: configs['log-level'],
      mixedPort: configs['mixed-port'],
      allowLan: configs['allow-lan'],
      bindAddress: configs['bind-address'],
      groups: groups.length,
      nodes: nodes.length,
      providers: subs.map(([name, provider]) => ({
        name,
        type: provider.vehicleType,
        nodes: provider.proxies.length,
        alive: countAlive(provider.proxies),
        updatedAt: provider.updatedAt ?? null,
      })),
    })
    return
  }

  const lines = [
    renderTable(
      ['项目', '值'],
      [
        ['内核', `mihomo ${version.version}${version.meta ? ' (meta)' : ''}`],
        ['控制口', client.api],
        ['模式', configs.mode],
        ['日志级别', configs['log-level']],
        ['混合代理口', `${configs['bind-address'] || '127.0.0.1'}:${configs['mixed-port']}`],
        ['allow-lan', String(configs['allow-lan'])],
        ['代理组 / 节点', `${groups.length} 组 / ${nodes.length} 节点`],
      ],
    ),
  ]

  if (subs.length > 0) {
    const rows = subs.map(([name, provider]) => [
      name,
      provider.vehicleType.toLowerCase(),
      String(provider.proxies.length),
      String(countAlive(provider.proxies)),
      formatRelativeTime(provider.updatedAt),
    ])
    lines.push('', renderTable(['PROVIDER', 'TYPE', 'NODES', 'ALIVE', 'UPDATED'], rows))
  } else {
    lines.push('', 'provider：无（当前为整份 proxies 配置，尚未迁移到 proxy-providers 架构）')
  }

  process.stdout.write(`${lines.join('\n')}\n`)
}
