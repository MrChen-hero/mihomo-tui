/**
 * proxy_tui rules ls / rules test / rule-provider ls / rule-provider update
 *
 * 规则测试优先用本地匹配（src/rules/matcher.ts）：内核不保证提供服务端匹配接口。
 * 遇到本地无法判定的规则类型时明确标注，不返回误导性结果。
 */
import { MihomoClient } from '../api/client.js'
import type { AppConfig } from '../config.js'
import { buildRulesTestResult, normalizeTarget } from '../rules/matcher.js'
import { normalizeRuleType } from '../rules/types.js'
import { buildRuleRows } from '../rules/model.js'
import { EXIT, printJson, renderTable } from './output.js'

export { buildRulesTestResult } from '../rules/matcher.js'

export async function runRulesLs(
  config: AppConfig,
  options: { json?: boolean; type?: string },
): Promise<void> {
  const client = new MihomoClient(config)
  const all = await client.rules()
  const rows = buildRuleRows(all, [], { type: options.type ?? '', keyword: '' })
    .filter((row) => row.kind === 'rule')
  const rules = rows.map((row) => row.rule)

  if (options.json) {
    printJson(rules)
    return
  }
  if (rules.length === 0) {
    process.stdout.write(options.type ? `没有类型为 ${options.type} 的规则。\n` : '当前没有生效规则。\n')
    return
  }
  const cells = rows.map(({ rule, index }) => [String(index), normalizeRuleType(rule.type), rule.payload, rule.proxy,
    rule.extra?.disabled === undefined ? '未知' : rule.extra.disabled ? '已禁用' : '启用'])
  process.stdout.write(`${renderTable(['#', 'TYPE', 'PAYLOAD', 'PROXY', 'STATE'], cells)}\n`)
}

export async function runRulesTest(
  config: AppConfig,
  target: string,
  options: { json?: boolean },
): Promise<void> {
  normalizeTarget(target)
  const client = new MihomoClient(config)
  const result = buildRulesTestResult(await client.rules(), target)

  if (options.json) {
    printJson(result)
    return
  }
  if (result.outcome === 'miss') {
    process.stdout.write(`${target} 未命中任何规则。\n`)
    return
  }
  const rule = result.rule
  const where = `#${result.index} ${rule?.type ?? ''} ${rule?.payload ?? ''}`.trim()
  if (result.outcome === 'unsupported') {
    process.stdout.write(`${target} 在 ${where} 处无法继续判断（需内核判定），未确定命中规则或出口。\n`)
    return
  }
  process.stdout.write(`${target} 本地匹配命中 ${where} → 目标 ${rule?.proxy ?? ''}（不代表最终节点或实际流量路径）\n`)
}

export async function runRuleProviderLs(
  config: AppConfig,
  options: { json?: boolean },
): Promise<void> {
  const client = new MihomoClient(config)
  const providers = await client.ruleProviders()
  const entries = Object.values(providers)

  if (options.json) {
    printJson(entries)
    return
  }
  if (entries.length === 0) {
    process.stdout.write('当前没有 rule-providers。\n')
    return
  }
  const rows = entries.map((provider) => [
    provider.name,
    provider.vehicleType,
    provider.behavior ?? '---',
    provider.ruleCount === undefined ? '---' : String(provider.ruleCount),
    provider.updatedAt ?? '---',
  ])
  process.stdout.write(`${renderTable(['NAME', 'TYPE', 'BEHAVIOR', 'RULES', 'UPDATED'], rows)}\n`)
}

export async function runRuleProviderUpdate(config: AppConfig, name: string, options: { json?: boolean } = {}): Promise<void> {
  const client = new MihomoClient(config)
  const providers = await client.ruleProviders()
  if (!providers[name]) {
    process.stderr.write(`错误：rule-provider 不存在：${name}\n`)
    const names = Object.keys(providers)
    process.stderr.write(
      names.length > 0 ? `可用 rule-provider：${names.join(', ')}\n` : '当前没有 rule-providers。\n',
    )
    process.exit(EXIT.error)
  }
  await client.updateRuleProvider(name)
  if (options.json) printJson({ ok: true, name })
  else process.stdout.write(`已更新规则集 ${name}\n`)
}
