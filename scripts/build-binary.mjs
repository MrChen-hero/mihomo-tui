#!/usr/bin/env node
/**
 * 单二进制打包脚本（v0.5.0，spec docs/specs/2026-09-24-deployment-binary-spec.md §7.2）。
 *
 * 用法：
 *   node scripts/build-binary.mjs --target linux-x64|linux-arm64|darwin-x64|darwin-arm64|windows-x64|all
 *                                 [--out-dir dist-bin] [--runtime bun|deno]
 *   环境变量 MIHOMO_TUI_VERSION 可覆盖版本号，默认读 package.json。
 *
 * 依赖 bun CLI 做交叉编译（--target bun-<os>-<arch>，单 runner 出全部平台），
 * 但本脚本本身只用 Node——CI 里 npm 环境即可调用，无需先装 bun 到 PATH 之外的东西。
 *
 * spike 结论（spec §4.1）落成的两个硬约束：
 * 1. ink 的 DEV 分支静态引用 react-devtools-core（npm 生产安装不含），
 *    --external 与 --define 都绕不过——这里在 node_modules 写入一个空实现
 *    stub 包让解析落地（编译产物永不进 DEV 模式，stub 不会被打包进行为）。
 * 2. 必须显式 --target bun-*（缺省 browser 目标连 Node builtin 都拒绝）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TARGETS = {
  'linux-x64': { bun: 'bun-linux-x64', output: 'linux-x64' },
  'linux-arm64': { bun: 'bun-linux-arm64', output: 'linux-arm64' },
  'darwin-x64': { bun: 'bun-darwin-x64', output: 'darwin-x64' },
  'darwin-arm64': { bun: 'bun-darwin-arm64', output: 'darwin-arm64' },
  'windows-x64': { bun: 'bun-windows-x64', output: 'windows-x64.exe' },
}
const BUN_VERSION = '1.4.2'

function fail(message, code = 1) {
  process.stderr.write(`错误：${message}\n`)
  process.exit(code)
}

// ---- 参数解析（手工解析，保持零依赖） ----
const argv = process.argv.slice(2)
function readFlag(name) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  // 空串也算缺参：--out-dir '' 会把产物解析到仓库根
  if (value === undefined || value === '' || value.startsWith('--')) fail(`${name} 缺少参数`, 2)
  argv.splice(index, 2)
  return value
}
const target = readFlag('--target') ?? 'linux-x64'
const outDir = resolve(root, readFlag('--out-dir') ?? 'dist-bin')
const runtime = readFlag('--runtime') ?? 'bun'
if (argv.length) fail(`未知参数：${argv.join(' ')}`, 2)

if (runtime !== 'bun') {
  // spec §11 约定：Deno 兜底路径仅在 Bun 出现不可修复 blocker 时启用，不留半成品
  fail(`--runtime ${runtime} 未启用：仅支持 bun（见 spec §4.1 spike 结论）`, 2)
}
if (!TARGETS[target] && target !== 'all') {
  fail(`--target 必须是 ${Object.keys(TARGETS).join('|')}|all`, 2)
}

// ---- 版本号：env 覆盖 > package.json ----
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = process.env['MIHOMO_TUI_VERSION'] || pkg.version

// ---- react-devtools-core stub（spike §4.1 发现 1）----
// 写进 node_modules 让 bun 的裸 specifier 解析落地；npm install/ci 会清掉，
// 每次构建幂等重建。内容与 ink DEV 分支的用法（initialize/connectToDevTools）对齐。
const stubDir = join(root, 'node_modules', 'react-devtools-core')
const stubIndex = `// build-binary.mjs 生成的构建期 stub：编译产物永不进 ink 的 DEV 模式
export default { initialize() {}, connectToDevTools() {} }
`
function ensureStub() {
  mkdirSync(stubDir, { recursive: true })
  writeFileSync(join(stubDir, 'package.json'), JSON.stringify({ name: 'react-devtools-core', version: '0.0.0-stub', type: 'module', main: 'index.js' }))
  writeFileSync(join(stubDir, 'index.js'), stubIndex)
}

function buildOne(name) {
  const { bun: bunTarget, output } = TARGETS[name]
  const outfile = join(outDir, `mihomo-tui-${version}-${output}`)
  const result = spawnSync('bun', [
    'build', '--compile', '--target', bunTarget,
    '--define', `globalThis.__MIHOMO_TUI_VERSION__=${JSON.stringify(version)}`,
    join(root, 'src', 'cli.tsx'), '--outfile', outfile,
  ], { cwd: root, encoding: 'utf8' })
  if (result.error) return { name, outfile, detail: `spawn 失败：${result.error.message}` }
  if (result.status === null && result.signal) return { name, outfile, detail: `bun 被信号终止：${result.signal}` }
  if (result.status !== 0) return { name, outfile, detail: (result.stderr || result.stdout || '').trim() }
  return { name, outfile, detail: null }
}

/** bun 缺失是最可能的环境错误：单独探测给出可行动的提示，而非空白的失败汇总 */
function checkBun() {
  const probe = spawnSync('bun', ['--version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    fail(`bun 不在 PATH 或不可执行：请安装 bun（锁定版本 ${BUN_VERSION}，见 spec §4.1）`)
  }
  const found = probe.stdout.trim()
  if (found && !found.startsWith(BUN_VERSION)) {
    process.stderr.write(`警告：bun 版本 ${found} 与锁定版本 ${BUN_VERSION} 不同，该组合未经验证\n`)
  }
}

function smoke(outfile) {
  // 冒烟三件套（spec §10）：--version 与包版本一致、--help 退出 0、
  // 无内核环境 status --json 退出码 3 且 stdout 干净
  const home = mkdtempSync(join(tmpdir(), 'bin-smoke-'))
  const env = { ...process.env, HOME: home }
  const checks = []
  const versionOut = spawnSync(outfile, ['--version'], { encoding: 'utf8', env })
  checks.push(['--version 输出一致', versionOut.status === 0 && versionOut.stdout.trim() === version])
  const help = spawnSync(outfile, ['--help'], { encoding: 'utf8', env })
  checks.push(['--help 退出 0', help.status === 0])
  const dead = spawnSync(outfile, ['--api', 'http://127.0.0.1:9', 'status', '--json'], { encoding: 'utf8', env })
  checks.push(['无内核 status --json 退出 3 且 stdout 空', dead.status === 3 && dead.stdout === ''])
  rmSync(home, { recursive: true, force: true })
  return checks
}

// ---- 主流程 ----
const names = target === 'all' ? Object.keys(TARGETS) : [target]
// 只有与本机 platform+arch 完全一致的产物才能本机冒烟（arm64 产物在 x64 主机上跑不起来）
const hostSuffix = { 'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64', 'darwin-x64': 'darwin-x64', 'darwin-arm64': 'darwin-arm64' }[`${process.platform}-${process.arch}`]
checkBun()
ensureStub()
mkdirSync(outDir, { recursive: true })
const failures = []
const successes = []
for (const name of names) {
  process.stderr.write(`构建 ${name} ... `)
  const { outfile, detail } = buildOne(name)
  if (detail !== null) {
    process.stderr.write('失败\n')
    failures.push({ name, detail })
    continue
  }
  process.stderr.write('完成\n')
  successes.push(outfile)
}

if (failures.length) {
  process.stderr.write(`\n${failures.length} 个目标失败：\n`)
  for (const { name, detail } of failures) process.stderr.write(`  ${name}\n${detail.split('\n').map((line) => `    ${line}`).join('\n')}\n`)
  process.exit(1)
}

// 本机产物冒烟先于 checksums：冒烟失败的目录里不应留下一份「校验通过」的假象
if (hostSuffix) {
  const hostFile = successes.find((file) => file.endsWith(`-${hostSuffix}`))
  if (hostFile) {
    const broken = smoke(hostFile).filter(([, ok]) => !ok)
    if (broken.length) {
      process.stderr.write(`\n冒烟失败（${hostFile.split('/').pop()}）：\n  ${broken.map(([label]) => label).join('\n  ')}\n`)
      process.exit(1)
    }
  }
}

// checksums.txt：sha256sum 默认格式（<hex>  <filename>），供 sha256sum -c 校验。
// 仅在全部目标构建成功后生成——部分成功产物附 checksums 会误导分发。
const lines = successes.map((file) => {
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
  return `${digest}  ${basename(file)}`
})
writeFileSync(join(outDir, 'checksums.txt'), lines.join('\n') + '\n')
process.stderr.write(`\n完成：${successes.length} 个产物 + checksums.txt → ${outDir}\n`)
