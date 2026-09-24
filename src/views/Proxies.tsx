/**
 * 标签页 1：节点。
 *
 * 只显示 AUTO 和全部机场分组（机场- 前缀，随订阅增删动态变化），
 * 每个分组显示当前真正在用的节点。
 *
 * 布局（spec 4.4）：双栏各套内嵌标题 Panel；行标记分离——
 *   ▌ accent 指示条 = 键盘焦点行（替代整行反色，CJK 行不再闪白）
 *   ❯ muted = 光标停在另一栏时的驻留位置
 *   ● 业务选中 = 当前在用节点 / 被 PROXY 选中的组，可与 ▌ 同时出现
 */
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { DelayBadge, spinnerFrame } from '../components/DelayBadge.js'
import { ScrollList } from '../components/ScrollList.js'
import { loadSubscriptions } from '../config/subscriptions.js'
import type { Subscription } from '../config/types.js'
import { FooterLine, type FooterHint } from '../ui/FooterLine.js'
import { Panel } from '../ui/Panel.js'
import { colors, styles } from '../ui/theme.js'
import { fitDisplay, truncateDisplay } from '../commands/output.js'
import type { NodeRow, UseProxiesResult } from '../hooks/useProxies.js'
import { buildGroupDisplay, type DisplayRow } from './groupDisplay.js'

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

/** 行首指示条（纯函数）：▌=焦点行、❯=驻留光标、空格=普通行 */
export function rowBar(isCursor: boolean, paneFocused: boolean): string {
  if (!isCursor) return ' '
  return paneFocused ? '▌' : '❯'
}

/** 指示条颜色（纯函数）：焦点行 accent、驻留光标 muted */
export function rowBarColor(isCursor: boolean, paneFocused: boolean): string | undefined {
  if (!isCursor) return undefined
  return paneFocused ? colors.accent : colors.muted
}

/** 右栏标题（纯函数）：`节点 · AUTO [按延迟] 190/228 可用`，测速时附进度 */
export function nodePanelTitle(opts: {
  groupName: string | undefined
  onlyAlive: boolean
  sortByDelay: boolean
  fixed: boolean
  aliveCount: number
  nodeCount: number
  testing: { done: number; total: number } | undefined
  tick: number
}): string {
  const parts = [
    `节点 · ${opts.groupName ? truncateDisplay(opts.groupName, 24) : '—'}`,
    opts.onlyAlive ? ' [只看可用]' : '',
    opts.sortByDelay ? ' [按延迟]' : '',
    opts.fixed ? ' [已钉选]' : '',
    opts.groupName ? ` ${opts.aliveCount}/${opts.nodeCount} 可用` : '',
  ]
  if (opts.testing) {
    parts.push(` ${spinnerFrame(opts.tick)} 测速 ${opts.testing.done}/${opts.testing.total}`)
  }
  return parts.join('')
}

