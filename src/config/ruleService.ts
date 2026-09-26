/** The only orchestration path for persistent rule edits. UI never writes configuration. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isIP } from 'node:net'
import type { RuleItem } from '../api/types.js'
import { draftErrors, isDirty, parseForm, type RuleDraft } from '../rules/editor.js'
import { ConfigManager } from './manager.js'
import { assertSnapshot, digest, readRuleSnapshot, renderRuleCandidate, type RuleSnapshot } from './ruleDocument.js'
import { safeDiagnostic, validationSecrets } from './ruleValidation.js'
import { SUBS_PATH } from './subscriptions.js'

export interface RuleSaveClient { rules(): Promise<RuleItem[]>; reload(path: string): Promise<void> }
export type SavePhase = 'prepare' | 'conflict' | 'validate' | 'backup' | 'write' | 'postvalidate' | 'reload' | 'verify' | 'recover'
export type SaveStatus = 'confirmed' | 'pending' | 'not-applied' | 'restored' | 'recovery-required'
export interface RuleSaveResult {
  status: SaveStatus
  phase: SavePhase
  disk: 'original' | 'candidate' | 'external' | 'unknown'
  kernel: 'confirmed' | 'original-confirmed' | 'reload-accepted' | 'unknown' | 'unchanged'
  message: string
  backupPath?: string
  rules?: RuleItem[]
}
interface Transaction {
  snapshot: RuleSnapshot; draft: RuleDraft; candidate: Buffer; backupPath?: string; reloadAttempted: boolean
}
export interface RuleServiceOptions {
  manager: ConfigManager
  client: RuleSaveClient
  controller: string
  subscriptionsPath?: string
  onProgress?: (phase: SavePhase) => void
  wait?: (ms: number) => Promise<void>
  secret?: string
}
let transactionActive = false

export function localController(controller: string): boolean {
  try {
    const url = new URL(controller)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      (url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(url.hostname))
  } catch { return false }
}

/** Compare only observable, empirically mapped fields. Flags/complex syntax remain kernel-validated. */
export function runtimeMatches(draft: RuleDraft, rules: RuleItem[]): boolean {
  if (!Array.isArray(rules) || rules.length !== draft.rows.length) return false
  return draft.rows.every((row, i) => {
    const form = parseForm(row.raw.split(',').map(s => s.trim()).join(','))
    if (!form) return true
    const rule = rules[i]
    if (!rule || typeof rule.type !== 'string' || typeof rule.proxy !== 'string') return false
    const type = form.type === 'IP-CIDR6' ? 'IP-CIDR' : form.type
    const canonicalType = (s: string): string => s.replace(/[-_]/g, '').toLowerCase()
    const payload = (value: string): string => {
      if (form.type.startsWith('DOMAIN')) return value.toLowerCase()
      if (form.type.includes('CIDR')) {
        const [address = '', prefix = ''] = value.split('/')
        if (!isIP(address)) return value
        return (isIP(address) === 6 ? new URL('http://[' + address + ']').hostname : address) + '/' + Number(prefix)
      }
      return value
    }
    return canonicalType(rule.type) === canonicalType(type) && rule.proxy === form.target &&
      payload(rule.payload) === payload(form.value)
  })
}

