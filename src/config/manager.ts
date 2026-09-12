/**
 * ConfigManager —— 全项目唯一被允许写 config.yaml 的模块。
 *
 * 硬性流程（设计稿 4.3）：备份 → 临时目录 mihomo -t 校验 → 原子写（tmp+rename）
 * → 写后复验 → 失败从备份回滚。校验永远在 mkdtemp 的临时目录里进行，
 * 校验过程不会往真实配置目录写任何东西。
 */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { buildSkeleton } from './skeleton.js'
import type { ApplyResult, ErrorPhase, ParsedYaml, SkeletonOptions, Subscription, ValidateResult } from './types.js'

export const MIHOMO_DIR_DEFAULT = join(homedir(), '.config', 'mihomo')
export const MIHOMO_BIN_DEFAULT = join(homedir(), 'bin', 'mihomo')

/** 设计稿 9.2：配置备份保留 7 天 */
const BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const BACKUP_PREFIX = 'config.yaml.bak.'

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class ConfigManager {
  readonly mihomoDir: string
  readonly mihomoBin: string
  readonly configPath: string

  constructor(mihomoDir: string = MIHOMO_DIR_DEFAULT, mihomoBin: string = MIHOMO_BIN_DEFAULT) {
    this.mihomoDir = mihomoDir
    this.mihomoBin = mihomoBin
    this.configPath = join(mihomoDir, 'config.yaml')
  }

  readConfigText(): string {
    return readFileSync(this.configPath, 'utf8')
  }

  /** 读取并解析 config.yaml，缺失或不可解析直接抛错 */
  loadConfig(): ParsedYaml {
    let text: string
    try {
      text = this.readConfigText()
    } catch (err) {
      throw new Error(`读取配置失败：${msg(err)}`)
    }
    let parsed: unknown
    try {
      parsed = YAML.parse(text)
    } catch (err) {
      throw new Error(`config.yaml 解析失败：${msg(err)}`)
    }
    if (!isRecord(parsed)) {
      throw new Error('config.yaml 顶层必须是映射，而不是标量或列表')
    }
    return parsed as ParsedYaml
  }

  /** 备份当前配置，返回备份文件路径：config.yaml.bak.<YYYYMMDD-HHMMSS> */
  backup(): string {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+$/, '')
      .replace('T', '-')
    const backupPath = `${this.configPath}.bak.${stamp}`
    copyFileSync(this.configPath, backupPath)
    return backupPath
  }

  /**
   * 在临时目录里用 `mihomo -t` 校验。
   * 实测 -t 不需要 ruleset/provider 缓存在场即可通过（懒加载），
   * 且不要把 GEOIP/GEOSITE 规则放进来 —— 那会触发 mmdb 联网下载并超时。
   */
  validate(yamlText: string): ValidateResult {
    if (!existsSync(this.mihomoBin)) {
      return { ok: false, output: `找不到 mihomo 二进制：${this.mihomoBin}` }
    }
    const dir = mkdtempSync(join(tmpdir(), 'mihomo-validate-'))
    const file = join(dir, 'config.yaml')
    try {
      writeFileSync(file, yamlText, 'utf8')
      const output = execFileSync(this.mihomoBin, ['-t', '-d', dir, '-f', file], {
        encoding: 'utf8',
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { ok: true, output }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message || msg(err) }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** 原子写入 config.yaml：先写 .tmp 再 rename */
  writeConfig(yamlText: string): void {
    const tmp = `${this.configPath}.tmp`
    try {
      writeFileSync(tmp, yamlText, 'utf8')
      renameSync(tmp, this.configPath)
    } catch (err) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // 清理失败不影响上抛原始错误
      }
      throw new Error(`写入配置失败：${msg(err)}`)
    }
  }

  /** 从备份恢复配置。备份不存在时抛错，绝不静默。 */
  rollback(backupPath: string): void {
    if (!existsSync(backupPath)) {
      throw new Error(`备份文件不存在，无法回滚：${backupPath}`)
    }
    copyFileSync(backupPath, this.configPath)
  }

  /** provider 缓存目录必须存在，否则内核首次拉取订阅会失败 */
  ensureProvidersDir(): string {
    const dir = join(this.mihomoDir, 'providers')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 删除某个 provider 的本地缓存（缺省不存在时不报错） */
  deleteProviderCache(name: string): void {
    rmSync(join(this.mihomoDir, 'providers', `${name}.yaml`), { force: true })
  }

  /** 清理超过保留期的 config.yaml.bak.*，返回被删除的路径列表 */
  pruneBackups(now: number = Date.now()): string[] {
    const removed: string[] = []
    let entries: string[]
    try {
      entries = readdirSync(this.mihomoDir)
    } catch {
      return removed
    }
    for (const entry of entries) {
      if (!entry.startsWith(BACKUP_PREFIX)) continue
      const full = join(this.mihomoDir, entry)
      try {
        if (now - statSync(full).mtimeMs > BACKUP_RETENTION_MS) {
          rmSync(full, { force: true })
          removed.push(full)
        }
      } catch {
        // 单个文件处理失败不影响其余
      }
    }
    return removed
  }

  /**
   * 一步到位：生成 → 备份 → 校验 → 原子写 → 写后复验。
   * 任何阶段失败都返回 { ok:false, phase }，不做服务重启（那是调用方的事）。
   */
  applyConfig(
    subscriptions: Subscription[],
    options: SkeletonOptions & { oldConfig?: ParsedYaml } = {},
  ): ApplyResult {
    const { oldConfig, ...skeletonOptions } = options
    const fail = (phase: ErrorPhase, error: string): ApplyResult => ({ ok: false, phase, error })
    let skeleton: ParsedYaml
    let warnings: string[]
    let yamlText: string
    try {
      const old = oldConfig ?? this.loadConfig()
      const built = buildSkeleton(old, subscriptions, skeletonOptions)
      skeleton = built.skeleton
      warnings = built.warnings
      yamlText = YAML.stringify(skeleton, { lineWidth: 0, singleQuote: true })
    } catch (err) {
      return fail('generate', `生成配置失败：${msg(err)}`)
    }

    let backupPath: string
    try {
      backupPath = this.backup()
    } catch (err) {
      return fail('backup', `无法创建备份：${msg(err)}`)
    }

    const pre = this.validate(yamlText)
    if (!pre.ok) {
      return fail('validate', `配置校验失败：${pre.output}`)
    }

    try {
      this.writeConfig(yamlText)
    } catch (err) {
      return fail('write', msg(err))
    }

    // 写入后就地再校验一次，失败则从备份回滚
    const post = this.validate(this.readConfigText())
    if (!post.ok) {
      try {
        this.rollback(backupPath)
      } catch (err) {
        return fail('write', `写入后校验失败，且回滚失败（备份在 ${backupPath}）：${post.output}；${msg(err)}`)
      }
      return fail('write', `写入后校验失败（已回滚）：${post.output}`)
    }

    this.ensureProvidersDir()
    this.pruneBackups()
    return { ok: true, backupPath, warnings }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
