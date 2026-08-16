/** proxy_tui logs —— WebSocket 实时日志 */
import { MihomoClient } from '../api/client.js'
import { RingBuffer, Stream } from '../api/stream.js'
import type { LogFrame, LogLevel } from '../api/types.js'
import type { AppConfig } from '../config.js'
import { EXIT, exitAfterFlush } from './output.js'

const LEVELS: LogLevel[] = ['silent', 'error', 'warning', 'info', 'debug']

export interface LogsOptions {
  level?: string
  follow?: boolean
  json?: boolean
  grep?: string
  /** 非 follow 模式下收集多少条后退出 */
  lines?: string
  /** 非 follow 模式下多久没有新日志就退出（秒） */
  idle?: string
}

export async function runLogs(config: AppConfig, options: LogsOptions): Promise<void> {
  const level = (options.level ?? 'info') as LogLevel
  if (!LEVELS.includes(level)) {
    process.stderr.write(`错误：--level 只支持 ${LEVELS.join(' / ')}\n`)
    process.exit(EXIT.usage)
  }

  let pattern: RegExp | undefined
  if (options.grep) {
    try {
      pattern = new RegExp(options.grep, 'i')
    } catch (err) {
      process.stderr.write(`错误：--grep 正则无效：${err instanceof Error ? err.message : err}\n`)
      process.exit(EXIT.usage)
    }
  }

  const wanted = options.lines ? Number(options.lines) : 20
  if (!Number.isFinite(wanted) || wanted <= 0) {
    process.stderr.write('错误：--lines 需为正整数\n')
    process.exit(EXIT.usage)
  }

  const idleSeconds = options.idle ? Number(options.idle) : 5
  if (!Number.isFinite(idleSeconds) || idleSeconds <= 0) {
    process.stderr.write('错误：--idle 需为正数（秒）\n')
    process.exit(EXIT.usage)
  }

  const client = new MihomoClient(config)
  // 先握一次 REST，内核不可达时直接给退出码 3，而不是让 WebSocket 静默重连
  await client.version()

  // 环形缓冲上限 1000 行，防止 -f 长跑内存膨胀（SPEC 5.3）
  const buffer = new RingBuffer<LogFrame>(1000)
  let count = 0

  await new Promise<void>((resolve) => {
    let idleTimer: NodeJS.Timeout | undefined
    let stream: Stream<LogFrame> | undefined

    const finish = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = undefined
      stream?.close()
      resolve()
    }

    /**
     * 空闲超时：内核闲着不产日志时，非 follow 模式必须能自己退出，
     * 否则 `logs -n 5` 会永久挂住（实测过）。
     */
    const resetIdle = () => {
      if (options.follow) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (count === 0) {
          process.stderr.write(`[${idleSeconds}s 内无日志输出，已退出]\n`)
        }
        finish()
      }, idleSeconds * 1000)
    }

    stream = new Stream<LogFrame>(client.logsUrl(level), {
      onMessage: (frame) => {
        if (typeof frame?.payload !== 'string') return
        if (pattern && !pattern.test(frame.payload)) {
          // 被过滤掉的帧也算「有动静」，避免刷屏时被空闲超时误杀
          resetIdle()
          return
        }
        buffer.push(frame)
        count += 1
        process.stdout.write(
          options.json
            ? `${JSON.stringify(frame)}\n`
            : `${frame.type.padEnd(7)} ${frame.payload}\n`,
        )
        if (!options.follow && count >= wanted) {
          finish()
          return
        }
        resetIdle()
      },
      onState: (state, detail) => {
        // 状态信息走 stderr，stdout 保持纯日志以便管道消费
        if (state === 'open') resetIdle()
        if (state === 'reconnecting') {
          process.stderr.write(`[连接断开，正在重连${detail ? `：${detail}` : ''}]\n`)
        }
      },
    })

    process.once('SIGINT', finish)
    process.once('SIGTERM', finish)
  })

  // mihomo 不回 WebSocket close 帧，句柄不会释放，必须显式退出（见 exitAfterFlush 注释）
  await exitAfterFlush(EXIT.ok)
}
