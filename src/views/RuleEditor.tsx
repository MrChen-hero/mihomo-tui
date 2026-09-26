import { useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { AppConfig } from '../config.js'
import { MihomoClient } from '../api/client.js'
import { ConfigManager } from '../config/manager.js'
import { RuleService, localController, type RuleSaveResult, type SavePhase } from '../config/ruleService.js'
import type { RuleSnapshot } from '../config/ruleDocument.js'
import { safeDiagnostic } from '../config/ruleValidation.js'
import { addRule, changeSummary, checkForm, checkRaw, deleteRule, draftErrors, editRule, FORM_TYPES,
  formatForm, isDirty, isProtected, movedRowIds, moveRule, parseForm, ruleType, type RuleDraft, type RuleForm } from '../rules/editor.js'
import { InputDialog, type InputField } from '../components/InputDialog.js'
import { ConfirmDialog } from '../components/ConfirmDialog.js'
import { ListDialog } from '../components/ListDialog.js'
import { ProgressDialog } from '../components/ProgressDialog.js'
import { ScrollList } from '../components/ScrollList.js'
import { FooterLine } from '../ui/FooterLine.js'
import { Panel } from '../ui/Panel.js'
import { colors } from '../ui/theme.js'
import { useKeyCapture } from '../ui/keyCapture.js'
import { useExitGuard } from '../ui/exitGuard.js'
import { displayWidth, truncateDisplay } from '../commands/output.js'

const PHASES: SavePhase[] = ['prepare', 'conflict', 'validate', 'backup', 'write', 'postvalidate', 'reload', 'verify', 'recover']
const LABELS: Record<SavePhase, string> = { prepare: '检查草稿', conflict: '检查文件冲突', validate: '隔离校验（可取消）', backup: '创建唯一备份',
  write: '原子写入', postvalidate: '写后复验', reload: '重载完整配置', verify: '读取运行规则', recover: '恢复文件与运行状态' }
const DISK_LABELS = { original: '原文件', candidate: '已保存候选配置', external: '检测到外部变更', unknown: '未知' }
const KERNEL_LABELS = { confirmed: '已回读确认', 'original-confirmed': '已恢复并回读确认', 'reload-accepted': '重载已接受，回读未确认', unknown: '未知', unchanged: '未发起重载' }
type Dialog = 'list' | 'mode' | 'type' | 'form' | 'raw' | 'filter' | 'detail' | 'delete' | 'discard' | 'save' | 'progress' | 'result'
export interface RuleEditorProps {
  config: AppConfig; width: number; height: number
  onClose: () => void
  onSaved: (result: RuleSaveResult) => void
  /** A factory keeps progress injection available to terminal tests. */
  createService?: (onProgress: (phase: SavePhase) => void) => RuleService
}
const wrap = (text: string, width: number): string[] => {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const char of paragraph) {
      if (displayWidth(line + char) > width) { lines.push(line); line = '' }
      line += char
    }
    lines.push(line)
  }
  return lines
}

