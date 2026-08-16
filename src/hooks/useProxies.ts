/**
 * 代理组与节点数据。
 *
 * 关键取舍（按用户要求「不用管聚合组，保证节点可用就行」）：
 * 组分两类 —— 成员是真实节点的「节点组」，和成员全是其他组的「聚合组」。
 * TUI 默认只展示节点组，因为只有它们能回答「哪个节点能用」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiBusinessError, MihomoClient } from '../api/client.js'
import { classify, type NodeStatus } from '../api/status.js'
import type { ProxyItem } from '../api/types.js'
import type { AppConfig } from '../config.js'

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
  testNode: (name: string) => Promise<void>
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

export function useProxies(config: AppConfig, refreshMs = 5000): UseProxiesResult {
  const client = useMemo(() => new MihomoClient(config), [config])
  const [proxies, setProxies] = useState<Record<string, ProxyItem>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const [testing, setTesting] = useState<Set<string>>(new Set())
  const [testingGroup, setTestingGroup] = useState<string | undefined>()
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>()
  const mounted = useRef(true)

  const load = useCallback(async () => {
    try {
      const data = await client.proxies()
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
    // 只显示 AUTO 和三个机场分组
    const ALLOWED = new Set(['AUTO', '机场-jkun', '机场-liangxin', '机场-yuetoto'])
    const rows: GroupRow[] = []
    for (const item of Object.values(proxies)) {
      if (!Array.isArray(item.all)) continue
      if (!ALLOWED.has(item.name)) continue
      const members = item.all
      // 真实节点 = 既不是组、也不是 DIRECT/REJECT 这类内置出口
      const realNodes = members.filter(
        (name) => !isGroup(name) && !BUILTIN_OUTBOUNDS.has(name),
      )
      const alive = realNodes.filter((name) => {
        const node = proxies[name]
        return node && node.alive && node.history.length > 0
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
          return {
            name,
            type: '?',
            provider: '',
            status: 'untested' as NodeStatus,
            delay: undefined,
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
    [proxies, config.testUrl, config.delayThresholds, testing, resolveRealNode],
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
      setProgress({ done: 0, total: nodes.length })
      setTesting(new Set(nodes))

      let done = 0
      // 限制并发，避免几百个节点同时测速把内核压垮
      const CONCURRENCY = 8
      const queue = [...nodes]
      const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0) {
          const name = queue.shift()
          if (!name) break
          try {
            await client.testProxyDelay(name)
          } catch {
            // 业务错误 = 节点不可用，是正常结果，不打断整组测速
          }
          done += 1
          if (!mounted.current) return
          setProgress({ done, total: nodes.length })
          setTesting((prev) => {
            const next = new Set(prev)
            next.delete(name)
            return next
          })
          // 每个节点测完就刷新，实现结果流式回填
          void load()
        }
      })
      await Promise.all(workers)
      if (!mounted.current) return
      setTestingGroup(undefined)
      setProgress(undefined)
      setTesting(new Set())
      await load()
    },
    [proxies, isGroup, client, load],
  )

  const testNode = useCallback(
    async (name: string) => {
      setTesting((prev) => new Set(prev).add(name))
      try {
        await client.testProxyDelay(name)
      } catch (err) {
        // 延迟测试失败属于「节点不可用」，不当作程序错误上报
        if (!(err instanceof ApiBusinessError)) {
          setError(err instanceof Error ? err.message : String(err))
        }
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
    [client, load],
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
