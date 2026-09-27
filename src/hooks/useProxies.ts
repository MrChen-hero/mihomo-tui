/**
 * 代理组与节点数据。
 *
 * 关键取舍（按用户要求「不用管聚合组，保证节点可用就行」）：
 * 组分两类 —— 成员是真实节点的「节点组」，和成员全是其他组的「聚合组」。
 * TUI 默认只展示节点组，因为只有它们能回答「哪个节点能用」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiBusinessError, HttpStatusError, MihomoClient } from '../api/client.js'
import { classify, classifyDelayValue, type NodeStatus } from '../api/status.js'
import type { ProxyItem } from '../api/types.js'
import type { AppConfig } from '../config.js'
import { AIRPORT_GROUP_PREFIX } from '../config/skeleton.js'

export interface NodeRow {
  name: string
  type: string
  provider: string
  status: NodeStatus
  delay: number | undefined
  current: boolean
  /** 正在单独测速 */
  testing: boolean
}

export interface GroupRow {
  name: string
  type: string
  now: string
  fixed: string
  size: number
  /** 组内真实节点数（排除成员是组的情况） */
  nodeCount: number
  aliveCount: number
}

export interface UseProxiesResult {
  groups: GroupRow[]
  nodesOf: (group: string) => NodeRow[]
  loading: boolean
  error: string | undefined
  refresh: () => void
  select: (group: string, name: string) => Promise<void>
  /** 解除 url-test/fallback 组的钉选 */
  unfix: (group: string) => Promise<void>
  testGroup: (group: string) => Promise<void>
  testNode: (name: string) => Promise<string | undefined>
  testingGroup: string | undefined
  /** 整组测速进度：已回填数量 / 总数 */
  progress: { done: number; total: number } | undefined
  /** 全局当前使用的真实节点名（PROXY → AUTO → 具体节点） */
  currentNode: string
  /** 找到节点所属的区域组并切换 PROXY → 区域组 → 节点 */
  findRegionAndSelect: (nodeName: string) => Promise<string | null>
  /** 原始代理数据（用于访问 all 等字段） */
  rawProxies: Record<string, ProxyItem>
}

/**
 * 内核内置的特殊出口。它们不是真实节点：
 * 判断「这个组里有没有可选的真实节点」时必须排除，
 * 否则像 AI 这种成员全是组 + 一个 DIRECT 的聚合组会被误判为节点组。
 */
const BUILTIN_OUTBOUNDS = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'])

/**
 * [1] 节点页可见的组：AUTO、全部机场组，以及用户建的代理链（relay）。
 * 机场组由 skeleton 按「机场-<订阅名>」生成，按前缀动态识别 ——
 * 新增/删除订阅后内核里的组列表变化，这里无需改动即自动同步
 * （不能回到写死订阅名的白名单，那样新订阅的组永远进不了 [1]）。
 * relay 组按类型识别：它的成员是跳而非节点，但仍需要在节点页里编辑。
 */
export function isPrimaryGroupName(name: string, type?: string): boolean {
  return name === 'AUTO' || name.startsWith(AIRPORT_GROUP_PREFIX) || type === 'Relay'
}

