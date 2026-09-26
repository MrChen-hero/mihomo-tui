import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { RuleEditor } from '../RuleEditor.js'
import { RuleService } from '../../config/ruleService.js'
import { ConfigManager } from '../../config/manager.js'
import { DEFAULT_CONFIG } from '../../config.js'
import { parseForm } from '../../rules/editor.js'
import { requestGuardedExit } from '../../ui/exitGuard.js'
import { keysCaptured } from '../../ui/keyCapture.js'
import { createTerminal, delay, textOf, type Terminal } from '../../components/__tests__/harness.js'

const terminals: Terminal[] = [], roots: string[] = []
afterEach(async () => {
  for (const term of terminals.splice(0)) term.instance.unmount()
  await delay(20)
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})
function setup(rules = ['DOMAIN,a.example,DIRECT', 'DOMAIN,b.example,DIRECT', 'MATCH,DIRECT']) {
  const dir = mkdtempSync(join(tmpdir(), 'rule-editor-ui-')); roots.push(dir)
  const path = join(dir, 'config.yaml'), subs = join(dir, 'subs.json')
  writeFileSync(path, YAML.stringify({ mode: 'rule', rules }))
  writeFileSync(subs, '{"subscriptions":[{"name":"local","type":"local"}]}')
  const manager = new ConfigManager(dir)
  const validate = vi.spyOn(manager, 'validateRuleCandidate').mockResolvedValue({ ok: true, output: '' })
  let readFailure = false
  const client = {
    reload: vi.fn(async (_path: string) => {}),
    rules: vi.fn(async () => {
      if (readFailure) throw new Error('unreadable')
      return YAML.parse(readFileSync(path, 'utf8')).rules.map((raw: string) => {
        const form = parseForm(raw)!
        return { type: form.type, payload: form.value, proxy: form.target }
      })
    }),
  }
  const onClose = vi.fn(), onSaved = vi.fn()
  const service = (onProgress: ConstructorParameters<typeof RuleService>[0]['onProgress']) => new RuleService({ manager, client,
    controller: 'http://127.0.0.1:19090', subscriptionsPath: subs, wait: async () => {}, onProgress })
  const config = { ...DEFAULT_CONFIG, mihomoDir: dir }
  const element = (width: number, height: number) => <RuleEditor config={config} width={width} height={height}
    createService={service} onClose={onClose} onSaved={onSaved} />
  const term = createTerminal(element(80, 18), { columns: 80, rows: 24 })
  terminals.push(term)
  return { term, path, manager, validate, client, onClose, onSaved, failRead: (value: boolean) => { readFailure = value },
    resize: (width: number, height: number) => term.instance.rerender(element(width, height)) }
}
const press = async (term: Terminal, key: string) => { term.press(key); await delay(65) }
async function addRaw(term: Terminal, raw: string) {
  await press(term, 'a'); await press(term, '\x1b[B'); await press(term, '\r'); await press(term, raw); await press(term, '\r')
}
async function confirmSave(term: Terminal) { await press(term, '\x13'); await press(term, 'y'); await delay(100) }

