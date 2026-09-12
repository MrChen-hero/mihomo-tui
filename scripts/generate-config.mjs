#!/usr/bin/env node
/**
 * scripts/generate-config.mjs —— v0.2.0 配置层的只读验收入口（设计稿阶段 1 验收）
 *
 * 执行「读订阅 → 读当前配置 → 生成骨架 → 临时目录 mihomo -t 校验 → 打印摘要」，
 * **不写任何文件、不建备份、不碰服务**。用于在 TUI 功能上线前，
 * 确认重构后的 src/config/ 模块对真实配置的产出与旧脚本 migrate-config.mjs 一致。
 *
 * 用法：
 *   npm run build                 # 先编译（本脚本从 dist/ 导入）
 *   node scripts/generate-config.mjs            # 打印摘要 + 校验结果
 *   node scripts/generate-config.mjs --yaml     # 额外打印完整骨架 YAML（URL 仍脱敏）
 *   node scripts/generate-config.mjs --raw-yaml # 打印含真实 URL 的 YAML（别外传！）
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import YAML from 'yaml'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, '..', 'dist')
if (!existsSync(join(dist, 'config', 'manager.js'))) {
  process.stderr.write('找不到 dist/config/，请先执行：npm run build\n')
  process.exit(1)
}

const load = async (rel) => import(pathToFileURL(join(dist, rel)).href)
const { loadSubscriptions, redactUrl } = await load('config/subscriptions.js')
const { buildSkeleton } = await load('config/skeleton.js')
const { ConfigManager } = await load('config/manager.js')

const flags = new Set(process.argv.slice(2))
const showYaml = flags.has('--yaml') || flags.has('--raw-yaml')
const rawYaml = flags.has('--raw-yaml')

function fail(message) {
  process.stderr.write(`错误：${message}\n`)
  process.exit(1)
}

const manager = new ConfigManager()
if (!existsSync(manager.configPath)) fail(`找不到现有配置：${manager.configPath}`)

const subs = loadSubscriptions()
const old = manager.loadConfig()
const { skeleton, warnings } = buildSkeleton(old, subs)
const yamlText = YAML.stringify(skeleton, { lineWidth: 0, singleQuote: true })

process.stdout.write('=== 订阅（URL 已脱敏） ===\n')
for (const sub of subs) {
  process.stdout.write(
    `  ${sub.name.padEnd(12)} ${redactUrl(sub.url)}  prefix=${JSON.stringify(sub.prefix ?? '')}\n`,
  )
}

process.stdout.write('\n=== 骨架摘要 ===\n')
const groups = skeleton['proxy-groups'] ?? []
process.stdout.write(
  `  providers      ${Object.keys(skeleton['proxy-providers'] ?? {}).length}\n` +
    `  proxy-groups   ${groups.length} 个：${groups.map((g) => g.name).join(', ')}\n` +
    `  rules          ${(skeleton.rules ?? []).length} 条\n` +
    `  rule-providers ${Object.keys(skeleton['rule-providers'] ?? {}).length} 个\n` +
    `  sniffer/profile/experimental 保留：${[
      Boolean(skeleton.sniffer),
      Boolean(skeleton.profile),
      Boolean(skeleton.experimental),
    ].join(' / ')}\n` +
    `  dns.enable     ${skeleton.dns?.enable}\n`,
)

if (warnings.length > 0) {
  process.stdout.write('\n=== 警告 ===\n')
  for (const warning of warnings) process.stdout.write(`  ⚠ ${warning}\n`)
}

if (showYaml) {
  process.stdout.write(`\n=== 骨架 YAML ${rawYaml ? '（含真实 URL，勿外传）' : '（URL 已脱敏）'} ===\n`)
  process.stdout.write(`${rawYaml ? yamlText : yamlText.replaceAll(/token=[^'&\n]+/g, 'token=<REDACTED>')}\n`)
}

process.stdout.write('\n=== 用 mihomo -t 校验（临时目录，不触碰真实目录） ===\n')
const result = manager.validate(yamlText)
const lastLine = result.output.trim().split('\n').at(-1) ?? ''
if (!result.ok) {
  process.stdout.write(`${result.output.trim()}\n`)
  fail('生成的配置未通过校验')
}
process.stdout.write(`✅ ${lastLine}\n`)
process.stdout.write('\n本次为只读预览，未写入任何文件。\n')
