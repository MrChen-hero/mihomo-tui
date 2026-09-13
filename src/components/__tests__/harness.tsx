/**
 * Ink 组件的无头测试装置：模拟 stdout/stdin，捕获帧输出、注入按键。
 * 等价于 ink-testing-library 的最小实现，但不引入额外依赖（其版本与 React 19 不兼容）。
 */
import { EventEmitter } from 'node:events'
import { render, type Instance } from 'ink'

export interface Terminal {
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  /** 渲染输出的全部帧（含 ANSI 序列） */
  frames: () => string
  /** 注入一次按键（原始字节） */
  press: (key: string) => void
  instance: Instance
}

export function createTerminal(
  element: React.ReactElement,
  opts: { columns?: number; rows?: number } = {},
): Terminal {
  const chunks: string[] = []

  const stdout = new EventEmitter() as unknown as NodeJS.WriteStream
  const stdoutAny = stdout as unknown as Record<string, unknown>
  stdoutAny.columns = opts.columns ?? 80
  stdoutAny.rows = opts.rows ?? 24
  // ink 7 只有在 isTTY 的 stdout 上才走同步渲染路径
  stdoutAny.isTTY = true
  stdoutAny.write = (chunk: Uint8Array | string): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }

  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream
  const stdinAny = stdin as unknown as Record<string, unknown>
  stdinAny.isTTY = true
  stdinAny.setRawMode = (): void => {}
  stdinAny.setEncoding = (): void => {}
  stdinAny.ref = (): void => {}
  stdinAny.unref = (): void => {}
  stdinAny.resume = (): void => {}
  stdinAny.pause = (): void => {}
  // ink 7 通过 readable 事件 + stdin.read() 拉取输入，readable 模式下 read() 必须有数据可还
  const inputBuffer: string[] = []
  stdinAny.read = (): string | null => inputBuffer.shift() ?? null
  stdinAny.isRaw = true

  const instance = render(element, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    // ink 7 在 CI 环境（is-in-ci）默认进入非交互模式、不写帧 —— 测试装置必须显式开启
    interactive: true,
  })

  return {
    stdout,
    stdin,
    frames: () => chunks.join(''),
    press: (key: string) => {
      inputBuffer.push(key)
      stdin.emit('readable')
    },
    instance,
  }
}

/** 去掉 ANSI 转义与控制字符，便于对可见文本断言 */
export function textOf(frames: string): string {
  return frames
    .replace(/\u001B\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\u001B\][^\u0007]*(\u0007|\u001B\\)/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

export const delay = (ms = 60): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))
