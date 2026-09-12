/**
 * vitest 全局安全网：测试代码物理禁止写入真实的 mihomo/mihomo-tui 配置目录。
 *
 * 背景事故：视图集成测试漏传 subscriptionsPath，事务沿默认路径写到了
 * 真实的 ~/.config/mihomo-tui/subscriptions.json。此防护保证任何此类
 * 失误都会立刻抛错，而不是静默污染生产配置。
 */
import fs from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const PROTECTED_DIRS = [
  join(homedir(), '.config', 'mihomo-tui'),
  join(homedir(), '.config', 'mihomo'),
  join(homedir(), '.config', 'systemd', 'user'),
]

function assertSafe(target: unknown): void {
  if (typeof target !== 'string' && !Buffer.isBuffer(target) && typeof target !== 'object') return
  const path = resolve(String(target))
  for (const dir of PROTECTED_DIRS) {
    if (path === dir || path.startsWith(dir + sep)) {
      throw new Error(
        `[测试防护] 拒绝写入生产路径 ${path}\n测试必须使用 tmpdir 注入路径（见 vitest.setup.ts）`,
      )
    }
  }
}

const GUARDED = [
  'writeFileSync',
  'appendFileSync',
  'renameSync',
  'copyFileSync',
  'rmSync',
  'rmdirSync',
  'unlinkSync',
] as const

for (const name of GUARDED) {
  const original = fs[name] as (...args: unknown[]) => unknown
  Object.defineProperty(fs, name, {
    value: function (target: unknown, ...rest: unknown[]) {
      assertSafe(target)
      return original.call(fs, target, ...rest)
    },
    writable: true,
    configurable: true,
  })
}
