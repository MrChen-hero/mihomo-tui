/** proxy_tui proxy ls / use / test */
import { ApiBusinessError, MihomoClient } from '../api/client.js'
import { classify, formatDelay, STATUS_LABEL } from '../api/status.js'
import type { ProxyItem } from '../api/types.js'
import type { AppConfig } from '../config.js'
import { isGroup } from './status.js'
import { EXIT, printJson, renderTable } from './output.js'

/** 组名不存在时给出候选，避免用户在几十个中文组名里瞎猜 */
function groupNotFound(name: string, proxies: Record<string, ProxyItem>): never {
  process.stderr.write(`错误：代理组不存在：${name}\n`)
  const groups = Object.values(proxies).filter(isGroup).map((proxy) => proxy.name)
  if (groups.length > 0) {
    process.stderr.write(`可用代理组：\n${groups.map((g) => `  ${g}`).join('\n')}\n`)
  }
  process.exit(EXIT.error)
}

export interface ProxyLsOptions {
  json?: boolean
}

export async function runProxyLs(
  config: AppConfig,
  group: string | undefined,
  options: ProxyLsOptions,
): Promise<void> {
  const client = new MihomoClient(config)
  const proxies = await client.proxies()

  // 不带组名：列出所有代理组及当前选中
  if (!group) {
    const groups = Object.values(proxies).filter(isGroup)
    if (options.json) {
      printJson(
        groups.map((item) => ({
          name: item.name,
          type: item.type,
          now: item.now ?? null,
          fixed: item.fixed || null,
          size: item.all?.length ?? 0,
        })),
      )
      return
    }
    const rows = groups.map((item) => [
      item.name,
      item.type,
      String(item.all?.length ?? 0),
      item.now ?? '---',
      // url-test/fallback 组被 PUT 钉住时 now 由测速决定、fixed 才是用户的选择
      item.fixed ? `钉选 ${item.fixed}` : '',
    ])
    process.stdout.write(`${renderTable(['GROUP', 'TYPE', 'SIZE', 'NOW', 'FIXED'], rows)}\n`)
    return
  }

  // 带组名：列出该组内节点
  const target = proxies[group]
  if (!target || !isGroup(target)) groupNotFound(group, proxies)

  const testUrl = target.testUrl || config.testUrl
  const members = (target.all ?? []).map((name) => proxies[name]).filter((p): p is ProxyItem => !!p)

  if (options.json) {
    printJson({
      group: target.name,
      type: target.type,
      now: target.now ?? null,
      fixed: target.fixed || null,
      testUrl,
      proxies: members.map((item) => {
        const result = classify(item, config.delayThresholds, testUrl)
        return {
          name: item.name,
          type: item.type,
          provider: item['provider-name'] || null,
          status: result.status,
          delay: result.delay ?? null,
          current: item.name === target.now,
        }
      }),
    })
    return
  }

  const rows = members.map((item) => {
    const result = classify(item, config.delayThresholds, testUrl)
    return [
      item.name === target.now ? '*' : ' ',
      item.name,
      item.type,
      item['provider-name'] || '-',
      formatDelay(result),
      STATUS_LABEL[result.status],
    ]
  })
  process.stdout.write(
    `${renderTable(['', 'NAME', 'TYPE', 'PROVIDER', 'DELAY', 'STATUS'], rows)}\n`,
  )
}

export async function runProxyUse(
  config: AppConfig,
  group: string,
  name: string,
  options: { json?: boolean },
): Promise<void> {
  const client = new MihomoClient(config)
  const proxies = await client.proxies()
  const target = proxies[group]
  if (!target || !isGroup(target)) groupNotFound(group, proxies)

  await client.selectProxy(group, name)

  // 回读确认。url-test/fallback 组写入的是 fixed 而非 now（实测，见 SPEC 3.5）
  const after = await client.proxy(group)
  const applied = after.fixed || after.now
  const pinned = Boolean(after.fixed)

  if (options.json) {
    printJson({ group, requested: name, now: after.now ?? null, fixed: after.fixed || null, pinned })
    return
  }
  process.stdout.write(`${group} → ${applied}\n`)
  if (pinned) {
    process.stdout.write(
      `注意：该组为 ${after.type}，已将其钉选在此节点；恢复自动选路执行 proxy unfix '${group}'\n`,
    )
  }
}

export async function runProxyUnfix(
  config: AppConfig,
  group: string,
  options: { json?: boolean },
): Promise<void> {
  const client = new MihomoClient(config)
  await client.unfixProxy(group)
  const after = await client.proxy(group)
  if (options.json) {
    printJson({ group, now: after.now ?? null, fixed: after.fixed || null })
    return
  }
  process.stdout.write(`${group} 已解除钉选，当前自动选路：${after.now ?? '---'}\n`)
}

export interface ProxyTestOptions {
  json?: boolean
  url?: string
  timeout?: string
}

export async function runProxyTest(
  config: AppConfig,
  group: string,
  options: ProxyTestOptions,
): Promise<void> {
  const client = new MihomoClient(config)
  const proxies = await client.proxies()
  const target = proxies[group]
  if (!target || !isGroup(target)) groupNotFound(group, proxies)

  // 组自身的 testUrl 可能是空串（select 组无 health-check 时内核返回 ""），
  // 只有非空才可用，否则回退到配置里的测速地址
  const url = options.url || target.testUrl || config.testUrl
  const timeout = options.timeout ? Number(options.timeout) : config.testTimeout
  if (!Number.isFinite(timeout) || timeout <= 0) {
    process.stderr.write('错误：--timeout 需为正整数（毫秒）\n')
    process.exit(EXIT.usage)
  }

  let delays: Record<string, number>
  try {
    delays = await client.testGroupDelay(group, url, timeout)
  } catch (err) {
    // 整组全灭时内核也可能返回业务错误，这不是程序故障
    if (err instanceof ApiBusinessError) {
      if (options.json) {
        printJson({ group, url, timeout, error: err.message, results: [] })
        return
      }
      process.stderr.write(`整组测速失败：${err.message}\n`)
      process.exit(EXIT.error)
    }
    throw err
  }

  // 未出现在结果里的成员即为本次测试失败（实测：内核只回可用节点）
  const members = target.all ?? []
  const results = members.map((name) => ({
    name,
    delay: delays[name],
    ok: delays[name] !== undefined,
  }))
  const alive = results.filter((item) => item.ok).length

  if (options.json) {
    printJson({ group, url, timeout, tested: results.length, alive, results })
    return
  }

  const rows = results
    .slice()
    .sort((a, b) => (a.delay ?? Infinity) - (b.delay ?? Infinity))
    .map((item) => [item.name, item.ok ? `${item.delay}ms` : '错误'])
  process.stdout.write(`${renderTable(['NAME', 'DELAY'], rows)}\n`)
  process.stdout.write(`\n测试 ${results.length} 个，可用 ${alive} 个（${url}）\n`)
}
