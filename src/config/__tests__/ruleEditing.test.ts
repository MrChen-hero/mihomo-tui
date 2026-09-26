import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { ConfigManager } from '../manager.js'
import { RuleService, runtimeMatches, type SavePhase } from '../ruleService.js'
import { readRuleSnapshot, renderRuleCandidate } from '../ruleDocument.js'
import { addRule, changeSummary, checkForm, checkRaw, deleteRule, draftErrors, editRule, isDirty, moveRule, parseForm } from '../../rules/editor.js'
import { safeDiagnostic } from '../ruleValidation.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const base = '# file comment\nmode: rule # keep\ncustom: &custom { test: true }\ncopy: *custom\nrules: # sequence\n  - DOMAIN,sub.example,DIRECT # protected\n  - DOMAIN,a.example,DIRECT # first\n  - DOMAIN,a.example,DIRECT # second\n  - MATCH,DIRECT # fallback\n'
export function fixture(text = base) {
  const dir = mkdtempSync(join(tmpdir(), 'rule-edit-test-')); roots.push(dir)
  const path = join(dir, 'config.yaml'), subs = join(dir, 'subs.json'), bin = join(dir, 'mihomo')
  writeFileSync(path, text, { mode: 0o640 })
  writeFileSync(subs, JSON.stringify({ subscriptions: [{ name: 'test', url: 'https://sub.example/sub?token=private-value' }] }))
  writeFileSync(bin, '#!/usr/bin/env node\nprocess.stdout.write("validated");\n', { mode: 0o755 })
  const manager = new ConfigManager(dir, bin)
  const original = readRuleSnapshot(path, subs)
  let readsFail = false, mismatch = false
  const client = {
    reload: vi.fn(async (_path: string) => {}),
    rules: vi.fn(async () => {
      if (readsFail) throw new Error('read failed')
      const list = YAML.parse(readFileSync(path, 'utf8')).rules as string[]
      return list.map(raw => { const form = parseForm(raw)!; return { type: form.type, payload: form.value, proxy: mismatch ? 'REJECT' : form.target } })
    }),
  }
  const phases: SavePhase[] = []
  const service = new RuleService({ manager, client, controller: 'http://127.0.0.1:19090', subscriptionsPath: subs,
    wait: async () => {}, onProgress: phase => phases.push(phase) })
  const draft = editRule(original.draft, original.draft.rows[1]!.id, 'DOMAIN,edited.example,DIRECT')
  return { dir, path, subs, bin, manager, original, client, phases, service, draft,
    failReads: (value: boolean) => { readsFail = value }, mismatch: (value: boolean) => { mismatch = value } }
}

