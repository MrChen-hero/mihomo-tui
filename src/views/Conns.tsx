/** 标签页 4：连接管理 */
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { MihomoClient } from '../api/client.js'
import { ScrollList } from '../components/ScrollList.js'
import { FooterLine, type FooterHint } from '../ui/FooterLine.js'
import { Panel } from '../ui/Panel.js'
import { colors, styles } from '../ui/theme.js'
import { useKeyCapture } from '../ui/keyCapture.js'
import { formatBytes, fitDisplay, padDisplay } from '../commands/output.js'
import type { ConnectionItem } from '../api/types.js'
import type { AppConfig } from '../config.js'

export interface ConnsViewProps {
  config: AppConfig
  data: { downloadTotal: number; uploadTotal: number; connections: ConnectionItem[] | null } | undefined
  height: number
  width: number
  active: boolean
  onMessage: (text: string) => void
}

type SortKey = 'traffic' | 'time' | 'host'

const HINTS: FooterHint[] = [
  { key: '↑↓', label: '移动' },
  { key: 'd', label: '关闭选中' },
  { key: 'D', label: '关闭全部' },
  { key: 's', label: '切换排序' },
]

function describeHost(conn: ConnectionItem): string {
  const { host, sniffHost, destinationIP, destinationPort } = conn.metadata
  const name = host || sniffHost || destinationIP || '?'
  return destinationPort ? `${name}:${destinationPort}` : name
}

function formatDuration(start: string): string {
  const began = Date.parse(start)
  if (Number.isNaN(began)) return '---'
  const seconds = Math.max(0, Math.floor((Date.now() - began) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`
}

export function ConnsView({ config, data, height, width, active, onMessage }: ConnsViewProps) {
  const client = useMemo(() => new MihomoClient(config), [config])
  const [index, setIndex] = useState(0)
  const [sort, setSort] = useState<SortKey>('traffic')
  const [confirmAll, setConfirmAll] = useState(false)

  // 无连接时内核返回 null 而非 []（SPEC 3.5）
  const conns = data?.connections ?? []

  const sorted = useMemo(() => {
    const list = [...conns]
    if (sort === 'time') return list.sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    if (sort === 'host') return list.sort((a, b) => describeHost(a).localeCompare(describeHost(b)))
    return list.sort((a, b) => b.download + b.upload - (a.download + a.upload))
  }, [conns, sort])

  useEffect(() => {
    if (index >= sorted.length) setIndex(Math.max(0, sorted.length - 1))
  }, [sorted.length, index])

  const current = sorted[index]

  // D 二次确认态捕获按键
  useKeyCapture(confirmAll)
  useInput(
    (input, key) => {
      if (confirmAll) {
        // 二次确认：只有明确按 y 才执行，其他任何键都取消
        if (input === 'y' || input === 'Y') {
          void client.closeAllConnections().then(() => onMessage('已关闭全部连接'))
        } else {
          onMessage('已取消')
        }
        setConfirmAll(false)
        return
      }
      if (key.upArrow || input === 'k') {
        setIndex((i) => Math.max(0, i - 1))
        return
      }
      if (key.downArrow || input === 'j') {
        setIndex((i) => Math.min(sorted.length - 1, i + 1))
        return
      }
      if (input === 'd' && current) {
        void client
          .closeConnection(current.id)
          .then(() => onMessage(`已关闭 ${describeHost(current)}`))
          .catch((err: unknown) =>
            onMessage(`关闭失败：${err instanceof Error ? err.message : String(err)}`),
          )
        return
      }
      if (input === 'D') {
        if (conns.length === 0) {
          onMessage('当前无连接')
          return
        }
        setConfirmAll(true)
        return
      }
      if (input === 's') {
        const order: SortKey[] = ['traffic', 'time', 'host']
        const next = order[(order.indexOf(sort) + 1) % order.length] ?? 'traffic'
        setSort(next)
        onMessage(`排序 → ${next}`)
      }
    },
    { isActive: active },
  )

  // Panel 顶线/底边 + 状态行各占 1 行（对齐订阅页设计，spec 2026-09-13 §2.4）
  const listHeight = Math.max(3, height - 6)
  const narrow = width < 100
  const hostWidth = narrow ? Math.max(18, width - 34) : Math.max(24, Math.floor(width * 0.32))

  // 将统计信息放入标题：连接 · 计数 · 累计流量 · 排序
  const sortLabel = sort === 'traffic' ? '流量' : sort === 'time' ? '时间' : '主机'
  const title = `连接 · ${conns.length} · 累计 ↑${formatBytes(data?.uploadTotal ?? 0)} ↓${formatBytes(data?.downloadTotal ?? 0)} · 排序：${sortLabel}`

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* row 容器让纵轴变交叉轴拉伸 Panel（Proxies 同款机制） */}
      <Box flexDirection="row" flexGrow={1}>
      <Panel title={title} fillHeight width={width}>
      <Text {...styles.tableHeader}>
        {' '}
        {padDisplay('HOST', hostWidth - 1)}
        {narrow ? '' : padDisplay('CHAIN', 24)}
        {padDisplay('↑', 10)}
        {padDisplay('↓', 10)}
        {'TIME'}
      </Text>
      <ScrollList
        items={sorted}
        selected={index}
        height={listHeight}
        emptyText="当前无活跃连接"
        renderItem={(conn, _i, isSelected) => (
          <Text wrap="truncate-end">
            {/* ▌ 属 ambiguous 宽度字符（部分终端 2 列），依赖列宽余量吸收 */}
            {isSelected ? <Text {...styles.rowFocus}>{'▌'}</Text> : ' '}
            {fitDisplay(describeHost(conn), hostWidth - 2)}
            {' '}
            {/* chains 从出口到入口排列，首位即实际出口节点 */}
            {narrow ? '' : `${fitDisplay(conn.chains.at(0) ?? '', 23)} `}
            <Text color={colors.success}>{padDisplay(formatBytes(conn.upload), 10)}</Text>
            <Text color={colors.success}>{padDisplay(formatBytes(conn.download), 10)}</Text>
            {formatDuration(conn.start)}
          </Text>
        )}
      />
      </Panel>
      </Box>

      {confirmAll ? (
        <Panel danger title={`确认关闭全部 ${conns.length} 条连接？`} width={width}>
          <Text color={colors.danger}>按 y 确认，其他键取消</Text>
        </Panel>
      ) : null}
      <Box paddingLeft={1}>
        <FooterLine hints={HINTS} width={width - 2} />
      </Box>
    </Box>
  )
}
