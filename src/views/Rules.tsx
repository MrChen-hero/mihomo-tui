/** 规则页：API 数据、保守本地测试与可回读确认的运行时禁用。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { MihomoClient } from '../api/client.js'
import type { AppConfig } from '../config.js'
import type { RuleItem, RuleProviderItem } from '../api/types.js'
import { ScrollList } from '../components/ScrollList.js'
import { InputDialog } from '../components/InputDialog.js'
import { FooterLine, type FooterHint } from '../ui/FooterLine.js'
import { Panel, TOP_PREFIX, panelTopParts } from '../ui/Panel.js'
import { colors, styles } from '../ui/theme.js'
import { useKeyCapture } from '../ui/keyCapture.js'
import { truncateDisplay, formatRelativeTime } from '../commands/output.js'
import { buildRulesTestResult, normalizeTarget, type RulesTestResult } from '../rules/matcher.js'
import { buildRuleRows, isSelectableRow, ruleTypes, type RuleRow } from '../rules/model.js'
import { normalizeRuleType } from '../rules/types.js'
import { canDisableRule, isUnsupportedApi, ruleSequence, toggleRule, type RuleClient } from '../rules/runtime.js'
import { RuleEditor } from './RuleEditor.js'

export interface RulesViewProps {
  config: AppConfig
  height: number
  width: number
  active: boolean
  onMessage: (text: string) => void
  client?: RuleClient
}

type Dialog = 'none' | 'filter' | 'test' | 'detail' | 'editor'
const messageOf = (err: unknown): string => err instanceof Error ? err.message : String(err)

export function RulesView({ config, height, width, active, onMessage, client }: RulesViewProps) {
  const api = useMemo(() => client ?? new MihomoClient(config), [client, config])
  const [rules, setRules] = useState<RuleItem[]>([])
  const [providers, setProviders] = useState<RuleProviderItem[]>([])
  const [ruleError, setRuleError] = useState('')
  const [providerError, setProviderError] = useState('')
  const [rulesLoading, setRulesLoading] = useState(true)
  const [providersLoading, setProvidersLoading] = useState(true)
  const [typeFilter, setTypeFilter] = useState('')
  const [keyword, setKeyword] = useState('')
  const [index, setIndex] = useState(0)
  const [dialog, setDialog] = useState<Dialog>('none')
  const [result, setResult] = useState<RulesTestResult>()
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [unsupported, setUnsupported] = useState(false)
  const [marks, setMarks] = useState<Set<number>>(new Set())
  const sequence = useRef('')
  const request = useRef(0)
  const operation = useRef(false)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; request.current++ }
  }, [])

  const acceptRules = useCallback((next: RuleItem[]) => {
    const signature = ruleSequence(next)
    if (sequence.current !== signature) setMarks(new Set())
    sequence.current = signature
    setRules(next)
    setResult(undefined)
  }, [])

  const reload = useCallback(() => {
    if (operation.current) return
    const id = ++request.current
    setRulesLoading(true)
    setProvidersLoading(true)
    void api.rules().then((next) => {
      if (!mounted.current || id !== request.current) return
      acceptRules(next)
      setRuleError('')
    }).catch((err: unknown) => {
      if (!mounted.current || id !== request.current) return
      acceptRules([])
      setRuleError(isUnsupportedApi(err) ? '内核不支持规则接口' : '规则加载失败：' + messageOf(err))
    }).finally(() => {
      if (mounted.current && id === request.current) setRulesLoading(false)
    })
    void api.ruleProviders().then((next) => {
      if (!mounted.current || id !== request.current) return
      setProviders(Object.values(next))
      setProviderError('')
    }).catch((err: unknown) => {
      if (!mounted.current || id !== request.current) return
      setProviders([])
      setProviderError(isUnsupportedApi(err) ? '内核不支持规则集接口' : '规则集加载失败：' + messageOf(err))
    }).finally(() => {
      if (mounted.current && id === request.current) setProvidersLoading(false)
    })
  }, [api, acceptRules])

  useEffect(() => {
    if (active) reload()
  }, [active, reload])

  useKeyCapture(active && dialog === 'detail')

  const rows = useMemo(() => buildRuleRows(rules, providers, { type: typeFilter, keyword }),
    [rules, providers, typeFilter, keyword])
  const selectable = rows.flatMap((row, position) => isSelectableRow(row) ? [position] : [])
  const safeIndex = Math.max(0, Math.min(index, selectable.length - 1))
  const currentRow = rows[selectable[safeIndex] ?? -1]
  const markOnly = currentRow?.kind === 'rule' && (unsupported || !canDisableRule(currentRow.rule))
  useEffect(() => { setIndex((value) => Math.max(0, Math.min(value, selectable.length - 1))) }, [selectable.length])

  const announce = (text: string): void => { setNotice(text); onMessage(text) }
  const runTest = (target: string): void => {
    const next = buildRulesTestResult(rules, target)
    setResult(next)
    setDialog('none')
    setNotice('')
    if (next.index !== null) {
      setTypeFilter('')
      setKeyword('')
      setIndex(next.index - 1)
    }
  }

  const updateProvider = async (): Promise<void> => {
    if (operation.current || providersLoading || currentRow?.kind !== 'provider') return
    operation.current = true
    setBusy(true)
    const name = currentRow.provider.name
    announce('正在更新规则集 ' + name)
    try {
      await api.updateRuleProvider(name)
      if (mounted.current) announce('已更新规则集 ' + name)
    } catch (err) {
      if (mounted.current) announce('更新失败：' + messageOf(err))
    } finally {
      operation.current = false
      if (mounted.current) { setBusy(false); reload() }
    }
  }

  const disableRule = async (): Promise<void> => {
    if (operation.current || rulesLoading || ruleError || currentRow?.kind !== 'rule') return
    if (markOnly) { announce('内核不支持此规则的禁用；可按 m 本地标记（不影响分流）'); return }
    operation.current = true
    setBusy(true)
    try {
      const changed = await toggleRule(api, rules, currentRow.index - 1)
      if (!mounted.current) return
      acceptRules(changed.rules)
      if (changed.status === 'unsupported') {
        setUnsupported(true)
        announce('内核不支持禁用；可按 m 本地标记（不影响分流）')
      } else if (changed.status === 'stale') {
        announce('规则列表或状态已变化，已刷新，请重新选择后重试')
      } else if (changed.status === 'unconfirmed') {
        announce('结果未确认，请刷新检查；未自动重试' + (changed.detail ? '：' + changed.detail : ''))
      } else {
        announce('已确认规则' + (changed.rules[currentRow.index - 1]?.extra?.disabled ? '临时禁用' : '启用') + '；重载或重启后可能恢复')
      }
    } catch (err) {
      if (mounted.current) announce('规则操作失败：' + messageOf(err))
    } finally {
      operation.current = false
      if (mounted.current) setBusy(false)
    }
  }

  useInput((input, key) => {
    if (dialog === 'detail') {
      if (key.escape || key.return) setDialog('none')
      return
    }
    if (dialog !== 'none' || operation.current) return
    if (key.upArrow || input === 'k') setIndex(Math.max(0, safeIndex - 1))
    else if (key.downArrow || input === 'j') setIndex(Math.min(Math.max(0, selectable.length - 1), safeIndex + 1))
    else if (input === 'l') {
      const types = ruleTypes(rules)
      setTypeFilter(types[types.indexOf(typeFilter) + 1] ?? '')
      setIndex(0)
    } else if (input === '/') setDialog('filter')
    else if (input === 'e') { request.current++; setDialog('editor') }
    else if (key.return && currentRow) setDialog('detail')
    else if (input === 't') {
      if (rulesLoading || ruleError) announce('规则尚未就绪，请先刷新')
      else setDialog('test')
    } else if (input === 'u') void updateProvider()
    else if (input === 'd') void disableRule()
    else if (input === 'm' && markOnly && currentRow?.kind === 'rule') {
      setMarks((before) => {
        const next = new Set(before)
        if (next.has(currentRow.index)) next.delete(currentRow.index)
        else next.add(currentRow.index)
        return next
      })
      announce('仅本地标记，不影响内核分流或规则测试')
    } else if (input === 'r') reload()
  }, { isActive: active })

  const hints: FooterHint[] = [
    { key: '↑↓', label: '移动' }, { key: 'l', label: '切类型' }, { key: '/', label: '过滤' },
    { key: 'Enter', label: '详情' }, { key: 't', label: '测试' }, { key: 'u', label: '更新规则集' },
    { key: 'e', label: '编辑配置' },
    { key: markOnly ? 'm' : 'd', label: markOnly ? '本地标记' : '禁用/启用' }, { key: 'r', label: '刷新' },
  ]
  const columns = Math.max(1, width - 6)
  const clip = (value: string): string => truncateDisplay(value, columns)
  const renderRow = (row: RuleRow, selected: boolean): React.ReactNode => {
    if (row.kind === 'header') return <Text color={colors.muted}>{clip('─ ' + row.label)}</Text>
    const cursor = selected ? '▌ ' : '  '
    if (row.kind === 'provider') return <Text>{clip(cursor + row.provider.name + '  ' + row.provider.vehicleType +
      '  ' + (row.provider.ruleCount ?? '---') + ' 条  ' + formatRelativeTime(row.provider.updatedAt))}</Text>
    const state = row.rule.extra?.disabled ? ' [已禁用]' : ''
    const marked = marks.has(row.index) ? ' [标记]' : ''
    const highlight = result?.index === row.index ? (result.outcome === 'hit' ? colors.success : colors.warning) : undefined
    return <Text color={highlight}>{clip(cursor + '#' + row.index + state + marked + ' ' +
      normalizeRuleType(row.rule.type) + ' ' + (row.rule.payload || '—') + ' → ' + row.rule.proxy)}</Text>
  }

  const summary = result?.outcome === 'hit'
    ? result.target + ' 本地命中 #' + result.index + ' → 目标 ' + result.rule?.proxy + '（非最终节点）'
    : result?.outcome === 'unsupported'
      ? '需内核判定，未确定出口：#' + result.index + ' ' + result.rule?.type + ' · ' + result.target
      : result ? result.target + ' 未命中任何规则' : ''
  const statusLines = [ruleError, providerError, notice, summary].filter(Boolean).length
  const loading = rulesLoading || providersLoading
  // 标题、底框、筛选栏、页脚各占一行；仅在列表溢出时给滚动计数留一行。
  const listSpace = Math.max(1, height - 4 - statusLines - Number(loading) - Number(busy))
  const listHeight = Math.max(1, listSpace - Number(rows.length > listSpace))
  const detailWidth = Math.min(width, 64)
  const detailTop = panelTopParts(currentRow?.kind === 'provider' ? '规则集详情' : '规则详情', detailWidth)

  return (
    <Box flexDirection="column" flexGrow={1}>
      {dialog === 'editor' ? <RuleEditor config={config} width={width} height={height}
        onClose={() => { setDialog('none'); reload() }} onSaved={(saved) => {
          setMarks(new Set()); setResult(undefined); setIndex(0); setKeyword(''); setTypeFilter(''); setUnsupported(false)
          if (saved.rules) acceptRules(saved.rules)
          announce(saved.message)
        }} /> : dialog === 'filter' || dialog === 'test' ? (
        <InputDialog title={dialog === 'filter' ? '按关键字过滤' : '规则测试（保守本地匹配）'} width={width}
          fields={dialog === 'filter'
            ? [{ label: '关键字（留空清除）', key: 'keyword', value: keyword }]
            : [{ label: '域名或 IP', key: 'target', required: true, validate: (value) => {
              try { normalizeTarget(value); return undefined } catch (err) { return messageOf(err) }
            } }]}
          onSubmit={(values) => {
            if (dialog === 'filter') { setKeyword(values['keyword'] ?? ''); setIndex(0); setDialog('none') }
            else runTest(values['target'] ?? '')
          }}
          onCancel={() => setDialog('none')} />
      ) : dialog === 'detail' && currentRow ? (
        <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
          <Box flexDirection="column" width={detailWidth}>
            <Text>
              <Text color={colors.accent}>{TOP_PREFIX}</Text>
              <Text {...styles.panelTitle}>{detailTop.title}</Text>
              <Text color={colors.accent}>{detailTop.tail}</Text>
            </Text>
            <Box flexDirection="column" borderStyle="round" borderTop={false} borderColor={colors.accent} paddingX={1}>
              {currentRow.kind === 'rule' ? <>
                <Text>{'#' + currentRow.index + '  ' + normalizeRuleType(currentRow.rule.type)}</Text>
                <Text wrap="wrap">{'内容：' + (currentRow.rule.payload || '—')}</Text>
                <Text wrap="wrap">{'目标：' + currentRow.rule.proxy}</Text>
                <Text>{'状态：' + (currentRow.rule.extra?.disabled === undefined ? '内核未提供' : currentRow.rule.extra.disabled ? '临时禁用' : '启用')}</Text>
                {normalizeRuleType(currentRow.rule.type) === 'RULE-SET' && <Text wrap="wrap">{'来源规则集：' + currentRow.rule.payload}</Text>}
              </> : currentRow.kind === 'provider' ? <>
                <Text wrap="wrap">{'规则集：' + currentRow.provider.name}</Text>
                <Text>{'类型：' + currentRow.provider.vehicleType + ' / ' + (currentRow.provider.behavior ?? '未知')}</Text>
                <Text>{'条数：' + (currentRow.provider.ruleCount ?? '未知')}</Text>
                <Text wrap="wrap">{'更新：' + (currentRow.provider.updatedAt ?? '未知')}</Text>
              </> : null}
              <Box marginTop={1}>
                <FooterLine hints={[{ key: 'Enter', label: '返回' }, { key: 'ESC', label: '返回' }]} width={Math.max(1, detailWidth - 4)} />
              </Box>
            </Box>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="row" flexGrow={1}>
          {/* 与其他页面一致：横向容器拉伸 Panel，底框撑满至页脚。 */}
          <Panel title={'规则 · ' + rules.length + '　规则集 · ' + providers.length} width={width} fillHeight>
            <Text dimColor>{clip('类型 ' + (typeFilter || '全部') + (keyword ? ' · ' + keyword : ''))}</Text>
            {loading && <Text dimColor>加载中 ...</Text>}
            {busy && <Text color={colors.info}>操作中 ...</Text>}
            {ruleError && <Text color={colors.danger}>{clip(ruleError)}</Text>}
            {providerError && <Text color={colors.danger}>{clip(providerError)}</Text>}
            {notice && <Text color={colors.warning}>{clip(notice)}</Text>}
            {summary && <Text color={result?.outcome === 'hit' ? colors.success : colors.warning}>{clip(summary)}</Text>}
            <ScrollList items={rows} selected={selectable[safeIndex] ?? 0} height={listHeight}
              emptyText={loading ? '等待规则与规则集' : '当前没有匹配的规则或规则集'}
              renderItem={(row, position) => renderRow(row, position === selectable[safeIndex])} />
          </Panel>
        </Box>
      )}
      {dialog === 'none' && <Box paddingLeft={1}>
        <FooterLine hints={hints} width={width - 2} />
      </Box>}
    </Box>
  )
}
