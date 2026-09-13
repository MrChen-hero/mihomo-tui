/** 标签页 3：实时日志 */
import { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { FooterLine, type FooterHint } from '../ui/FooterLine.js'
import { colors } from '../ui/theme.js'
import { useKeyCapture } from '../ui/keyCapture.js'
import type { LogLevel } from '../api/types.js'
import type { UseLogStreamResult } from '../hooks/useStream.js'

export interface LogsViewProps {
  logs: UseLogStreamResult
  level: LogLevel
  onLevelChange: (level: LogLevel) => void
  height: number
  width: number
  active: boolean
  onMessage: (text: string) => void
}

const LEVELS: LogLevel[] = ['error', 'warning', 'info', 'debug']

function levelColor(type: string): string | undefined {
  switch (type) {
    case 'error':
      return colors.danger
    case 'warning':
      return colors.warning
    case 'debug':
      return colors.muted
    default:
      return undefined
  }
}

const HINTS: FooterHint[] = [
  { key: 'l', label: '切级别' },
  { key: '/', label: '过滤' },
  { key: 'Space', label: '暂停' },
  { key: 'c', label: '清屏' },
]

/** payload 以日期开头时把时间戳段染成暗色，其余维持默认（不可解析就整行原样） */
function splitTimestamp(payload: string): [string, string] | undefined {
  const m = /^((?:\d{4}-\d{2}-\d{2})[ T]\S+)\s(.*)$/s.exec(payload)
  return m ? [m[1] ?? '', m[2] ?? ''] : undefined
}

export function LogsView({
  logs,
  level,
  onLevelChange,
  height,
  width,
  active,
  onMessage,
}: LogsViewProps) {
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState(false)

  const entries = useMemo(() => {
    if (!filter) return logs.entries
    // 过滤词按纯文本匹配，避免用户误输入正则元字符导致崩溃
    const needle = filter.toLowerCase()
    return logs.entries.filter((e) => e.payload.toLowerCase().includes(needle))
  }, [logs.entries, filter])

  // 过滤词编辑态捕获按键（含 ESC——退出编辑而非退出 TUI）
  useKeyCapture(editing)
  useInput(
    (input, key) => {
      if (editing) {
        if (key.return || key.escape) {
          setEditing(false)
          return
        }
        if (key.backspace || key.delete) {
          setFilter((f) => f.slice(0, -1))
          return
        }
        // 只接受可打印字符，忽略控制键
        if (input && !key.ctrl && !key.meta) setFilter((f) => f + input)
        return
      }
      if (input === '/') {
        setEditing(true)
        return
      }
      if (input === 'l') {
        const next = LEVELS[(LEVELS.indexOf(level) + 1) % LEVELS.length] ?? 'info'
        onLevelChange(next)
        onMessage(`日志级别 → ${next}`)
        return
      }
      if (input === ' ') {
        logs.setPaused(!logs.paused)
        return
      }
      if (input === 'c') {
        logs.clear()
        setFilter('')
        onMessage('已清屏')
      }
    },
    { isActive: active },
  )

  const listHeight = Math.max(3, height - 3)
  // 只渲染尾部可见部分，几百行日志全画会拖慢终端
  const visible = entries.slice(-listHeight)

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold>
        <Text underline>{`日志 [${level}]`}</Text>
        {logs.paused ? <Text color={colors.warning}> ⏸ 已暂停</Text> : null}
        {filter || editing ? (
          <Text color={colors.info}>{` /${filter}${editing ? '▏' : ''}`}</Text>
        ) : null}
        <Text dimColor>{`  缓冲 ${logs.bufferSize}/1000`}</Text>
        {logs.dropped > 0 ? (
          <Text dimColor>{`（已滚过 ${logs.dropped} 行）`}</Text>
        ) : null}
        {logs.state !== 'open' ? <Text color={colors.warning}>{`  ${logs.state}`}</Text> : null}
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {visible.length === 0 ? (
          <Text dimColor>
            {filter ? '无匹配日志' : '等待日志…（内核空闲时不产生日志，可先制造一些流量）'}
          </Text>
        ) : (
          visible.map((entry) => {
            const ts = splitTimestamp(entry.payload)
            return (
              <Text key={entry.id} color={levelColor(entry.type)} wrap="truncate-end">
                {`${entry.type.padEnd(7)} `}
                {ts ? (
                  <>
                    <Text dimColor>{`${ts[0]} `}</Text>
                    {ts[1]}
                  </>
                ) : (
                  entry.payload
                )}
              </Text>
            )
          })
        )}
      </Box>
      <Box paddingLeft={1}>
        <FooterLine hints={HINTS} width={width - 2} />
      </Box>
    </Box>
  )
}
