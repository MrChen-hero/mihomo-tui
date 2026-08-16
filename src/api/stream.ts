/**
 * WebSocket 封装。Node 24 内置全局 WebSocket，不引入 ws 依赖。
 * 三个端点：/traffic、/memory、/logs、/connections（均实测返回 101）。
 *
 * 要点：
 *  - secret 通过 query 参数 token 传递（WebSocket 无法自定义请求头）；
 *  - 断线指数退避重连 1s → 2s → 4s，上限 30s；
 *  - 重连期间保留已有数据，由调用方决定如何展示。
 */

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface StreamHandlers<T> {
  /** 收到一帧有效 JSON */
  onMessage: (frame: T) => void
  /** 连接状态变化，用于状态栏显示「已连接 / 重连中 / 断开」 */
  onState?: (state: StreamState, detail?: string) => void
}

export interface StreamOptions {
  /** 首次重连延迟，毫秒 */
  initialDelay?: number
  /** 重连延迟上限，毫秒 */
  maxDelay?: number
}

const INITIAL_DELAY = 1000
const MAX_DELAY = 30_000

/**
 * 一条自动重连的 WebSocket 订阅。
 * 返回的 close() 是幂等的，调用后不再重连。
 */
export class Stream<T> {
  private socket: WebSocket | undefined
  private timer: NodeJS.Timeout | undefined
  private delay: number
  private closed = false
  private state: StreamState = 'connecting'

  constructor(
    private readonly url: string,
    private readonly handlers: StreamHandlers<T>,
    private readonly options: StreamOptions = {},
  ) {
    this.delay = options.initialDelay ?? INITIAL_DELAY
    this.connect()
  }

  private setState(state: StreamState, detail?: string): void {
    if (this.state === state) return
    this.state = state
    this.handlers.onState?.(state, detail)
  }

  private connect(): void {
    if (this.closed) return
    this.setState(this.delay === (this.options.initialDelay ?? INITIAL_DELAY) ? 'connecting' : 'reconnecting')

    let socket: WebSocket
    try {
      socket = new WebSocket(this.url)
    } catch (err) {
      // 非法 URL 之类的同步失败，也走退避重试，避免调用方拿到异常直接崩
      this.scheduleReconnect(err instanceof Error ? err.message : String(err))
      return
    }
    this.socket = socket

    socket.addEventListener('open', () => {
      // 连上后重置退避，下次断线仍从 1s 起
      this.delay = this.options.initialDelay ?? INITIAL_DELAY
      this.setState('open')
    })

    socket.addEventListener('message', (event: MessageEvent) => {
      const text =
        typeof event.data === 'string'
          ? event.data
          : Buffer.from(event.data as ArrayBuffer).toString('utf8')
      // 内核偶发发送空帧或非 JSON 心跳，静默丢弃，不能让流断掉
      let frame: unknown
      try {
        frame = JSON.parse(text)
      } catch {
        return
      }
      this.handlers.onMessage(frame as T)
    })

    socket.addEventListener('error', () => {
      // error 之后必然跟一个 close，重连逻辑统一放 close 里，避免重复排程
    })

    socket.addEventListener('close', (event: CloseEvent) => {
      this.socket = undefined
      if (this.closed) return
      this.scheduleReconnect(event.reason || `code ${event.code}`)
    })
  }

  private scheduleReconnect(detail: string): void {
    if (this.closed) return
    this.setState('reconnecting', detail)
    const wait = this.delay
    this.delay = Math.min(this.delay * 2, this.options.maxDelay ?? MAX_DELAY)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.connect()
    }, wait)
    // 重连定时器不应吊住进程退出
    this.timer.unref?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    // 1000 = 正常关闭。
    // 注意：mihomo v1.19.24 实测**从不回应 close 帧**，仍继续推送数据帧与 ping，
    // 因此 undici 的 close() 握手永不完成、底层 TCP 句柄不会释放，事件循环也就不会空。
    // 本类只保证「关闭后不再回调、不再重连」；进程退出必须由调用方显式执行
    // （CLI 用 exitAfterFlush，TUI 在 unmount 后同样需要显式退出）。
    this.socket?.close(1000)
    this.socket = undefined
    this.setState('closed')
  }
}

/** 定长环形缓冲，用于日志与连接历史，防止长时间运行内存膨胀 */
export class RingBuffer<T> {
  private items: T[] = []

  constructor(readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item)
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity)
    }
  }

  get size(): number {
    return this.items.length
  }

  /** 返回副本，调用方可安全持有 */
  toArray(): T[] {
    return [...this.items]
  }

  /** 取最后 n 条 */
  tail(n: number): T[] {
    return this.items.slice(Math.max(0, this.items.length - n))
  }

  clear(): void {
    this.items = []
  }
}
