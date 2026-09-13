/**
 * 标签页 1：节点。
 *
 * 只显示 AUTO 和全部机场分组（机场- 前缀，随订阅增删动态变化），
 * 每个分组显示当前真正在用的节点。
 */
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { DelayBadge, spinnerFrame } from '../components/DelayBadge.js'
import { ScrollList } from '../components/ScrollList.js'
import { fitDisplay, truncateDisplay } from '../commands/output.js'
import type { GroupRow, NodeRow, UseProxiesResult } from '../hooks/useProxies.js'

export interface ProxiesViewProps {
  proxies: UseProxiesResult
  /** 可用高度（行） */
  height: number
  width: number
  tick: number
  /** 是否拥有键盘焦点 */
  active: boolean
  onMessage: (text: string) => void
}

export function ProxiesView({
  proxies,
  height,
  width,
  tick,
  active,
  onMessage,
}: ProxiesViewProps) {
  const [groupIndex, setGroupIndex] = useState(0)
  const [nodeIndex, setNodeIndex] = useState(0)
  const [focus, setFocus] = useState<'groups' | 'nodes'>('groups')
  const [onlyAlive, setOnlyAlive] = useState(false)
  // 默认按延迟排序：可用节点浮到顶部，直接对应「保证节点可用」的诉求
  const [sortByDelay, setSortByDelay] = useState(true)

  // 只显示 AUTO 与全部机场组（机场- 前缀，动态跟随订阅增删）
  const visibleGroups = proxies.groups

  const currentGroup: GroupRow | undefined = visibleGroups[Math.min(groupIndex, visibleGroups.length - 1)]

  const allNodes = useMemo(
    () => (currentGroup ? proxies.nodesOf(currentGroup.name) : []),
    [currentGroup, proxies],
  )

  const nodes = useMemo(() => {
    // 「只看可用」把超时和未测试的滤掉，直接得到能用的节点
    let list = onlyAlive ? allNodes.filter((n) => n.delay !== undefined) : allNodes
    if (sortByDelay) {
      // 有延迟的按值升序在前，未测试的居中，超时的垫底
      const rank = (node: NodeRow) =>
        node.delay !== undefined ? 0 : node.status === 'untested' ? 1 : 2
      list = [...list].sort(
        (a, b) => rank(a) - rank(b) || (a.delay ?? 0) - (b.delay ?? 0),
      )
    }
    return list
  }, [allNodes, onlyAlive, sortByDelay])

  // 组或过滤条件变化时把光标收回顶部，避免指向不存在的行
  useEffect(() => {
    setNodeIndex(0)
  }, [currentGroup?.name, onlyAlive, sortByDelay])

  useInput(
    (input, key) => {
      if (key.leftArrow || input === 'h') {
        setFocus('groups')
        return
      }
      if (key.rightArrow || input === 'l') {
        if (nodes.length > 0) setFocus('nodes')
        return
      }
      if (key.upArrow || input === 'k') {
        if (focus === 'groups') setGroupIndex((i) => Math.max(0, i - 1))
        else setNodeIndex((i) => Math.max(0, i - 1))
        return
      }
      if (key.downArrow || input === 'j') {
        if (focus === 'groups') setGroupIndex((i) => Math.min(visibleGroups.length - 1, i + 1))
        else setNodeIndex((i) => Math.min(nodes.length - 1, i + 1))
        return
      }
      if (key.return) {
        if (focus === 'nodes' && currentGroup) {
          const node = nodes[nodeIndex]
          if (node) {
            // 对于 url-test/fallback 组，测速后会自动清除 fixed 并切回延迟最低节点
            // 为了让用户的选择生效，需要找到节点所属的区域组，然后切换 PROXY → 区域组 → 节点
            const isAutoGroup = currentGroup.type === 'URLTest' || currentGroup.type === 'Fallback'

            if (isAutoGroup) {
              // 找到节点所属的区域组并切换
              void proxies.findRegionAndSelect(node.name).then((region) => {
                if (region) {
                  onMessage(`已切换到 ${node.name}（通过 ${region} 组）`)
                } else {
                  onMessage(`已切换到 ${node.name}`)
                }
              })
            } else {
              // 普通 select 组：切换组内节点 + 将 PROXY 切换到该组
              void proxies.select(currentGroup.name, node.name).then(async () => {
                // 同时将 PROXY 组切换到当前组（如果 PROXY 组包含该组）
                const proxyGroupData = proxies.rawProxies['PROXY']
                if (proxyGroupData?.all?.includes(currentGroup.name)) {
                  await proxies.select('PROXY', currentGroup.name)
                  onMessage(`已切换 ${currentGroup.name} → ${node.name}`)
                } else {
                  onMessage(`已切换 ${currentGroup.name} → ${node.name}（PROXY 组未包含此组）`)
                }
              })
            }
          }
        } else if (nodes.length > 0) {
          setFocus('nodes')
        }
        return
      }
      if (input === 'u') {
        // 切换 PROXY 组回到 AUTO，恢复自动选路
        void proxies.select('PROXY', 'AUTO').then(() => {
          onMessage('已恢复自动选路（PROXY → AUTO）')
        })
        return
      }
      if (input === 't') {
        // 小写 t：测当前选中的单个节点
        if (focus === 'nodes') {
          const node = nodes[nodeIndex]
          if (node) void proxies.testNode(node.name)
        } else if (currentGroup) {
          void proxies.testGroup(currentGroup.name)
          onMessage(`开始测速 ${currentGroup.name}（${currentGroup.nodeCount} 个节点）`)
        }
        return
      }
      if (input === 'T' && currentGroup) {
        void proxies.testGroup(currentGroup.name)
        onMessage(`开始测速 ${currentGroup.name}（${currentGroup.nodeCount} 个节点）`)
        return
      }
      if (input === 'v') {
        setOnlyAlive((v) => !v)
        return
      }
      if (input === 's') {
        setSortByDelay((v) => !v)
        onMessage(sortByDelay ? '排序：配置顺序' : '排序：延迟升序')
        return
      }
      if (input === 'r') {
        proxies.refresh()
        onMessage('已刷新')
      }
    },
    { isActive: active },
  )

  const listHeight = Math.max(3, height - 3)
  // 窄屏降级为单栏：两个面板都占满整宽，只显示当前焦点那个
  const narrow = width < 100
  const groupWidth = narrow ? width - 2 : Math.min(30, Math.floor(width * 0.3))
  const nodeWidth = (narrow ? width : width - groupWidth) - 4

  const groupPanel = (
    <Box flexDirection="column" width={groupWidth}>
      <Text bold underline>
        代理组
      </Text>
      <ScrollList
        items={visibleGroups}
        selected={groupIndex}
        height={listHeight}
        emptyText="无可用代理组"
        renderItem={(group, index, isSelected) => (
          <Text
            color={isSelected && focus === 'groups' ? 'black' : undefined}
            backgroundColor={isSelected && focus === 'groups' ? 'cyan' : undefined}
            bold={isSelected}
          >
            {`${isSelected ? '>' : ' '} ${fitDisplay(group.name, Math.max(8, groupWidth - 12))}`}
            <Text dimColor={!isSelected}>{` ${group.aliveCount}/${group.nodeCount}`}</Text>
          </Text>
        )}
      />
    </Box>
  )

  const nodePanel = (
    <Box flexDirection="column" flexGrow={1} paddingLeft={narrow ? 0 : 2}>
      <Text bold underline>
        {`节点：${currentGroup ? truncateDisplay(currentGroup.name, 24) : '—'}`}
        {onlyAlive ? <Text color="green"> [只看可用]</Text> : null}
        {sortByDelay ? <Text dimColor> [按延迟]</Text> : null}
        {currentGroup?.fixed ? <Text color="yellow"> [已钉选]</Text> : null}
        {currentGroup ? (
          <Text dimColor>{` ${currentGroup.aliveCount}/${currentGroup.nodeCount} 可用`}</Text>
        ) : null}
        {proxies.testingGroup === currentGroup?.name && proxies.progress ? (
          <Text color="cyan">
            {` ${spinnerFrame(tick)} 测速 ${proxies.progress.done}/${proxies.progress.total}`}
          </Text>
        ) : null}
      </Text>
      <ScrollList
        items={nodes}
        selected={nodeIndex}
        height={listHeight}
        emptyText={currentGroup ? '该组无节点' : '请先选择代理组'}
        renderItem={(node: NodeRow, index, isSelected) => (
          <Text
            color={isSelected && focus === 'nodes' ? 'black' : undefined}
            backgroundColor={isSelected && focus === 'nodes' ? 'cyan' : undefined}
          >
            {`${isSelected ? '>' : ' '}${node.current ? '*' : ' '}`}
            {fitDisplay(node.name, nodeWidth - 12)}
            <DelayBadge status={node.status} delay={node.delay} testing={node.testing} />
          </Text>
        )}
      />
    </Box>
  )

  return (
    <Box flexDirection="column" flexGrow={1}>
      {narrow ? (
        // 窄终端降级为单栏：只显示当前焦点面板，不做横向截断
        focus === 'groups' ? groupPanel : nodePanel
      ) : (
        <Box flexDirection="row" flexGrow={1}>
          {groupPanel}
          {nodePanel}
        </Box>
      )}
      <Text dimColor>
        {' ↑↓ 移动  ←→ 切栏  Enter 选用  u 解除钉选  t 测速  s 排序  v 只看可用  r 刷新'}
      </Text>
    </Box>
  )
}
