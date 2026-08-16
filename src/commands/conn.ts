/** proxy_tui conn ls / close，以及 reload */
import { MihomoClient } from '../api/client.js'
import type { ConnectionItem } from '../api/types.js'
import type { AppConfig } from '../config.js'
import { EXIT, formatBytes, printJson, renderTable, terminalWidth } from './output.js'

/** 连接持续时长 */
function formatDuration(start: string): string {
  const began = Date.parse(start)
  if (Number.isNaN(began)) return '---'
  const seconds = Math.max(0, Math.floor((Date.now() - began) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`
}

/** 展示用主机名：优先 host，回退嗅探结果与目标 IP */
function describeHost(conn: ConnectionItem): string {
  const { host, sniffHost, destinationIP, destinationPort } = conn.metadata
  const name = host || sniffHost || destinationIP || '?'
  return destinationPort ? `${name}:${destinationPort}` : name
}

export interface ConnLsOptions {
  json?: boolean
  sort?: string
  limit?: string
}

export async function runConnLs(config: AppConfig, options: ConnLsOptions): Promise<void> {
  const client = new MihomoClient(config)
  const data = await client.connections()
  // 无连接时内核返回 null 而非 []（实测，见 SPEC 3.5）
  const conns = data.connections ?? []

  const sort = options.sort ?? 'traffic'
  if (!['traffic', 'time', 'host'].includes(sort)) {
    process.stderr.write('错误：--sort 只支持 traffic / time / host\n')
    process.exit(EXIT.usage)
  }
  const sorted = conns.slice().sort((a, b) => {
    if (sort === 'time') return Date.parse(a.start) - Date.parse(b.start)
    if (sort === 'host') return describeHost(a).localeCompare(describeHost(b))
    return b.download + b.upload - (a.download + a.upload)
  })

  const limit = options.limit ? Number(options.limit) : undefined
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    process.stderr.write('错误：--limit 需为正整数\n')
    process.exit(EXIT.usage)
  }
  const shown = limit === undefined ? sorted : sorted.slice(0, limit)

  if (options.json) {
    printJson({
      uploadTotal: data.uploadTotal,
      downloadTotal: data.downloadTotal,
      memory: data.memory,
      count: conns.length,
      connections: shown,
    })
    return
  }

  if (shown.length === 0) {
    process.stdout.write(
      `当前无活跃连接。累计 ↑${formatBytes(data.uploadTotal)} ↓${formatBytes(data.downloadTotal)}\n`,
    )
    return
  }

  // 窄终端下省略代理链列，避免横向截断导致乱码
  const narrow = terminalWidth() < 100
  const header = narrow
    ? ['ID', 'HOST', 'UP', 'DOWN', 'TIME']
    : ['ID', 'HOST', 'RULE', 'CHAIN', 'UP', 'DOWN', 'TIME']
  const rows = shown.map((conn) => {
    const id = conn.id.slice(0, 8)
    const base = [id, describeHost(conn)]
    const tail = [formatBytes(conn.upload), formatBytes(conn.download), formatDuration(conn.start)]
    if (narrow) return [...base, ...tail]
    const rule = conn.rulePayload ? `${conn.rule}(${conn.rulePayload})` : conn.rule
    // chains 是从出口到入口排列，反转后读起来才是流量实际经过的顺序
    return [...base, rule, conn.chains.slice().reverse().join(' → '), ...tail]
  })

  process.stdout.write(`${renderTable(header, rows)}\n`)
  process.stdout.write(
    `\n共 ${conns.length} 条连接${shown.length < conns.length ? `（显示前 ${shown.length} 条）` : ''}，累计 ↑${formatBytes(data.uploadTotal)} ↓${formatBytes(data.downloadTotal)}，内核内存 ${formatBytes(data.memory)}\n`,
  )
}

export async function runConnClose(
  config: AppConfig,
  id: string | undefined,
  options: { all?: boolean; json?: boolean },
): Promise<void> {
  const client = new MihomoClient(config)

  if (options.all) {
    const before = await client.connections()
    const count = before.connections?.length ?? 0
    await client.closeAllConnections()
    if (options.json) printJson({ closed: 'all', count })
    else process.stdout.write(`已关闭全部连接（${count} 条）\n`)
    return
  }

  if (!id) {
    process.stderr.write('用法：conn close <id> 或 conn close --all\n')
    process.exit(EXIT.usage)
  }

  // 支持用 ls 显示的 8 位短 ID
  const data = await client.connections()
  const conns = data.connections ?? []
  const matched = conns.filter((conn) => conn.id === id || conn.id.startsWith(id))
  if (matched.length === 0) {
    process.stderr.write(`错误：未找到连接：${id}\n`)
    process.exit(EXIT.error)
  }
  if (matched.length > 1) {
    process.stderr.write(`错误：ID 前缀 ${id} 匹配到 ${matched.length} 条连接，请给出更长的 ID\n`)
    process.exit(EXIT.usage)
  }

  const target = matched[0]!
  await client.closeConnection(target.id)
  if (options.json) printJson({ closed: target.id, host: describeHost(target) })
  else process.stdout.write(`已关闭连接 ${target.id.slice(0, 8)}（${describeHost(target)}）\n`)
}

export async function runReload(
  config: AppConfig,
  options: { json?: boolean; path?: string },
): Promise<void> {
  const client = new MihomoClient(config)
  // 本程序不写配置文件，只让内核自己重新读盘（PUT /configs?force=false，实测 204 且 PID 不变）
  await client.reload(options.path ?? '')
  const version = await client.version()
  if (options.json) printJson({ reloaded: true, version: version.version })
  else process.stdout.write(`配置已热重载，内核 ${version.version} 未重启\n`)
}