describe('rule drafts and YAML preservation', () => {
  it('independently edits duplicates, preserves comments/aliases, and does not write a draft', () => {
    const f = fixture(), draft = f.original.draft
    expect(new Set(draft.rows.map(r => r.id)).size).toBe(4)
    let next = editRule(draft, draft.rows[2]!.id, 'DOMAIN,b.example,DIRECT')
    next = moveRule(next, next.rows[2]!.id, -1)
    const text = renderRuleCandidate(f.original, next)
    expect(text.indexOf('b.example')).toBeLessThan(text.indexOf('a.example'))
    expect(text).toContain('b.example,DIRECT # second')
    expect(text).toContain('custom: &custom')
    expect(text).toContain('copy: *custom')
    expect(text).toContain('# sequence')
    expect(YAML.parse(text).custom).toEqual({ test: true })
    expect(readFileSync(f.path, 'utf8')).toBe(base)
  })
  it('calculates dirty by final content/order and counts only explicitly moved rows', () => {
    const { original: { draft } } = fixture()
    const id = draft.rows[1]!.id
    expect(isDirty(editRule(editRule(draft, id, 'DOMAIN,z,DIRECT'), id, draft.rows[1]!.raw))).toBe(false)
    const distinct = editRule(draft, id, 'DOMAIN,z,DIRECT')
    const moved = moveRule(distinct, id, 1)
    expect(changeSummary(moved).moved).toBe(1)
    expect(changeSummary(moveRule(moved, id, -1)).moved).toBe(0)
    const added = addRule(draft, 'DOMAIN,z,DIRECT', id)
    expect(changeSummary(added)).toEqual({ added: 1, edited: 0, deleted: 0, moved: 0 })
    expect(changeSummary(moveRule(added, id, -1)).moved).toBe(1)
    expect(changeSummary(moveRule(moveRule(added, id, -1), id, 1)).moved).toBe(0)
    expect(isDirty(deleteRule(added, added.rows.find(r => !r.original)!.id))).toBe(false)
  })
  it('protects equivalent direct rules and refuses inconsistent prefix or missing/empty/corrupt manifests', () => {
    const f = fixture()
    const draft = f.original.draft
    for (const fn of [() => editRule(draft, draft.rows[0]!.id, 'MATCH,DIRECT'), () => deleteRule(draft, draft.rows[0]!.id),
      () => moveRule(draft, draft.rows[0]!.id, 1), () => addRule(draft, 'DOMAIN, sub.example ,DIRECT'),
      () => moveRule(draft, draft.rows[1]!.id, -1)]) expect(fn).toThrow()
    writeFileSync(f.path, base.replace('DOMAIN,sub.example,DIRECT', 'DOMAIN,other.example,DIRECT'))
    expect(readRuleSnapshot(f.path, f.subs).draft.blocked).toContain('订阅直连')
    for (const content of ['{}', '{bad', '{"subscriptions":[]}']) {
      writeFileSync(f.subs, content)
      expect(readRuleSnapshot(f.path, f.subs).draft.blocked).toContain('订阅清单')
    }
    rmSync(f.subs)
    expect(readRuleSnapshot(f.path, f.subs).draft.blocked).toContain('订阅清单')
  })
  it('keeps complex raw syntax and validates MATCH and filtering boundaries', () => {
    const { original: { draft } } = fixture()
    const raw = 'AND,((DOMAIN,a.example),(NETWORK,TCP)),DIRECT'
    expect(parseForm(raw)).toBeUndefined()
    expect(addRule(draft, raw).rows.at(-2)?.raw).toBe(raw)
    expect(() => checkRaw('DOMAIN,a,DIRECT\nMATCH,DIRECT')).toThrow()
    expect(() => addRule(draft, 'DOMAIN,x,DIRECT', undefined, true)).toThrow('清除筛选')
    expect(() => moveRule(draft, draft.rows[1]!.id, 1, true)).toThrow('清除筛选')
    expect(() => moveRule(draft, draft.rows.at(-1)!.id, -1)).toThrow('MATCH')
    expect(draftErrors(addRule(draft, 'MATCH,DIRECT'))).toContain('MATCH 最多一条且必须位于末尾')
    expect(draftErrors(deleteRule(draft, draft.rows.at(-1)!.id))).toEqual([])
  })
  it('repairs a misplaced MATCH and adds MATCH from a form only at the end', () => {
    const f = fixture(base.replace('DOMAIN,a.example,DIRECT # first', 'MATCH,REJECT # first').replace('MATCH,DIRECT # fallback', 'DOMAIN,end,DIRECT'))
    let draft = f.original.draft
    expect(draftErrors(draft)).toContain('MATCH 最多一条且必须位于末尾')
    const id = draft.rows[1]!.id
    draft = moveRule(moveRule(draft, id, 1), id, 1)
    expect(draftErrors(draft)).toEqual([])
    draft = deleteRule(draft, id)
    expect(addRule(draft, 'MATCH,DIRECT', draft.rows[1]!.id, false, true).rows.at(-1)?.raw).toBe('MATCH,DIRECT')
  })
  it('rejects invalid forms and unknown references, falls back for extra flags and complex ports', () => {
    const { original: { draft } } = fixture()
    for (const [type, value] of [['IP-CIDR', '10.0.0.0/33'], ['IP-CIDR6', '::/129'], ['SRC-PORT', '90-80'], ['DST-PORT', '65536'], ['RULE-SET', 'missing']]) {
      expect(() => checkForm({ type: type!, value: value!, target: 'DIRECT', noResolve: false }, draft)).toThrow()
    }
    expect(parseForm('IP-CIDR,10.0.0.0/8,DIRECT,no-resolve,src')).toBeUndefined()
    expect(parseForm('SRC-PORT,80/443,DIRECT')).toBeUndefined()
    expect(parseForm('DOMAIN,a,UNKNOWN', draft)).toBeUndefined()
    expect(draftErrors(addRule(draft, 'DOMAIN,a,UNKNOWN'))).toContain('目标不存在于当前配置')
  })
  it('rejects aliases, mixed rules and symlinks; blocks rules anchors; allows missing rules', () => {
    const f = fixture()
    for (const text of ['rules: null', 'rules: [1]', 'base: &r ["MATCH,DIRECT"]\nrules: *r']) {
      writeFileSync(f.path, text); expect(() => readRuleSnapshot(f.path, f.subs)).toThrow()
    }
    writeFileSync(f.path, 'rules: &r ["MATCH,DIRECT"]')
    expect(readRuleSnapshot(f.path, f.subs).draft.blocked).toContain('锚点')
    writeFileSync(f.path, 'mode: rule')
    writeFileSync(f.subs, '{"subscriptions":[{"name":"local","type":"local"}]}')
    const empty = readRuleSnapshot(f.path, f.subs)
    expect(empty.draft.rows).toEqual([])
    expect(YAML.parse(renderRuleCandidate(empty, addRule(empty.draft, 'MATCH,DIRECT'))).rules).toEqual(['MATCH,DIRECT'])
    const link = join(f.dir, 'link.yaml'); symlinkSync(f.path, link)
    expect(() => readRuleSnapshot(link, f.subs)).toThrow('符号链接')
  })
})

