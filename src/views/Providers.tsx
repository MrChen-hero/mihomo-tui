/** 标签页 2：订阅（Providers） */
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { ScrollList } from '../components/ScrollList.js'
import { spinnerFrame } from '../components/DelayBadge.js'
import { formatBytes, formatRelativeTime, fitDisplay, padDisplay } from '../commands/output.js'
import type { UseProvidersResult } from '../hooks/useProviders.js'

export interface ProvidersViewProps {
  providers: UseProvidersResult
  height: number
  width: number
  tick: number
  active: boolean
  onMessage: (text: string) => void
}

export function ProvidersView({
  providers,
  height,
  width,
  tick,
  active,
  onMessage,
}: ProvidersViewProps) {
  const [index, setIndex] = useState(0)
  const [expanded, setExpanded] = useState<string | undefined>()
  const rows = providers.providers

  useEffect(() => {
    if (index >= rows.length) setIndex(Math.max(0, rows.length - 1))
  }, [rows.length, index])

  const current = rows[index]

  const expandedNodes = useMemo(
    () => (expanded ? providers.nodesOf(expanded) : []),
    [expanded, providers],
  )

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') {
        setIndex((i) => Math.max(0, i - 1))
        return
      }
      if (key.downArrow || input === 'j') {
        setIndex((i) => Math.min(rows.length - 1, i + 1))
        return
      }
      if (key.return) {
        setExpanded((prev) => (prev === current?.name ? undefined : current?.name))
        return
      }
      if (input === 'u' && current) {
        onMessage(`正在更新 ${current.name} ...`)
        void providers.update(current.name).then(() => {
          onMessage(`${current.name} 更新完成`)
        })
        return
      }
      if (input === 'U') {
        onMessage('正在更新全部订阅 ...')
        void providers.updateAll().then(() => onMessage('全部订阅更新完成'))
        return
      }
      if (input === 'c' && current) {
        onMessage(`正在检查 ${current.name} ...`)
        void providers.check(current.name).then(() => onMessage(`${current.name} 健康检查完成`))
        return
      }
      if (input === 'r') {
        providers.refresh()
        onMessage('已刷新')
      }
    },
    { isActive: active },
  )

  const listHeight = expanded ? Math.max(2, Math.floor((height - 5) / 2)) : Math.max(3, height - 4)

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold underline>
        {padDisplay('NAME', 14)}
        {padDisplay('NODES', 12)}
        {padDisplay('USAGE', 14)}
        {'UPDATED'}
      </Text>
      <ScrollList
        items={rows}
        selected={index}
        height={listHeight}
        emptyText="当前配置没有 proxy-providers"
        renderItem={(row, _i, isSelected) => (
          <Text
            color={isSelected ? 'black' : undefined}
            backgroundColor={isSelected ? 'cyan' : undefined}
          >
            {`${isSelected ? '>' : ' '} `}
            {padDisplay(row.name, 12)}
            {row.updating ? (
              <Text color="cyan">{padDisplay(`${spinnerFrame(tick)} 更新中`, 12)}</Text>
            ) : (
              <Text color={row.alive > 0 ? 'green' : 'red'}>
                {padDisplay(`${row.alive}/${row.nodes}`, 12)}
              </Text>
            )}
            {padDisplay(row.remaining === undefined ? '---' : formatBytes(row.remaining), 14)}
            {formatRelativeTime(row.updatedAt)}
          </Text>
        )}
      />

      {/* 更新失败是常态（域名失效、经代理 403），错误必须完整展示 */}
      {current?.error ? (
        <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
          <Text color="red" bold>
            {`${current.name} 更新失败`}
          </Text>
          <Text color="red" wrap="wrap">
            {current.error}
          </Text>
        </Box>
      ) : null}

      {expanded ? (
        <Box flexDirection="column" flexGrow={1}>
          <Text bold underline>{`${expanded} 的节点（${expandedNodes.length}）`}</Text>
          <ScrollList
            items={expandedNodes}
            selected={-1}
            height={Math.max(2, height - listHeight - 6)}
            renderItem={(node) => (
              <Text>
                {'  '}
                {fitDisplay(node.name, Math.max(20, width - 20))}
                {node.delay ? (
                  <Text color="green">{`${node.delay}ms`}</Text>
                ) : (
                  <Text dimColor>---</Text>
                )}
              </Text>
            )}
          />
        </Box>
      ) : null}

      <Text dimColor>{' ↑↓ 移动  u 更新  U 全部更新  c 健康检查  Enter 展开节点  r 刷新'}</Text>
    </Box>
  )
}
