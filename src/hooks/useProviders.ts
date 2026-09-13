/** provider（订阅）数据与操作 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MihomoClient } from '../api/client.js'
import type { ProviderItem } from '../api/types.js'
import type { AppConfig } from '../config.js'

export interface ProviderRow {
  name: string
  type: string
  nodes: number
  alive: number
  /** 剩余流量字节数；undefined 表示机场未下发 */
  remaining: number | undefined
  /** 已用/总量；undefined 表示机场未下发总量（无法算使用率） */
  usage: { used: number; total: number } | undefined
  /** 到期时间戳（毫秒）；undefined 表示长期有效或未下发 */
  expire: number | undefined
  updatedAt: string | undefined
  /** 正在更新 */
  updating: boolean
  /** 上次操作的错误文本（订阅域名失效是常态，必须可见） */
  error: string | undefined
}

export interface UseProvidersResult {
  providers: ProviderRow[]
  loading: boolean
  error: string | undefined
  refresh: () => void
  update: (name: string) => Promise<void>
  updateAll: () => Promise<void>
  check: (name: string) => Promise<void>
  nodesOf: (name: string) => { name: string; alive: boolean; delay: number | undefined }[]
}

/** /providers/proxies 会把代理组也列为 Compatible 伪 provider，需剔除 */
function isRealProvider(provider: ProviderItem): boolean {
  return provider.vehicleType === 'HTTP' || provider.vehicleType === 'File'
}

export function useProviders(config: AppConfig, refreshMs = 8000): UseProvidersResult {
  const client = useMemo(() => new MihomoClient(config), [config])
  const [raw, setRaw] = useState<Record<string, ProviderItem>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const [updating, setUpdating] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const mounted = useRef(true)

  const load = useCallback(async () => {
    try {
      const data = await client.providers()
      if (!mounted.current) return
      setRaw(data)
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

  const providers = useMemo(() => {
    const rows: ProviderRow[] = []
    for (const [name, provider] of Object.entries(raw)) {
      if (!isRealProvider(provider)) continue
      const info = provider.subscriptionInfo
      const used = info ? (info.Upload ?? 0) + (info.Download ?? 0) : 0
      rows.push({
        usage: info?.Total ? { used, total: info.Total } : undefined,
        name,
        type: provider.vehicleType,
        nodes: provider.proxies.length,
        alive: provider.proxies.filter((p) => p.alive && p.history.length > 0).length,
        remaining: info?.Total ? Math.max(0, info.Total - used) : undefined,
        // Expire 为 0 表示机场未下发到期时间（三家实测均为 0）
        expire: info?.Expire ? info.Expire * 1000 : undefined,
        updatedAt: provider.updatedAt,
        updating: updating.has(name),
        error: errors[name],
      })
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name))
  }, [raw, updating, errors])

  const update = useCallback(
    async (name: string) => {
      setUpdating((prev) => new Set(prev).add(name))
      setErrors((prev) => {
        const next = { ...prev }
        delete next[name]
        return next
      })
      try {
        await client.updateProvider(name)
      } catch (err) {
        // 订阅拉取失败是常态（域名失效、经代理被 403），完整错误必须展示
        setErrors((prev) => ({
          ...prev,
          [name]: err instanceof Error ? err.message : String(err),
        }))
      } finally {
        if (mounted.current) {
          setUpdating((prev) => {
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

  const updateAll = useCallback(async () => {
    const names = providers.map((p) => p.name)
    // 顺序执行，让进度可读，也避免同时拉三份订阅互相干扰
    for (const name of names) await update(name)
  }, [providers, update])

  const check = useCallback(
    async (name: string) => {
      setUpdating((prev) => new Set(prev).add(name))
      try {
        await client.healthCheckProvider(name)
      } catch (err) {
        setErrors((prev) => ({
          ...prev,
          [name]: err instanceof Error ? err.message : String(err),
        }))
      } finally {
        if (mounted.current) {
          setUpdating((prev) => {
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

  const nodesOf = useCallback(
    (name: string) =>
      (raw[name]?.proxies ?? []).map((proxy) => ({
        name: proxy.name,
        alive: proxy.alive,
        delay: proxy.history.at(-1)?.delay,
      })),
    [raw],
  )

  return {
    providers,
    loading,
    error,
    refresh: () => void load(),
    update,
    updateAll,
    check,
    nodesOf,
  }
}
