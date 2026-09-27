import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const cli = join(root, 'src', 'cli.tsx')
const pkgVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version
const TIMEOUT = 15000

/** 经 tsx 直跑 cli.tsx（与 rules-cli 测试同款模式）；输出为单行版本号 */
function runCli(args: string[], env: NodeJS.ProcessEnv = {}): string {
  const out = execFileSync(process.execPath, ['--import', 'tsx', cli, ...args], {
    encoding: 'utf8',
    cwd: root,
    // 显式 undefined 的值会被 spawnSync 跳过，用于隔离宿主机可能存在的同名变量
    env: { ...process.env, ...env },
    timeout: TIMEOUT,
  })
  return out.trim()
}

describe('版本号来源链', () => {
  it(
    '不注入时回退到 package.json',
    () => {
      expect(runCli(['--version'], { MIHOMO_TUI_VERSION: undefined })).toBe(pkgVersion)
    },
    TIMEOUT,
  )

  it(
    '环境变量 MIHOMO_TUI_VERSION 优先于 package.json',
    () => {
      expect(runCli(['--version'], { MIHOMO_TUI_VERSION: '9.9.9-env' })).toBe('9.9.9-env')
    },
    TIMEOUT,
  )

  it(
    'bin 胶水端到端注入链（dist 优先，未编译时走 tsx 回退）',
    () => {
      const out = execFileSync(process.execPath, [join(root, 'bin', 'mihomo-tui'), '--version'], {
        encoding: 'utf8',
        cwd: root,
        timeout: TIMEOUT,
      })
      expect(out.trim()).toBe(pkgVersion)
    },
    TIMEOUT,
  )

  const distCli = join(root, 'dist', 'cli.js')
  it.runIf(existsSync(distCli))(
    'dist 直跑（npm 发布包的实际形态）',
    () => {
      const out = execFileSync(process.execPath, [distCli, '--version'], {
        encoding: 'utf8',
        cwd: root,
        timeout: TIMEOUT,
      })
      expect(out.trim()).toBe(pkgVersion)
    },
    TIMEOUT,
  )

  it(
    '编译期 globalThis 注入优先于一切（bun --define 等价路径）',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'version-inject-'))
      try {
        const fixture = join(dir, 'fixture.mjs')
        writeFileSync(
          fixture,
          [
            `globalThis.__MIHOMO_TUI_VERSION__ = '9.9.8-compiled'`,
            `const { VERSION } = await import(${JSON.stringify(pathToFileURL(join(root, 'src', 'version.ts')).href)})`,
            `console.log(VERSION)`,
            '',
          ].join('\n'),
        )
        const out = execFileSync(process.execPath, ['--import', 'tsx', fixture], {
          encoding: 'utf8',
          cwd: root,
          timeout: TIMEOUT,
        })
        expect(out.trim()).toBe('9.9.8-compiled')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