export function RuleEditor({ config, width, height, onClose, onSaved, createService }: RuleEditorProps) {
  const [phase, setPhase] = useState<SavePhase>('prepare')
  const phaseRef = useRef<SavePhase>('prepare')
  const progress = (next: SavePhase): void => { phaseRef.current = next; setPhase(next) }
  const service = useMemo(() => createService ? createService(progress) : new RuleService({
    manager: new ConfigManager(config.mihomoDir, config.mihomoBin), client: new MihomoClient(config),
    controller: config.api, secret: config.secret, onProgress: progress,
  }), [config, createService])
  const [loaded] = useState<{ snapshot?: RuleSnapshot; error?: string }>(() => {
    try { return { snapshot: service.open() } } catch (err) { return { error: safeDiagnostic(err, [config.secret]) } }
  })
  const snapshot = loaded.snapshot
  const [draft, setDraft] = useState<RuleDraft | undefined>(snapshot?.draft)
  const [dialog, setDialog] = useState<Dialog>('list')
  const [selected, setSelected] = useState<string | undefined>(draft?.rows[0]?.id)
  const [filter, setFilter] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<string>()
  const [form, setForm] = useState<RuleForm>({ type: 'DOMAIN', value: '', target: 'DIRECT', noResolve: false })
  const [result, setResult] = useState<RuleSaveResult>()
  const [detailOffset, setDetailOffset] = useState(0)
  const busy = useRef(false)
  const abort = useRef<AbortController | undefined>(undefined)
  const exitIntent = useRef<(() => void) | undefined>(undefined)
  const cardWidth = Math.min(64, width)
  const inner = Math.max(1, cardWidth - 4)
  const clip = (value: string): string => truncateDisplay(value, inner)
  const visible = draft?.rows.filter(r => r.raw.toLowerCase().includes(filter.toLowerCase())) ?? []
  const index = Math.max(0, visible.findIndex(r => r.id === selected))
  const row = visible[index]
  const movedIds = useMemo(() => draft ? movedRowIds(draft) : new Set<string>(), [draft])
  const locked = result?.status === 'pending' || result?.status === 'recovery-required'
  const blocked = draft?.blocked ?? (!localController(config.api) ? '非本机回环控制器，仅可查看' : undefined)
  useKeyCapture(true)

  const close = (exit?: () => void): void => {
    if (busy.current) return
    if (result?.status === 'pending' && !exit) { setNotice('运行状态待确认，请按 r 重新读取'); setDialog('result'); return }
    if (draft && isDirty(draft)) { exitIntent.current = exit; setDialog('discard') }
    else (exit ?? onClose)()
  }
  useExitGuard(exit => {
    if (busy.current) {
      if (['prepare', 'conflict', 'validate'].includes(phaseRef.current)) { exitIntent.current = exit; abort.current?.abort(); setNotice('正在取消校验，请等待子进程退出') }
      else setNotice('正在保存，请等待完成')
      return
    }
    close(exit)
  })

  const update = (operation: () => RuleDraft): void => {
    try {
      const next = operation()
      const nextVisible = next.rows.filter(r => r.raw.toLowerCase().includes(filter.toLowerCase()))
      if (!nextVisible.some(r => r.id === selected)) setSelected(nextVisible[Math.min(index, nextVisible.length - 1)]?.id)
      setDraft(next); setNotice(''); setDialog('list')
    } catch (err) { setNotice(safeDiagnostic(err, [config.secret])) }
  }
  const save = async (reread = false): Promise<void> => {
    if (!snapshot || !draft || busy.current) return
    busy.current = true
    abort.current = new AbortController()
    setDialog('progress'); setNotice('')
    try {
      const next = reread ? await service.reread() : await service.save(snapshot, draft, abort.current.signal)
      setResult(next)
      setDetailOffset(0)
      if (next.status === 'confirmed') { onSaved(next); onClose(); return }
      setNotice(next.message)
      setDialog('result')
      if (exitIntent.current && next.status === 'not-applied') setDialog('discard')
    } catch (err) { setNotice(safeDiagnostic(err, [config.secret])); setDialog('list') }
    finally { busy.current = false; abort.current = undefined }
  }
  const submit = (raw: string, formMatch = false): void => {
    if (!draft) return
    update(() => editing ? editRule(draft, editing, raw) : addRule(draft, raw, row?.id, Boolean(filter), formMatch))
  }
  const detailLines = wrap([snapshot?.path ?? '', row?.raw ?? '', row && draft && isProtected(draft, row)
    ? '订阅直连 · 自动维护（按规则内容识别）' : '普通配置规则', '位置：' + (draft?.rows.findIndex(r => r.id === row?.id)! + 1)].join('\n'), inner)
  const resultLines = result ? wrap([result.message, '阶段：' + LABELS[result.phase], '磁盘：' + DISK_LABELS[result.disk],
    '内核：' + KERNEL_LABELS[result.kernel], ...(result.backupPath ? ['备份：' + result.backupPath] : [])].join('\n'), inner) : []

  useInput((input, key) => {
    if (key.ctrl && input === 'c') return // App routes the exit intent through the guard.
    if (dialog === 'progress') return
    if (width < 40 || height < 16) {
      if (dialog === 'discard') {
        if (input === 'y' || input === 'Y') (exitIntent.current ?? onClose)()
        else if (key.escape || input === 'n' || input === 'N') { exitIntent.current = undefined; setDialog(locked ? 'result' : 'list') }
      } else if (key.escape) close()
      return
    }
    if (dialog === 'detail') {
      if (key.escape || key.return) setDialog('list')
      if (key.downArrow || input === 'j') setDetailOffset(n => Math.min(Math.max(0, detailLines.length - 1), n + 1))
      if (key.upArrow || input === 'k') setDetailOffset(n => Math.max(0, n - 1))
      return
    }
    if (dialog === 'result') {
      if (key.downArrow || input === 'j') setDetailOffset(n => Math.min(Math.max(0, resultLines.length - 1), n + 1))
      if (key.upArrow || input === 'k') setDetailOffset(n => Math.max(0, n - 1))
      if (input === 'r' && result?.status === 'pending') void save(true)
      else if (key.escape || key.return) {
        if (result?.status !== 'pending') setDialog('list')
      }
      return
    }
    if (dialog !== 'list') return
    if (key.escape) { close(); return }
    if (!draft) return
    if (key.upArrow || input === 'k') setSelected(visible[Math.max(0, index - 1)]?.id)
    else if (key.downArrow || input === 'j') setSelected(visible[Math.min(visible.length - 1, index + 1)]?.id)
    else if (input === '/') setDialog('filter')
    else if (key.return && row) { setDetailOffset(0); setDialog('detail') }
    else if (input === 'a' || input === 'e' || input === 'd' || input === 'J' || input === 'K' || (key.ctrl && input === 's')) {
      if (blocked || locked) { setNotice(blocked ?? '运行状态尚未确认，禁止修改或再次保存'); return }
      if (key.ctrl && input === 's') {
        const errors = draftErrors(draft)
        if (!isDirty(draft)) setNotice('没有待保存修改')
        else if (errors.length) setNotice(errors.join('；'))
        else setDialog('save')
      } else if (input === 'a') {
        if (filter) { setNotice('清除筛选后可新增或调整顺序'); return }
        setEditing(undefined); setDialog('mode'); setNotice('')
      } else if (row) {
        if (isProtected(draft, row)) { setNotice('订阅直连 · 自动维护（按规则内容识别），不可修改'); return }
        if (input === 'e') {
          setEditing(row.id)
          const parsed = parseForm(row.raw, draft)
          if (parsed) { setForm(parsed); setDialog('mode') } else setDialog('raw')
          setNotice('')
        } else if (input === 'd') setDialog('delete')
        else update(() => moveRule(draft, row.id, input === 'J' ? 1 : -1, Boolean(filter)))
      }
    }
  })

  const cancel = (): void => { setDialog('list'); setNotice('') }
  let content: React.ReactNode
  if ((width < 40 || height < 16) && dialog !== 'progress') {
    content = dialog === 'discard'
      ? <Text>{result?.status === 'pending' ? '运行待确认，退出？y/n' : '放弃草稿？y 确认 / n 取消'}</Text>
      : <Text>请扩大终端（至少 40×22）；ESC 返回</Text>
  } else if (dialog === 'progress') {
    content = <ProgressDialog title="保存配置规则" current={LABELS[phase]} step={PHASES.indexOf(phase)} total={PHASES.length}
      detail={notice ? clip(notice) : undefined} width={cardWidth} cancelable={['prepare', 'conflict', 'validate'].includes(phase)} onCancel={() => abort.current?.abort()} />
  } else if (dialog === 'mode') {
    content = <ListDialog borderTitle={editing ? '编辑方式' : '新增规则'} width={cardWidth}
      items={[{ value: 'form', label: '常用表单' }, { value: 'raw', label: '单条原文' }]}
      onSubmit={value => setDialog(value === 'raw' ? 'raw' : editing ? 'form' : 'type')} onCancel={cancel} />
  } else if (dialog === 'type') {
    content = <ListDialog borderTitle="规则类型" width={cardWidth} maxVisible={Math.max(1, height - 6)}
      items={FORM_TYPES.map(type => ({ value: type, label: type }))}
      onSubmit={type => { setForm({ type, value: '', target: 'DIRECT', noResolve: false }); setDialog('form') }} onCancel={cancel} />
  } else if (dialog === 'filter' || dialog === 'raw' || dialog === 'form') {
    const fields: InputField[] = dialog === 'filter' ? [{ key: 'filter', label: '关键字（留空清除）', value: filter }]
      : dialog === 'raw' ? [{ key: 'raw', label: '完整单条原文', value: draft?.rows.find(r => r.id === editing)?.raw ?? '', required: true,
        validate: value => { try { checkRaw(value) } catch (err) { return safeDiagnostic(err) } } }]
        : [
          ...(form.type === 'MATCH' ? [] : [{ key: 'value', label: form.type === 'RULE-SET' ? '已有规则集' : '匹配值', value: form.value, required: true,
            ...(form.type === 'RULE-SET' ? { options: draft?.providers.map(value => ({ value, label: value })) } : {}) }]),
          { key: 'target', label: '目标（e 选择）', value: form.target, required: true, options: draft?.targets.map(value => ({ value, label: value })) },
          ...(['IP-CIDR', 'IP-CIDR6', 'RULE-SET'].includes(form.type) ? [{ key: 'noResolve', label: 'no-resolve（跳过域名解析）', value: form.noResolve ? 'yes' : 'no',
            options: [{ value: 'no', label: '关闭' }, { value: 'yes', label: '开启' }] }] : []),
        ]
    content = <Box flexDirection="column"><InputDialog key={dialog} title={dialog === 'filter' ? '规则过滤' : dialog === 'raw' ? '单条规则原文' : form.type}
      fields={fields} width={cardWidth} singleLinePaste onCancel={cancel} onSubmit={values => {
        if (dialog === 'filter') { setFilter(values.filter ?? ''); setSelected(undefined); cancel() }
        else if (dialog === 'raw') submit(values.raw ?? '')
        else {
          const next = { ...form, value: values.value ?? '', target: values.target ?? '', noResolve: values.noResolve === 'yes' }
          try { checkForm(next, draft); submit(formatForm(next), true) } catch (err) { setNotice(safeDiagnostic(err)) }
        }
      }} />{notice && <Text color={colors.danger}>{clip(notice)}</Text>}</Box>
  } else if (dialog === 'delete' && row && draft) {
    content = <ConfirmDialog width={cardWidth} danger message={['删除 #' + (draft.rows.indexOf(row) + 1) + '？仅修改草稿', clip(row.raw),
      '该行附属注释也会删除', ...(ruleType(row.raw) === 'MATCH' ? ['将移除显式兜底规则'] : [])]}
      onConfirm={() => update(() => deleteRule(draft, row.id))} onCancel={cancel} />
  } else if (dialog === 'discard') {
    content = <ConfirmDialog width={cardWidth} danger message={[result?.status === 'pending' ? '配置已保存但运行状态待确认，确认退出？' : '放弃未保存草稿' + (exitIntent.current ? '并退出程序？' : '并返回？'),
      ...(locked ? ['磁盘/运行状态尚未确认，备份需保留'] : [])]}
      onConfirm={() => (exitIntent.current ?? onClose)()} onCancel={() => { exitIntent.current = undefined; setDialog(locked ? 'result' : 'list') }} />
  } else if (dialog === 'save' && draft && snapshot) {
    const summary = changeSummary(draft)
    const lines = ['确认保存并重载完整配置？', `新增 ${summary.added} · 修改 ${summary.edited} · 删除 ${summary.deleted} · 移动 ${summary.moved}`,
      snapshot.path, new URL(config.api).origin, '确认此控制器属于本机读取上述路径的 mihomo', '临时禁用和本地标记将清除',
      ...(draft.rows.some(r => ruleType(r.raw) === 'MATCH') ? [] : ['无显式 MATCH（兜底规则）'])]
    content = wrap(lines.join('\n'), inner).length + 8 > height
      ? <Box flexDirection="column"><Text>确认内容较长，请扩大终端；ESC 返回</Text><ConfirmDialog width={cardWidth} message="返回草稿后可查看完整路径" onConfirm={cancel} onCancel={cancel} /></Box>
      : <ConfirmDialog width={cardWidth} message={lines} onConfirm={() => void save()} onCancel={cancel} />
  } else if (dialog === 'detail') {
    content = <Panel title="配置规则原文 · ↑↓ 滚动" width={cardWidth}>
      {detailLines.slice(detailOffset, detailOffset + Math.max(1, height - 5)).map((line, i) => <Text key={i}>{line}</Text>)}
      <Text dimColor>Enter / ESC 返回</Text>
    </Panel>
  } else if (dialog === 'result' && result) {
    content = <Panel title={result.status === 'pending' ? '已保存 · 待确认' : result.status === 'recovery-required' ? '需要人工恢复' : '保存未完成 · 草稿保留'} width={cardWidth}>
      {resultLines.slice(detailOffset, detailOffset + Math.max(1, height - 5)).map((line, i) => <Text key={i}>{line}</Text>)}
      <Text dimColor>{result.status === 'pending' ? '↑↓ 滚动 · r 重新读取（不重复重载）' : '↑↓ 滚动 · Enter / ESC 返回草稿'}</Text>
    </Panel>
  } else {
    const errors = draft ? draftErrors(draft) : []
    content = <Panel title={'配置规则' + (draft && isDirty(draft) ? ' · 未保存' : '')} width={cardWidth}>
      <Text dimColor>{clip(snapshot?.path ?? config.mihomoDir)}</Text>
      <Text dimColor>{clip(`共 ${draft?.rows.length ?? 0} 条 · 从上到下匹配（PASS 等依内核语义）`)}</Text>
      {filter && <Text>{clip('过滤：' + filter)}</Text>}
      {(loaded.error || blocked || notice || errors[0]) && <Text color={colors.warning}>{clip(loaded.error || blocked || notice || errors[0] || '')}</Text>}
      <ScrollList items={visible} selected={index} height={Math.max(1, height - 10 - (filter ? 1 : 0))} emptyText="没有匹配规则；a 新增，/ 清除过滤"
        renderItem={(item, i) => <Text color={i === index ? colors.accent : undefined}>{clip((i === index ? '▌' : ' ') + '#' + (draft!.rows.indexOf(item) + 1) +
          (isProtected(draft!, item) ? ' [保护]' : item.original === undefined ? ' +' : item.original !== item.raw ? ' *' : '') +
          (movedIds.has(item.id) ? ' ↕' : '') + ' ' + item.raw)}</Text>} />
      <FooterLine width={inner} hints={[{ key: 'a/e/d', label: '增改删' }, { key: 'J/K', label: '调序' }, { key: '/', label: '过滤' }]} />
      <FooterLine width={inner} hints={[{ key: 'Enter', label: '原文' }, { key: 'Ctrl+S', label: '保存' }, { key: 'ESC', label: '返回' }]} />
    </Panel>
  }
  return <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">{content}</Box>
}