const HINTS: FooterHint[] = [
  { key: '↑↓', label: '移动' },
  { key: '←→', label: '切栏' },
  { key: 'Enter', label: '选用' },
  { key: 'u', label: '解除钉选' },
  { key: 't', label: '测速' },
  { key: 's', label: '排序' },
  { key: 'v', label: '只看可用' },
  { key: 'r', label: '刷新' },
]

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
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])

  // 订阅清单决定左侧分组归拢；读取失败时退化为全部未分组
  useEffect(() => {
    try {
      setSubscriptions(loadSubscriptions())
    } catch {
      setSubscriptions([])
    }
  }, [proxies.groups])

  // 左侧按订阅分组归拢：组头行 + `分组名 - 订阅名`。只改显示，
  // currentGroup 仍取真实代理组，选中与切换逻辑不变。
  const displayRows = useMemo(
    () => buildGroupDisplay(proxies.groups, subscriptions),
    [proxies.groups, subscriptions],
  )
  const selectableRows = displayRows.filter((row) => !row.header)

  const currentRow: DisplayRow | undefined =
    selectableRows[Math.min(groupIndex, selectableRows.length - 1)]
  const currentGroup = currentRow?.group

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
        if (focus === 'groups') setGroupIndex((i) => Math.min(selectableRows.length - 1, i + 1))
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

  // 高度预算：Panel 顶线 1 + 列表溢出计数 1 + 底边 1 + 页脚 1
  const listHeight = Math.max(3, height - 4)
  // 窄屏降级为单栏：只显示当前焦点那个面板
  const narrow = width < 100
  const groupPanelWidth = narrow ? width : Math.min(32, Math.floor(width * 0.3))
  // 右栏宽度 = 总宽度 - 左栏宽度，确保双栏总宽与 TopBar 对齐
  const nodePanelWidth = narrow ? width : width - groupPanelWidth
  // 内容宽 = 面板宽 - 左右边框 2 - paddingX 2；组行额外让位给计数列。
  // 额外留 2 列 emoji 余量：国旗 emoji 的显示宽随终端在 2~4 列间浮动
  // （本项目的 displayWidth 按 2 计），行内容一旦顶到边框就会折行撑爆面板。
  const groupNameBudget = Math.max(8, groupPanelWidth - 16)
  const nodeNameBudget = Math.max(8, nodePanelWidth - 16)

  const rawTitle = nodePanelTitle({
    groupName: currentGroup?.name,
    onlyAlive,
    sortByDelay,
    fixed: (currentGroup?.fixed ?? '') !== '',
    aliveCount: currentGroup?.aliveCount ?? 0,
    nodeCount: currentGroup?.nodeCount ?? 0,
    testing:
      proxies.testingGroup === currentGroup?.name ? proxies.progress : undefined,
    tick,
  })
  // Panel 按自家预算截标题（width-7）；这里再收紧 2 列 emoji 余量，
  // 保证标题里即便有宽理解分歧的 emoji 也不会把顶线挤折行。
  const title = truncateDisplay(rawTitle, Math.max(1, nodePanelWidth - 9))

  const groupTitle = `代理组 · ${selectableRows.length}`
  const groupPanel = (
    <Panel title={groupTitle} width={groupPanelWidth} fillHeight>
      <ScrollList
        items={displayRows}
        selected={displayRows.findIndex((row) => row.key === currentRow?.key)}
        height={listHeight}
        emptyText="无可用代理组"
        renderItem={(row, _index, isSelected) =>
          row.header ? (
            <Text dimColor>{` ─ ${fitDisplay(row.label, groupNameBudget)}`}</Text>
          ) : (
            <Text>
              <Text color={rowBarColor(isSelected, focus === 'groups')}>
                {rowBar(isSelected, focus === 'groups')}
              </Text>
              {proxies.rawProxies['PROXY']?.now === row.group?.name ? (
                <Text {...styles.rowSelected}>●</Text>
              ) : (
                ' '
              )}
              {` ${fitDisplay(row.label, groupNameBudget)}`}
              <Text dimColor>{` ${row.group?.aliveCount ?? 0}/${row.group?.nodeCount ?? 0}`}</Text>
            </Text>
          )
        }
      />
    </Panel>
  )

  const nodePanel = (
    <Panel title={title} width={nodePanelWidth} fillHeight>
      <ScrollList
        items={nodes}
        selected={nodeIndex}
        height={listHeight}
        emptyText={currentGroup ? '该组无节点' : '请先选择代理组'}
        renderItem={(node: NodeRow, index, isSelected) => (
          <Text>
            <Text color={rowBarColor(isSelected, focus === 'nodes')}>
              {rowBar(isSelected, focus === 'nodes')}
            </Text>
            {node.current ? <Text {...styles.rowSelected}>●</Text> : ' '}
            {` ${fitDisplay(node.name, nodeNameBudget)}`}
            <DelayBadge status={node.status} delay={node.delay} testing={node.testing} />
          </Text>
        )}
      />
    </Panel>
  )

  return (
    <Box flexDirection="column" flexGrow={1}>
      {narrow ? (
        // 窄终端降级为单栏：只显示当前焦点面板，不做横向截断。
        // row 容器让纵轴变交叉轴（默认 stretch）拉伸 Panel 外层盒，
        // 内层 flexGrow 才有空间可分——直接挂在 column 下是空操作
        <Box flexDirection="row" flexGrow={1}>
          {focus === 'groups' ? groupPanel : nodePanel}
        </Box>
      ) : (
        <Box flexDirection="row" flexGrow={1}>
          {groupPanel}
          {nodePanel}
        </Box>
      )}
      <Box paddingLeft={1}>
        <FooterLine hints={HINTS} width={width - 2} />
      </Box>
    </Box>
  )
}
