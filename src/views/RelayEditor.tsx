/**
 * 节点页内的代理链编辑（v0.4.0 §5.3）。
 *
 * relay 组挂在节点页左栏，与普通组混排。焦点落在 relay 组时右栏显示链而不是
 * 节点列表：a 追加一跳、e 替换当前跳（都从当前已加载的代理里选）、d 删除一跳、
 * ↑↓ 调序、t 逐跳测速、Enter 提交。提交走 applyRelays 事务（校验 → 写盘 → reload）。
 */
import { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { ListDialog } from '../components/ListDialog.js'
import { ConfirmDialog } from '../components/ConfirmDialog.js'
import { InputDialog } from '../components/InputDialog.js'
import { ProgressDialog } from '../components/ProgressDialog.js'
import { Panel } from '../ui/Panel.js'
import { FooterLine, type FooterHint } from '../ui/FooterLine.js'
import { colors, styles } from '../ui/theme.js'
import { fitDisplay } from '../commands/output.js'
import type { AppConfig } from '../config.js'
import { ConfigManager } from '../config/manager.js'
import { MihomoClient } from '../api/client.js'
import { loadSubscriptions } from '../config/subscriptions.js'
import {
  extractRelayGroups,
  relayCandidates,
  relayFromTemplate,
  RESERVED_NAMES,
  type RelayGroup,
  type RelayTemplate,
} from '../relay/editor.js'
import { applyRelays } from '../relay/apply.js'

const CHAIN_HINTS: FooterHint[] = [
  { key: 'a', label: '加一跳' },
  { key: 'd', label: '删除' },
  { key: 'e', label: '换节点' },
  { key: '↑↓', label: '调序' },
  { key: 't', label: '逐跳测速' },
  { key: 'Enter', label: '提交' },
  { key: 'ESC', label: '返回' },
]

export interface RelayEditorProps {
  config: AppConfig
  /** 正在编辑的 relay 组名 */
  name: string
  /** 内核当前已加载的全部代理名 */
  proxyNames: string[]
  height: number
  width: number
  active: boolean
  onMessage: (text: string) => void
  /** 编辑结束（提交成功或放弃）后回到节点页 */
  onClose: () => void
  /** 测试注入 */
  client?: MihomoClient
  manager?: ConfigManager
  subscriptionsPath?: string
}

type Dialog =
  | { type: 'none' }
  | { type: 'pick'; mode: 'append' | 'replace' }
  | { type: 'confirm-close' }
  | { type: 'progress' }
  | { type: 'error'; message: string[] }

/** 从当前配置读出全部 relay 组；读失败按空处理 */
function loadRelays(manager: ConfigManager): RelayGroup[] {
  try {
    return extractRelayGroups(manager.loadConfig()['proxy-groups'])
  } catch {
    return []
  }
}

export function RelayEditor({
  config,
  name,
  proxyNames,
  height,
  width,
  active,
  onMessage,
  onClose,
  client,
  manager,
  subscriptionsPath,
}: RelayEditorProps) {
  const api = useMemo(() => client ?? new MihomoClient(config), [client, config])
  const configManager = useMemo(() => manager ?? new ConfigManager(config.mihomoDir), [manager, config])

  const [hops, setHops] = useState<string[]>(() => {
    const existing = loadRelays(configManager).find((relay) => relay.name === name)
    return existing ? [...existing.proxies] : []
  })
  const [initial] = useState(() => hops.join('\n'))
  const [cursor, setCursor] = useState(0)
  const [dialog, setDialog] = useState<Dialog>({ type: 'none' })
  /** 逐跳测速结果：节点名 → 延迟毫秒，失败为 -1 */
  const [delays, setDelays] = useState<Record<string, number>>({})

  const dirty = hops.join('\n') !== initial
  const candidates = relayCandidates(proxyNames, name)

  const move = (step: -1 | 1): void => {
    setHops((current) => {
      const target = cursor + step
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      const [hop] = next.splice(cursor, 1)
      if (hop === undefined) return current
      next.splice(target, 0, hop)
      return next
    })
    setCursor((index) => {
      const target = index + step
      return target < 0 || target >= hops.length ? index : target
    })
  }

  const submit = (): void => {
    const relays = loadRelays(configManager).filter((relay) => relay.name !== name)
    relays.push({ name, type: 'relay', proxies: hops })
    setDialog({ type: 'progress' })
    void applyRelays(relays, candidates, {
      manager: configManager,
      subscriptionsPath,
      reload: () => api.reload(),
    })
      .then((result) => {
        setDialog({ type: 'none' })
        onMessage(result.warnings[0] ?? `已更新代理链 ${name}`)
        onClose()
      })
      .catch((err: unknown) => {
        const text = err instanceof Error ? err.message : String(err)
        setDialog({ type: 'error', message: text.split('\n') })
      })
  }

  const testHops = (): void => {
    onMessage(`逐跳测速 ${name}（各跳独立延迟，不代表整链）`)
    void (async () => {
      const results: Record<string, number> = {}
      for (const hop of hops) {
        try {
          results[hop] = (await api.testProxyDelay(hop)).delay
        } catch {
          results[hop] = -1
        }
      }
      setDelays(results)
    })()
  }

  useInput(
    (input, key) => {
      if (dialog.type === 'error') {
        setDialog({ type: 'none' })
        return
      }
      if (dialog.type !== 'none') return
      if (key.escape) {
        if (dirty) setDialog({ type: 'confirm-close' })
        else onClose()
        return
      }
      if (key.upArrow) {
        move(-1)
        return
      }
      if (key.downArrow) {
        move(1)
        return
      }
      if (input === 'a') {
        if (candidates.length === 0) {
          onMessage('没有可选节点，请先确认内核与订阅')
          return
        }
        setDialog({ type: 'pick', mode: 'append' })
        return
      }
      if (input === 'e') {
        if (hops.length === 0) return
        setDialog({ type: 'pick', mode: 'replace' })
        return
      }
      if (input === 'd') {
        setHops((current) => current.filter((_hop, position) => position !== cursor))
        setCursor((index) => Math.max(0, Math.min(index, hops.length - 2)))
        return
      }
      if (input === 't') {
        testHops()
        return
      }
      if (key.return) submit()
    },
    { isActive: active },
  )

  const listHeight = Math.max(3, height - 4)

  if (dialog.type === 'pick') {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <ListDialog
          borderTitle={dialog.mode === 'append' ? '添加一跳' : '替换当前跳'}
          items={candidates.map((candidate) => ({ value: candidate, label: candidate }))}
          width={Math.min(width, 64)}
          onSubmit={(value) => {
            if (dialog.mode === 'append') {
              setHops((current) => [...current, value])
              setCursor(hops.length)
            } else {
              setHops((current) => current.map((hop, position) => (position === cursor ? value : hop)))
            }
            setDialog({ type: 'none' })
          }}
          onCancel={() => setDialog({ type: 'none' })}
        />
      </Box>
    )
  }

  if (dialog.type === 'confirm-close') {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <ConfirmDialog
          message={['代理链有未提交的修改', '确认放弃？']}
          onConfirm={onClose}
          onCancel={() => setDialog({ type: 'none' })}
        />
      </Box>
    )
  }

  if (dialog.type === 'progress') {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <ProgressDialog title="更新代理链" current="写入配置并重载" total={1} step={0} completed={[]} />
      </Box>
    )
  }

  if (dialog.type === 'error') {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <Panel danger title="代理链更新失败" width={Math.min(width, 72)}>
          {dialog.message.map((line, position) => (
            <Text key={position} color={colors.danger} wrap="wrap">{line}</Text>
          ))}
          <Text {...styles.keyHint}>按任意键关闭</Text>
        </Panel>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Panel title={`代理链 · ${name}`} width={width} fillHeight>
        {hops.length === 0 ? (
          <Text dimColor>链是空的，按 a 从已有节点里加一跳</Text>
        ) : (
          hops.slice(0, listHeight).map((hop, position) => {
            const delay = delays[hop]
            const delayText = delay === undefined ? '' : delay < 0 ? '超时' : `${delay}ms`
            return (
              <Text key={`${position}:${hop}`}>
                {position === cursor ? <Text {...styles.rowFocus}>▌</Text> : ' '}
                {` ${position + 1}  ${fitDisplay(hop, Math.max(8, width - 20))}`}
                {delayText ? <Text color={delay !== undefined && delay < 0 ? colors.danger : colors.success}>{` ${delayText}`}</Text> : null}
              </Text>
            )
          })
        )}
      </Panel>
      <Box paddingLeft={1}>
        <FooterLine hints={CHAIN_HINTS} width={width - 2} />
      </Box>
    </Box>
  )
}

