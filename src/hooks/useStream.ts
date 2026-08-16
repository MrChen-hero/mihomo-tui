/** WebSocket 流的 React 封装：流量、内存、日志、连接。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { MihomoClient } from '../api/client.js'
import { RingBuffer, Stream, type StreamState } from '../api/stream.js'
import type {
  ConnectionsResponse,
  LogFrame,
  LogLevel,
  MemoryFrame,
  TrafficFrame,
} from '../api/types.js'
import type { AppConfig } from '../config.js'

export interface StatusData {
  up: number
  down: number
  upTotal: number
  downTotal: number
  memory: number
  state: StreamState
}

/** 状态栏数据：/traffic 与 /memory 两条流 */
export function useStatusStream(config: AppConfig): StatusData {
  const client = useMemo(() => new MihomoClient(config), [config])
  const [data, setData] = useState<StatusData>({
    up: 0,
    down: 0,
    upTotal: 0,
    downTotal: 0,
    memory: 0,
    state: 'connecting',
  })

  useEffect(() => {
    const traffic = new Stream<TrafficFrame>(client.wsUrl('/traffic'), {
      onMessage: (frame) =>
        setData((prev) => ({
          ...prev,
          up: frame.up ?? 0,
          down: frame.down ?? 0,
          upTotal: frame.upTotal ?? prev.upTotal,
          downTotal: frame.downTotal ?? prev.downTotal,
        })),
      onState: (state) => setData((prev) => ({ ...prev, state })),
    })
    const memory = new Stream<MemoryFrame>(client.wsUrl('/memory'), {
      onMessage: (frame) =>
        setData((prev) => ({ ...prev, memory: frame.inuse || prev.memory })),
    })
    return () => {
      traffic.close()
      memory.close()
    }
  }, [client])

  return data
}

export interface LogEntry {
  id: number
  type: string
  payload: string
}

export interface UseLogStreamResult {
  entries: LogEntry[]
  state: StreamState
  paused: boolean
  setPaused: (paused: boolean) => void
  clear: () => void
  /** 缓冲区实际持有的行数，用于验证环形缓冲生效 */
  bufferSize: number
  /** 已丢弃的行数（超出缓冲上限的部分） */
  dropped: number
}

const LOG_CAPACITY = 1000
/**
 * 渲染节流间隔。debug 级别下日志可达每秒数百帧，
 * 若每帧都 setState 就会每帧复制一个 1000 元素数组并让 React 全量 reconcile ——
 * 实测这样跑 10 分钟 RSS 会从 250MB 涨到 2.1GB（不是句柄泄漏，是高频垃圾压垮 GC）。
 * 10fps 对人眼足够，且把复制次数降到与日志速率无关。
 */
const RENDER_INTERVAL_MS = 100

/** 日志流。环形缓冲上限 1000 行（SPEC 5.3），渲染按固定帧率节流。 */
export function useLogStream(
  config: AppConfig,
  level: LogLevel,
  /** 日志页是否可见。不可见时仍收流入缓冲，但不触发渲染 */
  visible = true,
): UseLogStreamResult {
  const client = useMemo(() => new MihomoClient(config), [config])
  const buffer = useRef(new RingBuffer<LogEntry>(LOG_CAPACITY))
  const nextId = useRef(0)
  const dropped = useRef(0)
  /** 自上次渲染以来是否有新数据，避免无变化时空转重渲染 */
  const dirty = useRef(false)
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [state, setState] = useState<StreamState>('connecting')
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  pausedRef.current = paused

  useEffect(() => {
    // 切换级别要重开流；旧数据保留，避免屏幕闪空
    const stream = new Stream<LogFrame>(client.logsUrl(level), {
      onMessage: (frame) => {
        if (typeof frame?.payload !== 'string') return
        if (buffer.current.size >= LOG_CAPACITY) dropped.current += 1
        buffer.current.push({ id: nextId.current++, type: frame.type, payload: frame.payload })
        // 只置脏标记，真正的 setState 交给下面的定时器
        dirty.current = true
      },
      onState: setState,
    })
    return () => stream.close()
  }, [client, level])

  useEffect(() => {
    // 日志页不可见时完全不渲染 —— 否则在节点页也会被日志速率带着每秒重渲染 10 次
    if (!visible) return
    const timer = setInterval(() => {
      // 暂停时继续收进缓冲但不触发渲染，恢复后能看到这段日志
      if (!dirty.current || pausedRef.current) return
      dirty.current = false
      setEntries(buffer.current.toArray())
    }, RENDER_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [visible])

  // 切回日志页或从暂停恢复时，把缓冲里积压的内容刷出来
  useEffect(() => {
    if (visible && !paused) setEntries(buffer.current.toArray())
  }, [visible, paused])

  return {
    entries,
    state,
    paused,
    setPaused,
    clear: () => {
      buffer.current.clear()
      dropped.current = 0
      dirty.current = false
      setEntries([])
    },
    bufferSize: buffer.current.size,
    dropped: dropped.current,
  }
}

/** 连接流。内核每秒推送全量快照，直接替换即可。 */
export function useConnectionsStream(
  config: AppConfig,
  /** 连接页是否可见。不可见时不订阅 —— 全量快照每秒一帧，白收白渲染 */
  visible = true,
): {
  data: ConnectionsResponse | undefined
  state: StreamState
} {
  const client = useMemo(() => new MihomoClient(config), [config])
  const [data, setData] = useState<ConnectionsResponse | undefined>()
  const [state, setState] = useState<StreamState>('connecting')

  useEffect(() => {
    if (!visible) return
    const stream = new Stream<ConnectionsResponse>(client.wsUrl('/connections'), {
      onMessage: setData,
      onState: setState,
    })
    return () => stream.close()
  }, [client, visible])

  return { data, state }
}
