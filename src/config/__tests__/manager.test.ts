import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { ConfigManager } from '../manager.js'
import type { Subscription } from '../types.js'

const SUBS: Subscription[] = [{ name: 'alpha', url: 'https://a.example.com/sub?token=aaa' }]

let root: string
let mihomoDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mihomo-tui-mgr-'))
  mihomoDir = join(root, 'mihomo')
  mkdirSync(mihomoDir, { recursive: true })
})

/** stub mihomo：默认校验通过；配置含 MARKER_BAD 时失败 */
function stubMihomo(behavior: 'ok' | 'always-fail' = 'ok'): string {
  const body =
    behavior === 'ok'
      ? `#!/bin/sh
# $1=-t $2=-d $3=dir $4=-f $5=file
if grep -q MARKER_BAD "$5" 2>/dev/null; then
  echo "level=fatal msg=\\"stub validation failed\\"" >&2
  exit 1
fi
echo "Initial configuration complete"
echo "configuration file $5 test is successful"
exit 0
`
      : `#!/bin/sh
echo "stub always fails" >&2
exit 1
`
  const path = join(root, `mihomo-${behavior}`)
  writeFileSync(path, body, 'utf8')
  chmodSync(path, 0o755)
  return path
}

function writeConfig(content: string): void {
  writeFileSync(join(mihomoDir, 'config.yaml'), content, 'utf8')
}

describe('loadConfig', () => {
  it('解析合法 YAML', () => {
    writeConfig('mixed-port: 17890\nmode: rule\n')
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    expect(manager.loadConfig()).toEqual({ 'mixed-port': 17890, mode: 'rule' })
  })

  it('文件缺失抛错', () => {
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    expect(() => manager.loadConfig()).toThrow(/读取配置失败/)
  })

  it('不可解析抛错', () => {
    writeConfig('{broken: [[')
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    expect(() => manager.loadConfig()).toThrow(/解析失败/)
  })

  it('顶层不是映射抛错', () => {
    writeConfig('- a\n- b\n')
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    expect(() => manager.loadConfig()).toThrow(/顶层必须是映射/)
  })
})

describe('backup / rollback', () => {
  it('备份文件带时间戳且内容一致', () => {
    writeConfig('mode: rule\n')
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    const backupPath = manager.backup()
    expect(backupPath).toMatch(/config\.yaml\.bak\.\d{8}-\d{6}$/)
    expect(readFileSync(backupPath, 'utf8')).toBe('mode: rule\n')
  })

  it('rollback 从备份恢复；备份缺失时抛错', () => {
    writeConfig('mode: rule\n')
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    const backupPath = manager.backup()
    writeConfig('mode: global\n')
    manager.rollback(backupPath)
    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe('mode: rule\n')
    expect(() => manager.rollback(join(root, 'no-such-backup'))).toThrow(/备份文件不存在/)
  })
})

describe('validate', () => {
  it('stub 校验通过时 ok:true 且携带输出', () => {
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    const result = manager.validate('mode: rule\n')
    expect(result.ok).toBe(true)
    expect(result.ok && result.output).toContain('test is successful')
  })

  it('stub 校验失败时 ok:false 且错误来自 stderr', () => {
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    const result = manager.validate('mode: MARKER_BAD\n')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.output).toContain('stub validation failed')
  })

  it('mihomo 二进制不存在时直接返回失败而不是抛错', () => {
    const manager = new ConfigManager(mihomoDir, join(root, 'no-mihomo'))
    const result = manager.validate('mode: rule\n')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.output).toContain('找不到 mihomo 二进制')
  })
})

describe('writeConfig 原子写', () => {
  it('写入成功且不留 .tmp 残留', () => {
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    manager.writeConfig('mode: global\n')
    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe('mode: global\n')
    expect(readdirSync(mihomoDir).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })
})

describe('ensureProvidersDir / deleteProviderCache', () => {
  it('ensure 创建缓存目录（幂等）', () => {
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    manager.ensureProvidersDir()
    manager.ensureProvidersDir()
    expect(existsSync(join(mihomoDir, 'providers'))).toBe(true)
  })

  it('delete 删除指定缓存，缺失不报错', () => {
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    const providers = manager.ensureProvidersDir()
    writeFileSync(join(providers, 'alpha.yaml'), '# cache\n', 'utf8')
    manager.deleteProviderCache('alpha')
    manager.deleteProviderCache('ghost')
    expect(existsSync(join(providers, 'alpha.yaml'))).toBe(false)
  })
})

describe('pruneBackups 备份保留期', () => {
  it('只清理超过 7 天的备份，普通文件与新鲜备份不动', () => {
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    writeConfig('mode: rule\n')
    const stale = join(mihomoDir, 'config.yaml.bak.20250101-000000')
    const fresh = join(mihomoDir, 'config.yaml.bak.20990101-000000')
    const other = join(mihomoDir, 'cache.db')
    for (const file of [stale, fresh, other]) writeFileSync(file, 'x', 'utf8')
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    utimesSync(stale, old, old)

    const removed = manager.pruneBackups()
    expect(removed).toEqual([stale])
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })
})

describe('applyConfig 完整流程', () => {
  it('成功：写入骨架、创建备份与 providers 目录、返回 warnings', () => {
    writeConfig('mixed-port: 17890\nrules: ["MATCH,DIRECT"]\n')
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    const result = manager.applyConfig(SUBS)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(existsSync(result.backupPath)).toBe(true)
      expect(result.warnings).toBeTypeOf('object')
    }
    const written = YAML.parse(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8'))
    expect(written['proxy-providers']?.alpha?.path).toBe('./providers/alpha.yaml')
    expect(existsSync(join(mihomoDir, 'providers'))).toBe(true)
  })

  it('校验失败：返回 phase=validate，配置不被触碰', () => {
    // stub 二进制缺失 → validate 直接失败
    writeConfig('mode: MARKER_BAD\n')
    const broken = new ConfigManager(mihomoDir, join(root, 'missing-bin'))
    const result = broken.applyConfig(SUBS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.phase).toBe('validate')
    expect(readFileSync(join(mihomoDir, 'config.yaml'), 'utf8')).toBe('mode: MARKER_BAD\n')
  })

  it('生成失败（旧配置不可解析）：返回 phase=generate', () => {
    writeConfig('{broken')
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    const result = manager.applyConfig(SUBS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.phase).toBe('generate')
  })

  it('备份失败（目录被换成了文件）：返回 phase=backup', () => {
    writeConfig('mode: rule\n')
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    rmSync(mihomoDir, { recursive: true })
    writeFileSync(mihomoDir, 'not a dir', 'utf8')
    const result = manager.applyConfig(SUBS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(['backup', 'generate']).toContain(result.phase)
  })

  it('pruneBackups 在成功路径上被顺带执行', () => {
    writeConfig('mode: rule\n')
    const stale = join(mihomoDir, 'config.yaml.bak.20240101-000000')
    writeFileSync(stale, 'x', 'utf8')
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    utimesSync(stale, old, old)
    const manager = new ConfigManager(mihomoDir, stubMihomo())
    manager.applyConfig(SUBS)
    expect(existsSync(stale)).toBe(false)
  })
})