export interface NewRelayDialogProps {
  config: AppConfig
  /** 已有代理组名，用于重名校验 */
  existingNames: string[]
  proxyNames: string[]
  width: number
  onCreated: (name: string) => void
  onCancel: () => void
  manager?: ConfigManager
  subscriptionsPath?: string
  client?: MihomoClient
}

/**
 * 新建代理链：组名 → 模板（或空链）。模板只预填占位，
 * 真正的节点在编辑器里从已有代理中选。
 */
export function NewRelayDialog({
  existingNames,
  proxyNames,
  width,
  onCreated,
  onCancel,
  config,
  manager,
  subscriptionsPath,
  client,
}: NewRelayDialogProps) {
  const [template, setTemplate] = useState<RelayTemplate | 'empty' | null>(null)
  const [name, setName] = useState('')
  const api = useMemo(() => client ?? new MihomoClient(config), [client, config])
  const configManager = useMemo(() => manager ?? new ConfigManager(config.mihomoDir), [manager, config])

  if (template === null) {
    return (
      <ListDialog
        borderTitle="新建代理链"
        items={[
          { value: '落地中转', label: '落地中转（两跳）' },
          { value: '多跳隐私', label: '多跳隐私（三跳）' },
          { value: 'empty', label: '空链（手动添加）' },
        ]}
        width={Math.min(width, 64)}
        onSubmit={(value) => setTemplate(value as RelayTemplate | 'empty')}
        onCancel={onCancel}
      />
    )
  }

  return (
    <InputDialog
      title="代理链名称"
      fields={[
        {
          label: '组名',
          key: 'name',
          required: true,
          placeholder: '如 landing',
          validate: (value) => {
            const trimmed = value.trim()
            if (RESERVED_NAMES.includes(trimmed)) return '组名是保留名'
            if (existingNames.includes(trimmed)) return '组名与已有代理组重名'
            return undefined
          },
        },
      ]}
      width={width}
      onSubmit={(values) => {
        const relayName = (values['name'] ?? '').trim()
        setName(relayName)
        const relays = loadRelays(configManager)
        const created =
          template === 'empty' ? { name: relayName, type: 'relay' as const, proxies: [] } : relayFromTemplate(relayName, template)
        // 空链先落盘（不校验跳数，编辑器里再补），带占位的模板同样先落盘再编辑
        void applyRelays([...relays, created], relayCandidates(proxyNames, relayName), {
          manager: configManager,
          subscriptionsPath,
          reload: () => api.reload(),
        })
          .then(() => onCreated(relayName))
          .catch(() => onCreated(relayName))
      }}
      onCancel={onCancel}
    />
  )
}