export class RuleService {
  private pending?: Transaction
  private recoveryRequired = false
  private readonly wait: (ms: number) => Promise<void>
  constructor(private readonly options: RuleServiceOptions) {
    this.wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }
  open(): RuleSnapshot {
    return readRuleSnapshot(this.options.manager.configPath, this.options.subscriptionsPath ?? SUBS_PATH)
  }
  private diagnostic(error: unknown, snapshot: RuleSnapshot): string {
    return safeDiagnostic(error, [this.options.secret ?? '', ...validationSecrets(snapshot.bytes.toString('utf8'))])
  }
  private result(tx: Transaction, status: SaveStatus, phase: SavePhase, disk: RuleSaveResult['disk'], kernel: RuleSaveResult['kernel'], message: string, rules?: RuleItem[]): RuleSaveResult {
    if (status === 'recovery-required') this.recoveryRequired = true
    return { status, phase, disk, kernel, message, backupPath: tx.backupPath, rules }
  }
  private progress(phase: SavePhase): void { this.options.onProgress?.(phase) }
  private async readableRules(): Promise<RuleItem[]> {
    const rules = await this.options.client.rules()
    if (!Array.isArray(rules) || rules.some(r => !r || typeof r.type !== 'string' || typeof r.payload !== 'string' || typeof r.proxy !== 'string')) throw new Error('无效规则响应')
    return rules
  }
  private async readRuntime(draft: RuleDraft): Promise<{ kind: 'match' | 'mismatch' | 'unreadable'; rules?: RuleItem[] }> {
    let mismatches = 0
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await this.wait(500)
      try {
        const rules = await this.readableRules()
        if (runtimeMatches(draft, rules)) return { kind: 'match', rules }
        mismatches++
      } catch { /* A failed read is not evidence of a mismatch. */ }
    }
    return { kind: mismatches === 3 ? 'mismatch' : 'unreadable' }
  }
  private async verify(tx: Transaction): Promise<RuleSaveResult> {
    this.progress('verify')
    const read = await this.readRuntime(tx.draft)
    try { assertSnapshot(tx.snapshot, digest(tx.candidate)) }
    catch (err) { return this.result(tx, 'recovery-required', 'verify', 'external', 'unknown', this.diagnostic(err, tx.snapshot)) }
    if (read.kind === 'match') {
      this.pending = undefined
      try { this.options.manager.pruneBackups() } catch { /* Cleanup never changes transaction success. */ }
      return this.result(tx, 'confirmed', 'verify', 'candidate', 'confirmed', '已保存并回读确认；复杂规则与附加参数仅经内核校验，未逐项核对', read.rules)
    }
    if (read.kind === 'unreadable') {
      this.pending = tx
      return this.result(tx, 'pending', 'verify', 'candidate', 'reload-accepted', '配置已保存，重载已接受，运行规则读取未确认；仅可重新读取')
    }
    return this.recover(tx, 'verify', '运行规则持续不一致')
  }
  private async recover(tx: Transaction, phase: SavePhase, cause: string): Promise<RuleSaveResult> {
    this.pending = undefined
    this.progress('recover')
    try { assertSnapshot(tx.snapshot, digest(tx.candidate)) }
    catch (err) { return this.result(tx, 'recovery-required', phase, 'external', 'unknown', cause + '；已停止自动恢复：' + this.diagnostic(err, tx.snapshot)) }
    try {
      if (!tx.backupPath || digest(readFileSync(tx.backupPath)) !== tx.snapshot.hash) throw new Error('备份内容不匹配')
      this.options.manager.writeRuleBytes(tx.snapshot.bytes, tx.snapshot.attributes)
      assertSnapshot(tx.snapshot)
    } catch (err) { return this.result(tx, 'recovery-required', 'recover', 'unknown', 'unknown', '恢复文件失败：' + this.diagnostic(err, tx.snapshot)) }
    if (!tx.reloadAttempted) return this.result(tx, 'restored', phase, 'original', 'unchanged', cause + '；原文件已恢复，未执行重载')
    try {
      await this.options.client.reload(tx.snapshot.path)
      assertSnapshot(tx.snapshot)
      const read = await this.readRuntime(tx.snapshot.draft)
      assertSnapshot(tx.snapshot)
      if (read.kind !== 'match') return this.result(tx, 'recovery-required', 'recover', 'original', 'reload-accepted', '文件已恢复，恢复重载已接受，运行状态未确认')
      return this.result(tx, 'restored', phase, 'original', 'original-confirmed', cause + '；原文件和运行规则已恢复', read.rules)
    } catch (err) {
      let disk: RuleSaveResult['disk'] = 'original'
      try { assertSnapshot(tx.snapshot) } catch { disk = 'external' }
      return this.result(tx, 'recovery-required', 'recover', disk, 'unknown', '恢复未完成：' + this.diagnostic(err, tx.snapshot))
    }
  }
  async reread(): Promise<RuleSaveResult> {
    if (!this.pending || transactionActive || this.recoveryRequired) throw new Error('当前不能重新读取')
    transactionActive = true
    try { return await this.verify(this.pending) } finally { transactionActive = false }
  }
  async save(snapshot: RuleSnapshot, draft: RuleDraft, signal?: AbortSignal): Promise<RuleSaveResult> {
    let phase: SavePhase = 'prepare'
    const tx: Transaction = { snapshot, draft, candidate: Buffer.alloc(0), reloadAttempted: false }
    if (transactionActive || this.pending || this.recoveryRequired) return this.result(tx, 'not-applied', phase, 'unknown', 'unknown', '存在进行中、待确认或恢复未完成的事务，禁止再次保存')
    transactionActive = true
    let wrote = false
    const step = (next: SavePhase): void => { phase = next; this.progress(next) }
    try {
      step('prepare')
      if (!localController(this.options.controller)) throw new Error('仅支持本机回环控制器写入')
      if (resolve(this.options.manager.configPath) !== snapshot.path) throw new Error('配置路径上下文已变化')
      // Guard metadata is derived from the snapshot, never accepted from callers.
      tx.draft = { ...snapshot.draft, rows: draft.rows, moved: draft.moved, moveOrigins: draft.moveOrigins }
      const errors = draftErrors(tx.draft)
      if (errors.length) throw new Error(errors.join('；'))
      if (!isDirty(tx.draft)) throw new Error('没有待保存修改')
      tx.candidate = Buffer.from(renderRuleCandidate(snapshot, tx.draft))
      step('conflict'); assertSnapshot(snapshot)
      // Refuse an unreachable/incompatible controller before creating a backup or changing disk.
      await this.readableRules()
      if (signal?.aborted) throw new Error('保存准备已取消')
      step('validate')
      const pre = await this.options.manager.validateRuleCandidate(tx.candidate.toString('utf8'), signal)
      if (!pre.ok) throw new Error(pre.output)
      if (signal?.aborted) throw new Error('校验已取消')
      step('backup'); assertSnapshot(snapshot)
      tx.backupPath = this.options.manager.backupRuleBytes(readFileSync(snapshot.path), snapshot.attributes)
      if (digest(readFileSync(tx.backupPath)) !== snapshot.hash) throw new Error('备份内容与快照不一致')
      assertSnapshot(snapshot)
      if (signal?.aborted) throw new Error('校验已取消')
      step('write')
      assertSnapshot(snapshot)
      this.options.manager.writeRuleBytes(tx.candidate, snapshot.attributes)
      wrote = true
      step('postvalidate'); assertSnapshot(snapshot, digest(tx.candidate))
      const post = await this.options.manager.validateRuleCandidate(readFileSync(snapshot.path).toString('utf8'))
      if (!post.ok) throw new Error(post.output)
      assertSnapshot(snapshot, digest(tx.candidate))
      step('reload'); assertSnapshot(snapshot, digest(tx.candidate)); tx.reloadAttempted = true
      await this.options.client.reload(snapshot.path)
      return await this.verify(tx)
    } catch (err) {
      const message = this.diagnostic(err, snapshot)
      // A writer may have replaced the file before reporting an error (e.g. cleanup failure).
      if (!wrote && (phase as SavePhase) === 'write') {
        try { assertSnapshot(snapshot, digest(tx.candidate)); wrote = true }
        catch {
          try { assertSnapshot(snapshot) }
          catch { return this.result(tx, 'recovery-required', phase, 'external', 'unchanged', message + '；写入期间文件发生外部变化，已停止自动恢复') }
        }
      }
      if (wrote) return await this.recover(tx, phase, message)
      let disk: RuleSaveResult['disk'] = 'original'
      try { assertSnapshot(snapshot) } catch { disk = 'external' }
      return this.result(tx, 'not-applied', phase, disk, 'unchanged', message)
    } finally { transactionActive = false }
  }
}