describe('configuration rule editor', () => {
  it('performs all four operations as one draft and one save at 80×24', async () => {
    const f = setup(); await delay(80)
    const before = readFileSync(f.path, 'utf8')
    await addRaw(f.term, 'DOMAIN,new.example,DIRECT')
    // Existing selection stays on a.example. Move it before the newly inserted rule.
    await press(f.term, 'K')
    await press(f.term, 'e'); await press(f.term, '\r') // form
    await press(f.term, '\x15'); await press(f.term, 'edited.example'); await press(f.term, '\r')
    await press(f.term, 'j'); await press(f.term, 'd')
    await press(f.term, '\r') // Enter does not delete
    expect(textOf(f.term.frames())).toContain('该行附属注释也会删除')
    await press(f.term, 'y')
    expect(readFileSync(f.path, 'utf8')).toBe(before)
    expect(f.client.reload).not.toHaveBeenCalled()
    await confirmSave(f.term)
    expect(f.client.reload).toHaveBeenCalledExactlyOnceWith(f.path)
    expect(f.onSaved).toHaveBeenCalledWith(expect.objectContaining({ status: 'confirmed' }))
    expect(YAML.parse(readFileSync(f.path, 'utf8')).rules).toEqual(['DOMAIN,edited.example,DIRECT', 'DOMAIN,b.example,DIRECT', 'MATCH,DIRECT'])
  })
  it('isolates raw text shortcuts, preserves long input and cancels form/draft without writes', async () => {
    const f = setup(); await delay(80)
    const before = readFileSync(f.path, 'utf8')
    await press(f.term, 'a'); await press(f.term, '\x1b[B'); await press(f.term, '\r')
    await press(f.term, 'DOMAIN,' + 'aedJK'.repeat(40) + ',DIRECT')
    await press(f.term, '\x1b')
    expect(readFileSync(f.path, 'utf8')).toBe(before)
    await addRaw(f.term, 'DOMAIN,' + 'a'.repeat(200) + '.example,DIRECT')
    await press(f.term, '\x1b')
    expect(textOf(f.term.frames())).toContain('放弃未保存草稿')
    expect(f.onClose).not.toHaveBeenCalled()
    await press(f.term, 'n')
    await confirmSave(f.term)
    expect(readFileSync(f.path, 'utf8')).toContain('a'.repeat(200) + '.example')
  })
  it('forbids add/move while filtering but supports delete and clearing the empty result', async () => {
    const f = setup(); await delay(80)
    await press(f.term, '/'); await press(f.term, 'a.example'); await press(f.term, '\r')
    await press(f.term, 'a')
    expect(textOf(f.term.frames())).toContain('清除筛选后可新增或调整顺序')
    await press(f.term, 'J'); await press(f.term, 'd'); await press(f.term, 'y')
    expect(textOf(f.term.frames())).toContain('没有匹配规则')
    await press(f.term, '/'); await press(f.term, '\x15'); await press(f.term, '\r')
    await addRaw(f.term, 'DOMAIN,new.example,DIRECT')
    await confirmSave(f.term)
    expect(f.onSaved).toHaveBeenCalled()
  })
  it('offers an empty list and form mode, rejects multiline raw paste', async () => {
    const f = setup([]); await delay(80)
    await press(f.term, 'j'); await press(f.term, 'e'); await press(f.term, 'd')
    await press(f.term, 'a'); await press(f.term, '\r'); await press(f.term, '\r')
    await press(f.term, 'example.com'); await press(f.term, '\r')
    await press(f.term, 'a'); await press(f.term, '\x1b[B'); await press(f.term, '\r')
    await press(f.term, '\x1b[200~DOMAIN,b,DIRECT\nMATCH,DIRECT\x1b[201~')
    expect(textOf(f.term.frames())).toContain('不允许换行')
    await press(f.term, '\x1b'); await confirmSave(f.term)
    expect(YAML.parse(readFileSync(f.path, 'utf8')).rules).toEqual(['DOMAIN,example.com,DIRECT'])
  })
  it('routes draft Ctrl+C to discard confirmation and unregisters on unmount', async () => {
    const f = setup(); await delay(80); await addRaw(f.term, 'DOMAIN,new,DIRECT')
    const exit = vi.fn()
    expect(requestGuardedExit(exit)).toBe(true); await delay(80)
    expect(exit).not.toHaveBeenCalled()
    expect(textOf(f.term.frames())).toContain('并退出程序')
    await press(f.term, 'n')
    expect(exit).not.toHaveBeenCalled()
    requestGuardedExit(exit); await delay(80); await press(f.term, 'y')
    expect(exit).toHaveBeenCalledTimes(1)
    f.term.instance.unmount(); await delay(80)
    expect(requestGuardedExit(exit)).toBe(false)
    expect(keysCaptured()).toBe(false)
  })
  it('cancels prevalidation before showing exit confirmation', async () => {
    const f = setup(); await delay(80); await addRaw(f.term, 'DOMAIN,new,DIRECT')
    let release!: () => void
    let signal: AbortSignal | undefined
    f.validate.mockImplementationOnce((_text, s) => { signal = s; return new Promise(resolve => { release = () => resolve({ ok: false, output: '校验已取消' }) }) })
    await confirmSave(f.term)
    const exit = vi.fn(); requestGuardedExit(exit); await delay(80)
    expect(signal?.aborted).toBe(true); expect(exit).not.toHaveBeenCalled()
    expect(f.client.reload).not.toHaveBeenCalled()
    release(); await delay(80)
    expect(textOf(f.term.frames())).toContain('放弃未保存草稿并退出程序')
    await press(f.term, 'y'); expect(exit).toHaveBeenCalledTimes(1)
  })
  it('blocks exit and duplicate save from writing through verification', async () => {
    const f = setup(); await delay(80); await addRaw(f.term, 'DOMAIN,new,DIRECT')
    let release!: (value: { ok: true; output: string }) => void
    f.validate.mockResolvedValueOnce({ ok: true, output: '' }).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    await confirmSave(f.term)
    const exit = vi.fn(); requestGuardedExit(exit); await delay(80)
    await press(f.term, '\x1b'); await press(f.term, '\x13'); await press(f.term, 'y')
    expect(exit).not.toHaveBeenCalled(); expect(f.onClose).not.toHaveBeenCalled()
    expect(textOf(f.term.frames())).toContain('正在保存，请等待完成')
    release({ ok: true, output: '' }); await delay(120)
    expect(f.client.reload).toHaveBeenCalledTimes(1); expect(f.onSaved).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()
  })
  it('pending state allows reread but neither another save nor a second reload', async () => {
    const f = setup(); await delay(80); await addRaw(f.term, 'DOMAIN,new,DIRECT')
    f.client.reload.mockImplementationOnce(async () => { f.failRead(true) })
    await confirmSave(f.term)
    expect(textOf(f.term.frames())).toContain('已保存 · 待确认')
    await press(f.term, '\x13'); await press(f.term, '\x1b')
    expect(f.client.reload).toHaveBeenCalledTimes(1); expect(f.onClose).not.toHaveBeenCalled()
    f.failRead(false); await press(f.term, 'r'); await delay(100)
    expect(f.client.reload).toHaveBeenCalledTimes(1); expect(f.onSaved).toHaveBeenCalledTimes(1)
  })
  it('keeps a usable discard confirmation when the terminal shrinks below the form minimum', async () => {
    const f = setup(); await delay(80); await addRaw(f.term, 'DOMAIN,new,DIRECT')
    const before = readFileSync(f.path, 'utf8')
    f.resize(30, 10); await delay(80)
    expect(textOf(f.term.frames())).toContain('请扩大终端')
    await press(f.term, '\x1b')
    expect(textOf(f.term.frames())).toContain('放弃草稿？y 确认 / n 取消')
    await press(f.term, 'n'); expect(f.onClose).not.toHaveBeenCalled()
    await press(f.term, '\x1b'); await press(f.term, 'y')
    expect(f.onClose).toHaveBeenCalledTimes(1)
    expect(readFileSync(f.path, 'utf8')).toBe(before)
  })
})