describe('rule save transaction', () => {
  it('checks, validates, backs up, writes, revalidates, reloads explicit path, and verifies', async () => {
    const f = fixture()
    const result = await f.service.save(f.original, f.draft)
    expect(result.status).toBe('confirmed')
    expect(f.phases).toEqual(['prepare', 'conflict', 'validate', 'backup', 'write', 'postvalidate', 'reload', 'verify'])
    expect(f.client.reload).toHaveBeenCalledExactlyOnceWith(f.path)
    expect(readFileSync(result.backupPath!, 'utf8')).toBe(base)
    expect(statSync(f.path).mode & 0o777).toBe(0o640)
    expect(readdirSync(f.dir).some(n => n.includes('.tmp.'))).toBe(false)
  })
  it.each(['config', 'subscriptions'])('refuses %s conflicts without reload or backup', async kind => {
    const f = fixture()
    writeFileSync(kind === 'config' ? f.path : f.subs, 'external')
    const result = await f.service.save(f.original, f.draft)
    expect(result).toMatchObject({ status: 'not-applied', phase: 'conflict', disk: 'external' })
    expect(f.client.reload).not.toHaveBeenCalled()
  })
  it('rejects concurrent saves across service instances and detects edits during validation', async () => {
    const f = fixture(), other = fixture()
    let release!: (v: { ok: true; output: string }) => void
    vi.spyOn(f.manager, 'validateRuleCandidate').mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const saving = f.service.save(f.original, f.draft)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const second = await other.service.save(other.original, other.draft)
    expect(second.status).toBe('not-applied')
    writeFileSync(f.path, 'external')
    release({ ok: true, output: '' })
    expect((await saving).status).toBe('not-applied')
    expect(readFileSync(f.path, 'utf8')).toBe('external')
  })
  it('preserves candidate after unreadable verification and only rereads', async () => {
    const f = fixture(); f.client.reload.mockImplementationOnce(async () => { f.failReads(true) })
    const first = await f.service.save(f.original, f.draft)
    expect(first).toMatchObject({ status: 'pending', disk: 'candidate', kernel: 'reload-accepted' })
    expect(f.client.rules).toHaveBeenCalledTimes(4)
    expect((await f.service.save(f.original, f.draft)).status).toBe('not-applied')
    f.failReads(false)
    expect((await f.service.reread()).status).toBe('confirmed')
    expect(f.client.reload).toHaveBeenCalledTimes(1)
  })
  it('restores exact bytes and once reloads original after uncertain reload failure', async () => {
    const f = fixture(); f.client.reload.mockRejectedValueOnce(new Error('timeout; may have applied'))
    const result = await f.service.save(f.original, f.draft)
    expect(result).toMatchObject({ status: 'restored', disk: 'original', kernel: 'original-confirmed' })
    expect(readFileSync(f.path).equals(f.original.bytes)).toBe(true)
    expect(f.client.reload).toHaveBeenCalledTimes(2)
  })
  it('restores after definite mismatches and refuses retry when recovery reload fails', async () => {
    const f = fixture(); f.mismatch(true)
    f.client.reload.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { f.mismatch(false) })
    expect((await f.service.save(f.original, f.draft)).status).toBe('restored')
    expect(f.client.rules).toHaveBeenCalledTimes(5)
    const g = fixture(); g.client.reload.mockRejectedValue(new Error('offline'))
    const result = await g.service.save(g.original, g.draft)
    expect(result).toMatchObject({ status: 'recovery-required', disk: 'original', kernel: 'unknown' })
    expect((await g.service.save(g.original, g.draft)).status).toBe('not-applied')
    expect(g.client.reload).toHaveBeenCalledTimes(2)
  })
  it('restores postvalidation failure without reload, but never overwrites detected external edits', async () => {
    const f = fixture()
    vi.spyOn(f.manager, 'validateRuleCandidate').mockResolvedValueOnce({ ok: true, output: '' }).mockResolvedValueOnce({ ok: false, output: 'bad written file' })
    expect((await f.service.save(f.original, f.draft)).status).toBe('restored')
    expect(f.client.reload).not.toHaveBeenCalled()
    const g = fixture()
    g.client.reload.mockImplementationOnce(async () => { writeFileSync(g.path, 'external'); throw new Error('failed') })
    expect((await g.service.save(g.original, g.draft))).toMatchObject({ status: 'recovery-required', disk: 'external' })
    expect(readFileSync(g.path, 'utf8')).toBe('external')
    expect(g.client.reload).toHaveBeenCalledTimes(1)
  })
  it.each(['backupRuleBytes', 'writeRuleBytes'] as const)('handles %s failure before replacing production', async method => {
    const f = fixture(); vi.spyOn(f.manager, method).mockImplementation(() => { throw new Error('disk full') })
    const result = await f.service.save(f.original, f.draft)
    expect(result).toMatchObject({ status: 'not-applied', disk: 'original', kernel: 'unchanged' })
    expect(readFileSync(f.path, 'utf8')).toBe(base)
    expect(f.client.reload).not.toHaveBeenCalled()
  })
  it('reports unreadable restoration honestly and protects changed manifest during recovery', async () => {
    const f = fixture(); f.client.reload.mockImplementationOnce(async () => { f.failReads(true); throw new Error('timeout') })
    expect(await f.service.save(f.original, f.draft)).toMatchObject({ status: 'recovery-required', kernel: 'reload-accepted', disk: 'original' })
    const g = fixture(); g.client.reload.mockImplementationOnce(async () => { writeFileSync(g.subs, '{}'); throw new Error('timeout') })
    expect(await g.service.save(g.original, g.draft)).toMatchObject({ status: 'recovery-required', disk: 'external' })
    expect(readFileSync(g.path, 'utf8')).toContain('edited.example')
  })
  it('does not claim matching when a simple observable payload/order changed', () => {
    const f = fixture()
    expect(runtimeMatches(f.original.draft, f.original.draft.rows.map(r => ({ type: 'Domain', payload: r.raw, proxy: 'DIRECT' })))).toBe(false)
  })
  it('refuses unreachable controllers before validation/backup and handles a writer failing after rename', async () => {
    const f = fixture(); f.failReads(true)
    const validate = vi.spyOn(f.manager, 'validateRuleCandidate')
    expect(await f.service.save(f.original, f.draft)).toMatchObject({ status: 'not-applied', phase: 'conflict', disk: 'original' })
    expect(validate).not.toHaveBeenCalled(); expect(f.client.reload).not.toHaveBeenCalled()
    const g = fixture(), write = g.manager.writeRuleBytes.bind(g.manager)
    vi.spyOn(g.manager, 'writeRuleBytes').mockImplementationOnce((bytes, attributes) => { write(bytes, attributes); throw new Error('cleanup failed after replacement') })
    expect(await g.service.save(g.original, g.draft)).toMatchObject({ status: 'restored', disk: 'original', kernel: 'unchanged' })
    expect(readFileSync(g.path).equals(g.original.bytes)).toBe(true)
  })
  it('reports recovery write failure and does not overwrite an externally changed file after validation', async () => {
    const f = fixture(), write = f.manager.writeRuleBytes.bind(f.manager)
    vi.spyOn(f.manager, 'writeRuleBytes').mockImplementationOnce(write).mockImplementationOnce(() => { throw new Error('read-only filesystem') })
    f.client.reload.mockRejectedValueOnce(new Error('timeout'))
    expect(await f.service.save(f.original, f.draft)).toMatchObject({ status: 'recovery-required', disk: 'unknown', kernel: 'unknown' })
    expect(readFileSync(f.path, 'utf8')).toContain('edited.example')
    expect(f.client.reload).toHaveBeenCalledTimes(1)
    const g = fixture()
    vi.spyOn(g.manager, 'validateRuleCandidate').mockResolvedValueOnce({ ok: true, output: '' }).mockImplementationOnce(async () => {
      writeFileSync(g.path, 'external change'); return { ok: true, output: '' }
    })
    expect(await g.service.save(g.original, g.draft)).toMatchObject({ status: 'recovery-required', disk: 'external' })
    expect(g.client.reload).not.toHaveBeenCalled(); expect(readFileSync(g.path, 'utf8')).toBe('external change')
  })
  it('does not infer persistent mismatch from an unreadable/mismatched mixture', async () => {
    const f = fixture()
    const rules = f.client.rules.getMockImplementation()!
    f.client.rules.mockImplementationOnce(rules).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce([]).mockResolvedValueOnce([])
    expect(await f.service.save(f.original, f.draft)).toMatchObject({ status: 'pending', disk: 'candidate' })
    expect(f.client.reload).toHaveBeenCalledTimes(1)
  })
})

