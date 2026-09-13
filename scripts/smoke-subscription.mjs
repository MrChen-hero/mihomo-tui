#!/usr/bin/env node
/**
 * scripts/smoke-subscription.mjs —— 真实内核冒烟测试（设计稿阶段 3 验收）
 *
 * ⚠️  会重启 mihomo 服务数次（每次秒级断流），请在方便的时间手动执行。
 *
 * 流程：
 *   1. 快照 config.yaml 与 subscriptions.json 到 /tmp/mihomo-smoke-<时间戳>/
 *   2. 读取测试订阅 URL：环境变量 MIHOMO_TUI_SMOKE_SUB，
 *      或文件 ~/.config/mihomo-tui/smoke-sub-url（二者都不会被打印）
 *   3. addSubscription({ name: 'test-airport', ... })：真实备份→校验→写入→重启→确认
 *   4. 断言：服务 active、config.yaml 与订阅清单都含 test-airport
 *   5. deleteSubscription('test-airport')：移除订阅并清理缓存
 *   6. 配置/清单若与快照不一致，从快照恢复并重启服务
 *
 * 用法：
 *   npm run build
 *   MIHOMO_TUI_SMOKE_SUB='https://...' node scripts/smoke-subscription.mjs
 *   # 或者：把 URL 放进 ~/.config/mihomo-tui/smoke-sub-url 后直接运行本脚本
 */
import YAML from 'yaml'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, '..', 'dist')
if (!existsSync(join(dist, 'config', 'subscriptionService.js'))) {
  process.stderr.write('找不到 dist/，请先执行：npm run build\n')
  process.exit(1)
}
const load = async (rel) => import(pathToFileURL(join(dist, rel)).href)
const { ConfigManager } = await load('config/manager.js')
const { ServiceManager } = await load('config/service.js')
const { addSubscription, deleteSubscription } = await load('config/subscriptionService.js')
const { loadConfig } = await load('config.js')
const { redactUrl } = await load('config/subscriptions.js')

const MIHOMO_DIR = loadConfig().mihomoDir
const CONFIG_PATH = join(MIHOMO_DIR, 'config.yaml')
const SUBS_PATH = join(homedir(), '.config', 'mihomo-tui', 'subscriptions.json')
const TEST_NAME = 'test-airport'

function fail(message) {
  process.stderr.write(`\n❌ ${message}\n`)
  process.exit(1)
}

// ---- 0. 前置检查 ----
if (!existsSync(CONFIG_PATH)) fail(`找不到内核配置：${CONFIG_PATH}`)
if (!existsSync(SUBS_PATH)) fail(`找不到订阅清单：${SUBS_PATH}`)

const smokeUrl = process.env.MIHOMO_TUI_SMOKE_SUB
  ?? (existsSync(join(homedir(), '.config', 'mihomo-tui', 'smoke-sub-url'))
    ? readFileSync(join(homedir(), '.config', 'mihomo-tui', 'smoke-sub-url'), 'utf8').trim()
    : '')
if (!smokeUrl) {
  fail('缺少测试订阅 URL：设置环境变量 MIHOMO_TUI_SMOKE_SUB，或写入 ~/.config/mihomo-tui/smoke-sub-url')
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
const snapshotDir = join('/tmp', `mihomo-smoke-${stamp}`)
mkdirSync(snapshotDir, { recursive: true })
const snapConfig = join(snapshotDir, 'config.yaml')
const snapSubs = join(snapshotDir, 'subscriptions.json')
copyFileSync(CONFIG_PATH, snapConfig)
copyFileSync(SUBS_PATH, snapSubs)
process.stdout.write(`✅ 已快照 → ${snapshotDir}\n`)
process.stdout.write(`✅ 测试订阅：${redactUrl(smokeUrl)}\n\n`)

const service = new ServiceManager()
const manager = new ConfigManager(MIHOMO_DIR)
const restore = async () => {
  copyFileSync(snapConfig, CONFIG_PATH)
  copyFileSync(snapSubs, SUBS_PATH)
  await service.restart()
  process.stdout.write('✅ 已从快照恢复配置与清单并重启服务\n')
}

try {
  // ---- 1. 新增 ----
  process.stdout.write('▶ 新增订阅 test-airport ...\n')
  await addSubscription({ name: TEST_NAME, url: smokeUrl, prefix: '[T] ' })
  const active = await service.isActive()
  if (!active) fail('添加后服务未处于 active 状态')
  if (!readFileSync(CONFIG_PATH, 'utf8').includes(TEST_NAME)) fail('config.yaml 中未找到 test-airport')
  if (!readFileSync(SUBS_PATH, 'utf8').includes(TEST_NAME)) fail('订阅清单中未找到 test-airport')
  process.stdout.write('✅ 新增链路通过（服务 active，配置与清单已更新）\n\n')

  // ---- 2. 删除 ----
  process.stdout.write('▶ 删除订阅 test-airport ...\n')
  await deleteSubscription(TEST_NAME)
  if (readFileSync(CONFIG_PATH, 'utf8').includes(TEST_NAME)) fail('删除后 config.yaml 仍含 test-airport')
  if (readFileSync(SUBS_PATH, 'utf8').includes(TEST_NAME)) fail('删除后清单仍含 test-airport')
  if (existsSync(join(MIHOMO_DIR, 'providers', `${TEST_NAME}.yaml`))) {
    fail('删除后缓存文件 providers/test-airport.yaml 仍存在')
  }
  process.stdout.write('✅ 删除链路通过（配置/清单/缓存均已清理）\n')
} catch (err) {
  process.stderr.write(`\n❌ 冒烟失败：${err instanceof Error ? err.message : String(err)}\n`)
  await restore()
  process.exit(1)
}

// ---- 3. 与快照比对（确定性骨架应当逐字节一致） ----
const configNow = readFileSync(CONFIG_PATH, 'utf8')
const configSnap = readFileSync(snapConfig, 'utf8')
if (configNow !== configSnap) {
  process.stdout.write('⚠️  删除后配置与快照不一致（骨架生成应为确定性），尝试从快照恢复 ...\n')
  await restore()
  if (readFileSync(CONFIG_PATH, 'utf8') !== configSnap) fail('快照恢复后仍不一致，请手动检查')
  process.stdout.write('✅ 已恢复为冒烟前的配置\n')
}
const subsNow = YAML.parse(readFileSync(SUBS_PATH, 'utf8'))
const subsSnap = YAML.parse(readFileSync(snapSubs, 'utf8'))
// 语义比较：saveSubscriptions 会按名称排序并统一字段键序（幂等行为），
// 文本与手写快照不同但集合相同 —— 排序 + 固定键序后再比，真正的差异仍会触发恢复
const normSubs = (parsed) =>
  JSON.stringify(
    [...(parsed?.subscriptions ?? [])]
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((s) => ({ name: s.name, url: s.url, prefix: s.prefix ?? null })),
  )
if (normSubs(subsNow) !== normSubs(subsSnap)) {
  copyFileSync(snapSubs, SUBS_PATH)
  process.stdout.write('⚠️  订阅清单与快照不一致，已从快照恢复\n')
}

process.stdout.write('\n🎉 冒烟测试全部通过。快照保留在：' + snapshotDir + '\n')