export function useProxies(config: AppConfig, refreshMs = 5000): UseProxiesResult {
  const client = useMemo(() => new MihomoClient(config), [config])
  const [proxies, setProxies] = useState<Record<string, ProxyItem>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const [testing, setTesting] = useState<Set<string>>(new Set())
  // 组测速结果的本地回填：节点在订阅更新后改名等场景下 /proxies 合并视图
  // 里已无此名（历史无从读取），组端点的结果在这里兜底显示
  const [delayOverlay, setDelayOverlay] = useState<Record<string, number>>({})
  const [testingGroup, setTestingGroup] = useState<string | undefined>()
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>()
  const mounted = useRef(true)

  const load = useCallback(async () => {
    try {
      // 合并视图：mihomo v1.19.28 起上游有意不再把 provider 节点放进 /proxies
      // （85c1798f），合并后节点的 type / 延迟历史 / provider-name 才是完整的
      const data = await client.proxiesWithProviderNodes()
      if (!mounted.current) return
      setProxies(data)
      setError(undefined)
    } catch (err) {
      if (!mounted.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [client])

  useEffect(() => {
    mounted.current = true
    void load()
    const timer = setInterval(() => void load(), refreshMs)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [load, refreshMs])

  const isGroup = useCallback(
    (name: string) => Array.isArray(proxies[name]?.all),
    [proxies],
  )

  // 递归解析真实节点：PROXY → AUTO → 具体节点
  const resolveRealNode = useCallback(
    (name: string, visited = new Set<string>()): string => {
      if (visited.has(name)) return name // 防循环
      visited.add(name)
      const item = proxies[name]
      if (!item) return name
      // 如果是组且有 now，继续递归
      if (Array.isArray(item.all) && item.now) {
        return resolveRealNode(item.now, visited)
      }
      return name
    },
    [proxies],
  )

  const groups = useMemo(() => {
    // 只显示 AUTO 与全部机场组（机场-<订阅名>，随订阅增删动态变化）
    const rows: GroupRow[] = []
    for (const item of Object.values(proxies)) {
      if (!Array.isArray(item.all)) continue
      if (!isPrimaryGroupName(item.name, item.type)) continue
      const members = item.all
      // 真实节点 = 既不是组、也不是 DIRECT/REJECT 这类内置出口
      const realNodes = members.filter(
        (name) => !isGroup(name) && !BUILTIN_OUTBOUNDS.has(name),
      )
      const alive = realNodes.filter((name) => {
        const node = proxies[name]
        // 节点缺席 /proxies 表时以 overlay 的组测速结果兜底
        if (!node) return delayOverlay[name] !== undefined
        return node.alive && node.history.length > 0
      }).length
      rows.push({
        name: item.name,
        type: item.type,
        now: item.now ?? '',
        fixed: item.fixed ?? '',
        size: members.length,
        nodeCount: realNodes.length,
        aliveCount: alive,
      })
    }
    // AUTO 排第一，其他按名称排序
    return rows.sort((a, b) => {
      if (a.name === 'AUTO') return -1
      if (b.name === 'AUTO') return 1
      return a.name.localeCompare(b.name)
    })
  }, [proxies, isGroup])

  const nodesOf = useCallback(
    (group: string): NodeRow[] => {
      const target = proxies[group]
      if (!target?.all) return []
      const testUrl = target.testUrl || config.testUrl

      // 找到全局真正在用的节点：从 PROXY 组开始递归
      const proxyGroup = proxies['PROXY']
      const globalCurrent = proxyGroup?.now ? resolveRealNode(proxyGroup.now) : ''

      // 当前组自己选的节点
      const localCurrent = resolveRealNode(target.now ?? '')

      return target.all.map((name) => {
        const node = proxies[name]
        if (!node) {
          // 节点缺席合并视图（订阅更新后改名等）：组端点测速的
          // 结果经 overlay 兜底，避免永远显示 ---
          const overlayDelay = delayOverlay[name]
          const result = classifyDelayValue(overlayDelay, config.delayThresholds)
          return {
            name,
            type: '?',
            provider: '',
            status: result.status,
            delay: result.delay,
            current: name === localCurrent || name === globalCurrent,
            testing: testing.has(name),
          }
        }
        const result = classify(node, config.delayThresholds, testUrl)
        return {
          name,
          type: node.type,
          provider: node['provider-name'] ?? '',
          status: result.status,
          delay: result.delay,
          current: name === localCurrent || name === globalCurrent,
          testing: testing.has(name),
        }
      })
    },
    [proxies, config.testUrl, config.delayThresholds, testing, delayOverlay, resolveRealNode],
  )

  const select = useCallback(
    async (group: string, name: string) => {
      try {
        await client.selectProxy(group, name)
        await load()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [client, load],
  )

  /**
   * 解除钉选。对 url-test/fallback 组，select 写的是 fixed 字段（SPEC 3.5），
   * 需要 DELETE 才能恢复按测速自动选路。
   */
  const unfix = useCallback(
    async (group: string) => {
      try {
        await client.unfixProxy(group)
        await load()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [client, load],
  )

  /**
   * 整组测速。内核的 /group/{name}/delay 是一次性返回，
   * 为了让界面有逐节点进度，这里改为并发逐节点测 —— 每个结果立刻回填。
   */
  const testGroup = useCallback(
    async (group: string) => {
      const target = proxies[group]
      if (!target?.all) return
      const nodes = target.all.filter(
        (name) => !isGroup(name) && !BUILTIN_OUTBOUNDS.has(name),
      )
      if (nodes.length === 0) return

      setTestingGroup(group)
      setTesting(new Set(nodes))

      try {
        // 单次调用组端点：内核并发测全组并返回 {节点名: 延迟}。
        // 相比逐节点并发：请求数从 N 降到 1，且不依赖节点名可被单独寻址
        // （v1.19.28+ 主表 404 时这条路径仍通）
        const results = await client.testGroupDelay(group)
        if (!mounted.current) return
        setDelayOverlay((prev) => ({ ...prev, ...results }))
      } catch {
        // 业务错误 = 组内节点整体不可用，属正常结果，不当成程序错误
      } finally {
        if (mounted.current) {
          setTestingGroup(undefined)
          setTesting(new Set())
          void load()
        }
      }
    },
    [proxies, isGroup, client],
  )

  const testNode = useCallback(
    async (name: string): Promise<string | undefined> => {
      setTesting((prev) => new Set(prev).add(name))
      try {
        // provider 节点统一走 provider 维度端点：v1.19.28+ 主表对 provider
        // 节点一律 404；旧内核两端点等价，因此无需按内核版本分支
        const provider = proxies[name]?.['provider-name']
        if (provider) {
          await client.testProviderNodeDelay(provider, name)
          return undefined
        }
        await client.testProxyDelay(name)
        return undefined
      } catch (err) {
        // 404 = 节点名未注册进内核查询表：可能是订阅更新后节点名变化——
        // 回退到组端点测速（其结果经 overlay 兜底显示），并给用户明确提示
        if (err instanceof HttpStatusError && err.status === 404) {
          const containingGroup = Object.entries(proxies).find(
            ([, p]) => Array.isArray(p.all) && (p.all as string[]).includes(name),
          )?.[0]
          if (containingGroup) {
            try {
              const results = await client.testGroupDelay(containingGroup)
              if (!mounted.current) return undefined
              setDelayOverlay((prev) => ({ ...prev, ...results }))
              return '该节点未注册（订阅更新后节点名变化或内核版本兼容性），已改用组测速'
            } catch {
              return '节点已失效（订阅更新后节点名可能变化），按 r 刷新后重试'
            }
          }
          return '节点已失效（订阅更新后节点名可能变化），按 r 刷新后重试'
        }
        // 其余延迟测试失败属于「节点不可用」，是正常结果，不当成程序错误
        if (!(err instanceof ApiBusinessError)) {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          return message
        }
        return undefined
      } finally {
        if (mounted.current) {
          setTesting((prev) => {
            const next = new Set(prev)
            next.delete(name)
            return next
          })
          await load()
        }
      }
    },
    [proxies, client, load],
  )

  // 计算全局当前节点：PROXY → AUTO → 具体节点
  const currentNode = useMemo(() => {
    const proxyGroup = proxies['PROXY']
    if (!proxyGroup?.now) return ''
    return resolveRealNode(proxyGroup.now)
  }, [proxies, resolveRealNode])

  /**
   * 找到节点所属的区域组并切换 PROXY → 区域组 → 节点。
   * 这样可以绕过 url-test/fallback 组的自动选路，让用户的选择生效。
   */
  const findRegionAndSelect = useCallback(
    async (nodeName: string): Promise<string | null> => {
      try {
        // 区域组列表（从 PROXY 组的成员中获取）
        const proxyGroup = proxies['PROXY']
        if (!proxyGroup?.all) return null

        const regionNames = proxyGroup.all.filter(
          (name) => !['AUTO', 'FALLBACK', 'DIRECT'].includes(name) && name.startsWith('机场-') === false
        )

        // 查询每个区域组，找到包含该节点的组
        for (const regionName of regionNames) {
          const region = await client.proxy(regionName).catch(() => null)
          if (region?.all?.includes(nodeName)) {
            // 找到了！先切换区域组到该节点，再切换 PROXY 到该区域组
            await client.selectProxy(regionName, nodeName)
            await client.selectProxy('PROXY', regionName)
            await load()
            return regionName
          }
        }

        // 没找到区域组，尝试直接切换（机场组的情况）
        await client.selectProxy('PROXY', nodeName).catch(() => {})
        await load()
        return null
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return null
      }
    },
    [proxies, client, load],
  )

  return {
    groups,
    nodesOf,
    loading,
    error,
    refresh: () => void load(),
    select,
    unfix,
    testGroup,
    testNode,
    testingGroup,
    progress,
    currentNode,
    findRegionAndSelect,
    rawProxies: proxies,
  }
}