describe('isolated asynchronous validation and exclusive files', () => {
  it('creates unique same-time backups preserving attributes and bytes', () => {
    const f = fixture()
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const paths = Array.from({ length: 3 }, () => f.manager.backupRuleBytes(f.original.bytes, f.original.attributes))
    expect(new Set(paths).size).toBe(3)
    for (const path of paths) { expect(readFileSync(path).equals(f.original.bytes)).toBe(true); expect(statSync(path).mode & 0o777).toBe(0o640) }
  })
  it('copies relative providers/geodata into isolation and leaves live resources untouched', async () => {
    const f = fixture(); mkdirSync(join(f.dir, 'providers')); writeFileSync(join(f.dir, 'providers', 'local.yaml'), 'proxies: []')
    writeFileSync(join(f.dir, 'geosite.dat'), 'original')
    writeFileSync(f.bin, '#!/usr/bin/env node\nconst fs = require("fs"); const d = process.argv[4]; console.log(d); if (!fs.existsSync(d+"/providers/local.yaml")) process.exit(1); fs.writeFileSync(d+"/geosite.dat", "isolated");\n')
    const result = await f.manager.validateRuleCandidate('proxy-providers:\n  local: {type: file, path: providers/local.yaml}\nrules: []')
    expect(result.ok).toBe(true)
    expect(existsSync(result.output.trim())).toBe(false)
    expect(readFileSync(join(f.dir, 'geosite.dat'), 'utf8')).toBe('original')
  })
  it.each(['/tmp/outside.yaml', '../outside.yaml', 'missing.yaml'])('refuses unsupported/missing resource %s', async path => {
    const f = fixture()
    const result = await f.manager.validateRuleCandidate(YAML.stringify({ 'proxy-providers': { p: { type: 'file', path } }, rules: [] }))
    expect(result.ok).toBe(false)
    expect(readFileSync(f.path, 'utf8')).toBe(base)
  })
  it('refuses external symlink resources, missing geodata and unsupported resource options', async () => {
    const f = fixture(); symlinkSync('/etc/passwd', join(f.dir, 'escape'))
    for (const text of ['proxy-providers: {p: {type: file, path: escape}}', 'rules: ["GEOSITE,cn,DIRECT"]', 'external-ui: ui']) {
      expect((await f.manager.validateRuleCandidate(text)).ok).toBe(false)
    }
  })
  it('cancels and times out, reaps child and removes temporary directories without production writes', async () => {
    const f = fixture(), record = join(f.dir, 'child.json')
    writeFileSync(f.bin, '#!/usr/bin/env node\nconst fs=require("fs"); fs.writeFileSync(' + JSON.stringify(record) + ', JSON.stringify({pid:process.pid,dir:process.argv[4]})); setInterval(()=>{},1000);\n')
    const abort = new AbortController()
    const pending = f.manager.validateRuleCandidate('rules: []', abort.signal)
    await vi.waitFor(() => expect(existsSync(record)).toBe(true))
    const child = JSON.parse(readFileSync(record, 'utf8'))
    abort.abort()
    expect(await pending).toMatchObject({ ok: false, output: '校验已取消' })
    expect(() => process.kill(child.pid, 0)).toThrow()
    expect(existsSync(child.dir)).toBe(false)
    expect((await f.manager.validateRuleCandidate('rules: []', undefined, 100)).ok).toBe(false)
    expect(readFileSync(f.path, 'utf8')).toBe(base)
  })
  it('bounds and redacts diagnostics', () => {
    const output = safeDiagnostic('secret: password123 https://a.example/token-path?x=y private-value ' + 'x'.repeat(9000), ['private-value'])
    expect(output).not.toContain('password123'); expect(output).not.toContain('token-path'); expect(output).not.toContain('private-value')
    expect(output.length).toBeLessThanOrEqual(4000)
  })
})
