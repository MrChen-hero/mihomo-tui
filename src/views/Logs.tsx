/** 标签页 3：实时日志 */
import { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
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
      return 'red'
    case 'warning':
      return 'yellow'
    case 'debug':
      return 'gray'
    default:
      return undefined
  }
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
        {logs.paused ? <Text color="yellow"> ⏸ 已暂停</Text> : null}
        {filter || editing ? (
          <Text color="cyan">{` /${filter}${editing ? '▏' : ''}`}</Text>
        ) : null}
        <Text dimColor>{`  缓冲 ${logs.bufferSize}/1000`}</Text>
        {logs.dropped > 0 ? (
          <Text dimColor>{`（已滚过 ${logs.dropped} 行）`}</Text>
        ) : null}
        {logs.state !== 'open' ? <Text color="yellow">{`  ${logs.state}`}</Text> : null}
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {visible.length === 0 ? (
          <Text dimColor>
            {filter ? '无匹配日志' : '等待日志…（内核空闲时不产生日志，可先制造一些流量）'}
          </Text>
        ) : (
          visible.map((entry) => (
            <Text key={entry.id} color={levelColor(entry.type)} wrap="truncate-end">
              {`${entry.type.padEnd(7)} ${entry.payload}`}
            </Text>
          ))
        )}
      </Box>
      <Text dimColor>{' l 切级别  / 过滤  Space 暂停  c 清屏'}</Text>
    </Box>
  )
}
