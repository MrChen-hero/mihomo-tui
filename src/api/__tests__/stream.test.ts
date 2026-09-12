/**
 * Stream 状态机测试：用 FakeWebSocket 替换 globalThis.WebSocket，
 * 配合 fake timers 驱动退避重连 —— 全程无真实网络。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RingBuffer, Stream } from '../stream.js'
import type { StreamState } from '../stream.js'

type Listener = (event: Record<string, unknown>) => void

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static reset(): void {
    FakeWebSocket.instances = []
  }

  private listeners = new Map<string, Listener[]>()
  closeCodes: number[] = []

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  emit(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }

  close(code = 1000): void {
    this.closeCodes.push(code)
  }
}

describe('RingBuffer 环形缓冲', () => {
  it('容量内逐条保留', () => {
    const buffer = new RingBuffer<number>(3)
    buffer.push(1)
    buffer.push(2)
    expect(buffer.size).toBe(2)
    expect(buffer.toArray()).toEqual([1, 2])
  })

  it('溢出时丢弃最旧的', () => {
    const buffer = new RingBuffer<number>(3)
    for (const n of [1, 2, 3, 4, 5]) buffer.push(n)
    expect(buffer.size).toBe(3)
    expect(buffer.toArray()).toEqual([3, 4, 5])
  })

  it('toArray 返回副本，外部修改不影响内部', () => {
    const buffer = new RingBuffer<number>(2)
    buffer.push(1)
    const copy = buffer.toArray()
    copy.push(99)
    copy[0] = 42
    expect(buffer.toArray()).toEqual([1])
  })

  it('tail 取最后 n 条，n 超过长度返回全部', () => {
    const buffer = new RingBuffer<number>(5)
    for (const n of [1, 2, 3]) buffer.push(n)
    expect(buffer.tail(2)).toEqual([2, 3])
    expect(buffer.tail(0)).toEqual([])
    expect(buffer.tail(99)).toEqual([1, 2, 3])
  })

  it('clear 清空', () => {
    const buffer = new RingBuffer<number>(2)
    buffer.push(1)
    buffer.clear()
    expect(buffer.size).toBe(0)
    buffer.push(2)
    expect(buffer.toArray()).toEqual([2])
  })
})

describe('Stream 状态机（FakeWebSocket + fake timers）', () => {
  const originalWebSocket = globalThis.WebSocket
  let states: StreamState[]
  let details: (string | undefined)[]

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.reset()
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    states = []
    details = []
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
    vi.useRealTimers()
  })

  function trackedStream<T>(url: string, onMessage?: (frame: T) => void): Stream<T> {
    return new Stream<T>(url, {
      onMessage: onMessage ?? (() => {}),
      onState: (state, detail) => {
        states.push(state)
        details.push(detail)
      },
    })
  }

  it('建立连接后置 open，合法 JSON 帧派发给 onMessage', () => {
    const frames: unknown[] = []
    const stream = trackedStream('ws://kernel/traffic', (frame: unknown) => frames.push(frame))
    const socket = FakeWebSocket.instances.at(-1)
    expect(socket?.url).toBe('ws://kernel/traffic')

    socket?.emit('open')
    socket?.emit('message', { data: '{"up":1,"down":2}' })
    socket?.emit('message', { data: 'not json' })
    socket?.emit('message', { data: '' })

    expect(states).toContain('open')
    expect(frames).toEqual([{ up: 1, down: 2 }])
    stream.close()
  })

  it('二进制帧按 UTF-8 解码后同样派发', () => {
    const frames: unknown[] = []
    const stream = trackedStream('ws://kernel/logs', (frame: unknown) => frames.push(frame))
    const socket = FakeWebSocket.instances.at(-1)
    socket?.emit('open')
    // 注意不能用 Buffer.from(...).buffer —— 小 Buffer 来自 8KB 池，会带上无关字节
    socket?.emit('message', {
      data: new TextEncoder().encode('{"type":"log"}').buffer,
    })
    expect(frames).toEqual([{ type: 'log' }])
    stream.close()
  })

  it('意外断开后按 initialDelay 重连', () => {
    const stream = trackedStream('ws://kernel/traffic', undefined)
    const first = FakeWebSocket.instances.at(-1)
    first?.emit('open')
    first?.emit('close', { code: 1006, reason: 'boom' })

    expect(states.at(-1)).toBe('reconnecting')
    expect(details.at(-1)).toBe('boom')

    vi.advanceTimersByTime(999)
    expect(FakeWebSocket.instances.length).toBe(1)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances.length).toBe(2)
    stream.close()
  })

  it('退避翻倍且受 maxDelay 限制', () => {
    const stream = new Stream('ws://kernel/traffic', {
      onMessage: () => {},
      onState: () => {},
    }, { initialDelay: 100, maxDelay: 300 })

    const first = FakeWebSocket.instances.at(-1)
    first?.emit('close', { code: 1006 })
    vi.advanceTimersByTime(100) // 第 1 次重连（延迟 100）
    expect(FakeWebSocket.instances.length).toBe(2)

    FakeWebSocket.instances.at(-1)?.emit('close', { code: 1006 })
    vi.advanceTimersByTime(199) // 第 2 次延迟应为 200
    expect(FakeWebSocket.instances.length).toBe(2)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances.length).toBe(3)

    FakeWebSocket.instances.at(-1)?.emit('close', { code: 1006 })
    vi.advanceTimersByTime(299) // 第 3 次延迟应为 300（400 被封顶）
    expect(FakeWebSocket.instances.length).toBe(3)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances.length).toBe(4)
    stream.close()
  })

  it('重连成功后退避重置回 initialDelay', () => {
    const stream = trackedStream('ws://kernel/traffic', undefined)
    FakeWebSocket.instances.at(-1)?.emit('close', { code: 1006 })
    vi.advanceTimersByTime(1000)
    FakeWebSocket.instances.at(-1)?.emit('open')

    FakeWebSocket.instances.at(-1)?.emit('close', { code: 1006 })
    vi.advanceTimersByTime(999)
    expect(FakeWebSocket.instances.length).toBe(2)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances.length).toBe(3)
    stream.close()
  })

  it('close() 幂等：不再重连、不再回调、底层 close(1000)', () => {
    const stream = trackedStream('ws://kernel/traffic', undefined)
    const socket = FakeWebSocket.instances.at(-1)
    socket?.emit('open')
    states.length = 0

    stream.close()
    expect(states).toEqual(['closed'])

    // close 后 socket 再发 close 事件也不重连
    socket?.emit('close', { code: 1006 })
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances.length).toBe(1)
    expect(socket?.closeCodes).toEqual([1000])

    stream.close()
    expect(states).toEqual(['closed'])
  })

  it('WebSocket 构造同步抛异常时也走退避重试', () => {
    // 模拟 global WebSocket 暂时不可用（如非法 URL 的同步失败）
    const fake = globalThis.WebSocket
    globalThis.WebSocket = function throwing() {
      throw new Error('bad url')
    } as unknown as typeof WebSocket

    const stream = trackedStream('ws://kernel/traffic', undefined)
    expect(FakeWebSocket.instances.length).toBe(0)
    expect(states.at(-1)).toBe('reconnecting')

    // 恢复后，下一个重连周期应当成功建连
    globalThis.WebSocket = fake
    vi.advanceTimersByTime(1000)
    expect(FakeWebSocket.instances.length).toBe(1)
    stream.close()
  })
})
