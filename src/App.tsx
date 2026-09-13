/**
 * Ink 根组件：四个标签页 + 全局快捷键 + 底部状态栏。
 *
 * 退出必须显式 process.exit —— mihomo 不回应 WebSocket close 帧，
 * 句柄不释放，事件循环永不为空（SPEC 3.6）。
 */
import { useEffect, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { MihomoClient } from './api/client.js'
import type { AppConfig } from './config.js'
import type { LogLevel } from './api/types.js'
import { useProxies } from './hooks/useProxies.js'
import { useProviders } from './hooks/useProviders.js'
import { useConnectionsStream, useLogStream, useStatusStream } from './hooks/useStream.js'
import { StatusBar, stateTone } from './components/StatusBar.js'
import { TopBar } from './ui/TopBar.js'
import { Panel } from './ui/Panel.js'
import { FooterLine } from './ui/FooterLine.js'
import { colors } from './ui/theme.js'
import { keysCaptured } from './ui/keyCapture.js'
import { ConfirmDialog } from './components/ConfirmDialog.js'
import { ProxiesView } from './views/Proxies.js'
import { ProvidersView } from './views/Providers.js'
import { LogsView } from './views/Logs.js'
import { ConnsView } from './views/Conns.js'

const TABS = ['节点', '订阅', '日志', '连接'] as const

const MODE_NAMES: Record<string, string> = { rule: '规则', global: '全局', direct: '直连' }

export interface AppProps {
  config: AppConfig
  /** 启动时已取到的内核信息，避免界面刚出现就显示「?」 */
  version: string | undefined
  mode: 'rule' | 'global' | 'direct' | undefined
}

export function App({ config, version, mode }: AppProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [tab, setTab] = useState(0)
  const [message, setMessage] = useState('')
  const [logLevel, setLogLevel] = useState<LogLevel>('info')
  const [currentMode, setCurrentMode] = useState<'rule' | 'global' | 'direct'>(
    (mode as 'rule' | 'global' | 'direct') || 'rule'
  )
  const [tick, setTick] = useState(0)
  // 退出确认层：主界面 ESC 先弹确认（分级退出，spec 2026-09-13）
  const [confirmExit, setConfirmExit] = useState(false)
  const [size, setSize] = useState({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  })

  // 终端尺寸变化时重算布局（窄屏降级为单栏）
  useEffect(() => {
    if (!stdout) return
    const onResize = () => setSize({ columns: stdout.columns, rows: stdout.rows })
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  // 提示信息 4 秒后自动消失
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(''), 4000)
    return () => clearTimeout(timer)
  }, [message])

  const proxies = useProxies(config)
  const providers = useProviders(config)
  const status = useStatusStream(config)
  // 日志与连接流只在对应标签页可见时渲染，避免在其他页被高频数据带着重渲染
  const logs = useLogStream(config, logLevel, tab === 2)
  const connections = useConnectionsStream(config, tab === 3)

  // spinner 心跳只在真的有东西转的时候才跑 —— 否则整个 App 每 120ms 重渲染一次，
  // 纯属白烧 CPU 与制造垃圾
  const spinning = Boolean(proxies.testingGroup) || providers.providers.some((p) => p.updating)
  useEffect(() => {
    if (!spinning) return
    const timer = setInterval(() => setTick((t) => t + 1), 120)
    return () => clearInterval(timer)
  }, [spinning])

  useInput((input, key) => {
    // Ctrl+C 硬退出（mihari 语义：任何层都直接退）
    if (key.ctrl && input === 'c') {
      exit()
      return
    }
    // 内层优先：对话框/文本编辑态/二次确认态捕获按键时全局键一律让路，
    // 否则对话框里的 ESC 会被这里再消费一次把整只 TUI 退掉（广播式 useInput）
    if (keysCaptured()) {
      return
    }
    // 日志页在编辑过滤词时会吞掉普通按键，这里只处理明确的全局键
    if (input >= '1' && input <= '4') {
      setTab(Number(input) - 1)
      return
    }
    if (key.tab) {
      setTab((t) => (t + 1) % TABS.length)
      return
    }
    // [ 向左切一个标签、] 向右切（循环式，与 Tab 同语义；TUI 惯例键位）
    if (input === '[') {
      setTab((t) => (t + TABS.length - 1) % TABS.length)
      return
    }
    if (input === ']') {
      setTab((t) => (t + 1) % TABS.length)
      return
    }
    if (key.escape) {
      // 分级退出：主界面 ESC 不再直接退，先弹退出确认（Enter 才真退）
      setConfirmExit(true)
      return
    }
    // m 键切换模式: rule -> global -> direct -> rule
    if (input === 'm') {
      const modes: Array<'rule' | 'global' | 'direct'> = ['rule', 'global', 'direct']
      const currentIndex = modes.indexOf(currentMode)
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % modes.length
      const nextMode = modes[nextIndex]!
      const client = new MihomoClient(config)
      client
        .setMode(nextMode)
        .then(() => {
          setCurrentMode(nextMode)
          const modeNames: Record<'rule' | 'global' | 'direct', string> = {
            rule: '规则',
            global: '全局',
            direct: '直连'
          }
          setMessage(`已切换到 ${modeNames[nextMode]} 模式`)
        })
        .catch((err) => {
          setMessage(`切换模式失败: ${err.message}`)
        })
    }
  })

  const apiPort = (() => {
    try {
      return new URL(new MihomoClient(config).api).port || '19090'
    } catch {
      return '19090'
    }
  })()

  // 布局预算：顶栏卡片 3（标题线+内容+底边）+ 键提示/消息共用 1 + 状态栏 2
  const bodyHeight = Math.max(6, size.rows - 6)
  const disconnected = status.state === 'closed' || status.state === 'reconnecting'
  // 连接中视同已连接（沿用既有行为；真正的断开/重连才降级）
  const shownState = disconnected ? status.state : 'open'

  return (
    <Box flexDirection="column" width={size.columns} minHeight={size.rows}>
      <TopBar
        tabs={TABS}
        active={tab}
        modeLabel={MODE_NAMES[currentMode] ?? currentMode}
        apiPort={apiPort}
        statusTone={stateTone(shownState)}
        width={size.columns}
      />
      <Box paddingX={1} height={1}>
        {message ? (
          <Text color={colors.success}>{` ${message}`}</Text>
        ) : (
          <FooterLine
            hints={[
              { key: 'Tab/[]', label: '循环' },
              { key: 'M', label: '切换模式' },
              { key: 'ESC', label: '退出' },
            ]}
            width={size.columns - 2}
          />
        )}
      </Box>

      {proxies.error && tab === 0 ? (
        <Panel danger title="内核不可达" width={size.columns}>
          <Text color={colors.danger}>
            {`${proxies.error}　请检查 systemctl --user status mihomo`}
          </Text>
        </Panel>
      ) : null}

      {confirmExit ? (
        // 退出确认居中独占 body（对齐 cc-switch 确认卡片语言：居中窄卡、
        // 取消在前）——模态期间页面内容隐藏，按键由 ConfirmDialog 独占
        <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
          <ConfirmDialog
            title="退出 mihomo-tui"
            message={['确认退出？内核服务不受影响，仍在后台运行']}
            enterConfirms
            width={Math.min(56, size.columns - 4)}
            onConfirm={exit}
            onCancel={() => setConfirmExit(false)}
          />
        </Box>
      ) : (
        <Box flexDirection="column" flexGrow={1} height={bodyHeight}>
        {tab === 0 ? (
          <ProxiesView
            proxies={proxies}
            height={bodyHeight}
            width={size.columns}
            tick={tick}
            active={tab === 0}
            onMessage={setMessage}
          />
        ) : null}
        {tab === 1 ? (
          <ProvidersView
            providers={providers}
            config={config}
            onChanged={() => proxies.refresh()}
            height={bodyHeight}
            width={size.columns}
            tick={tick}
            active={tab === 1}
            onMessage={setMessage}
          />
        ) : null}
        {tab === 2 ? (
          <LogsView
            logs={logs}
            level={logLevel}
            onLevelChange={setLogLevel}
            height={bodyHeight}
            width={size.columns}
            active={tab === 2}
            onMessage={setMessage}
          />
        ) : null}
        {tab === 3 ? (
          <ConnsView
            config={config}
            data={connections.data}
            height={bodyHeight}
            width={size.columns}
            active={tab === 3}
            onMessage={setMessage}
          />
        ) : null}
      </Box>
      )}

      <StatusBar
        version={version}
        mode={currentMode}
        up={status.up}
        down={status.down}
        upTotal={status.upTotal}
        downTotal={status.downTotal}
        memory={status.memory}
        state={shownState}
        currentNode={proxies.currentNode}
      />
    </Box>
  )
}
