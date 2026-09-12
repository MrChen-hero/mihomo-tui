/** CLI 输出与错误处理的公共部分：统一表格排版、脱敏、退出码。 */
import {
  ApiBusinessError,
  HttpStatusError,
  KernelUnreachableError,
} from '../api/client.js'
import { CONFIG_PATH } from '../config.js'

/** 退出码约定：0 成功，1 通用错误，2 参数错误，3 内核不可达 */
export const EXIT = { ok: 0, error: 1, usage: 2, unreachable: 3 } as const

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/**
 * 订阅 URL 含 token，任何展示都必须脱敏。
 * 实现随 v0.2.0 迁至 config/subscriptions.ts（清单模块是 token 的属主），
 * 这里保留导出以维持既有调用方与测试的导入路径。
 */
export { redactUrl } from '../config/subscriptions.js'

/**
 * 终端宽度。
 * 非 TTY（输出被管道或重定向）时不做窄屏降级 —— 那种场景是给 grep/jq 消费的，
 * 信息完整比排版好看更重要，故返回 Infinity。
 */
export function terminalWidth(): number {
  if (!process.stdout.isTTY) return Number.POSITIVE_INFINITY
  return process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80
}

/** 中日韩字符与 emoji 占两列，等宽终端下必须按显示宽度对齐而非按码点数 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0xfe0f || (code >= 0x1f1e6 && code <= 0x1f1ff)) {
      // 变体选择符不占宽；区域指示符成对组成国旗，单个按 1 计，一对合计 2
      width += code === 0xfe0f ? 0 : 1
      continue
    }
    width += isWide(code) ? 2 : 1
  }
  return width
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

export function padDisplay(text: string, width: number): string {
  const pad = width - displayWidth(text)
  return pad > 0 ? text + ' '.repeat(pad) : text
}

/**
 * 按**显示宽度**截断，超出时以 … 结尾。
 * 不能用 slice —— 那是按码点数切，中文和 emoji 会把列宽撑破导致错位。
 */
export function truncateDisplay(text: string, max: number): string {
  if (max <= 0) return ''
  if (displayWidth(text) <= max) return text
  let out = ''
  for (const char of text) {
    if (displayWidth(out + char) > max - 1) break
    out += char
  }
  return `${out}…`
}

/** 先按显示宽度截断再补齐，保证该列恒定占 width 列 */
export function fitDisplay(text: string, width: number): string {
  return padDisplay(truncateDisplay(text, width), width)
}

/** 按显示宽度输出表格，最后一列不补空格，便于 grep */
export function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((cell, index) =>
    Math.max(displayWidth(cell), ...rows.map((row) => displayWidth(row[index] ?? ''))),
  )
  const lines = [header, ...rows].map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : padDisplay(cell, widths[index] ?? 0)))
      .join('  ')
      .trimEnd(),
  )
  return lines.join('\n')
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '---'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(2)} ${units[unit]}`
}

/** 相对时间，用于 provider 的 UPDATED 列 */
export function formatRelativeTime(iso: string | undefined): string {
  if (!iso) return '---'
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return '---'
  const seconds = Math.floor((Date.now() - time) / 1000)
  if (seconds < 0) return '刚刚'
  if (seconds < 60) return `${seconds}s 前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m 前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h 前`
  return `${Math.floor(seconds / 86400)}d 前`
}

/**
 * 冲净 stdout/stderr 后退出。
 *
 * 为什么需要：mihomo 不回应 WebSocket 的 close 帧（实测 v1.19.24），
 * undici 的关闭握手永不完成，TCP 句柄一直挂在事件循环上，进程不会自然退出。
 * 凡是用过 Stream 的命令都必须走这里显式退出。
 */
export async function exitAfterFlush(code: number): Promise<never> {
  for (const stream of [process.stdout, process.stderr]) {
    if (stream.writableLength > 0) {
      await new Promise<void>((resolve) => stream.write('', () => resolve()))
    }
  }
  process.exit(code)
}

/**
 * 把异常翻译成一行人话 + 退出码。
 * 业务错误（如延迟测试失败）由调用方自行处理，不该走到这里。
 */
export function reportError(err: unknown): never {
  if (err instanceof KernelUnreachableError) {
    process.stderr.write(`错误：${err.message}\n`)
    process.stderr.write('内核可能未运行，请排查：systemctl --user status mihomo\n')
    process.exit(EXIT.unreachable)
  }
  if (err instanceof HttpStatusError) {
    if (err.status === 401) {
      process.stderr.write(`错误：控制口鉴权失败（HTTP 401），请检查 secret 配置：${CONFIG_PATH}\n`)
      process.exit(EXIT.error)
    }
    if (err.status === 404) {
      process.stderr.write(`错误：目标不存在（HTTP 404）：${decodeURIComponent(err.path)}\n`)
      process.exit(EXIT.error)
    }
    process.stderr.write(`错误：${err.message}\n`)
    process.exit(EXIT.error)
  }
  if (err instanceof ApiBusinessError) {
    process.stderr.write(`错误：${err.message}\n`)
    process.exit(EXIT.error)
  }
  process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(EXIT.error)
}
