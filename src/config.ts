/**
 * 程序自身配置：~/.config/mihomo-tui/config.json
 * 首次运行时自动生成。注意：这里写的是 mihomo-tui 的配置，
 * 绝不是 mihomo 内核的 config.yaml —— 本程序没有写内核配置的代码路径。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface DelayThresholds {
  /** 低于该值视为「正常」，绿色显示 */
  good: number
  /** 低于该值视为「一般」，黄色显示；高于则「缓慢」，红色显示 */
  fair: number
}

export interface AppConfig {
  /** External Controller 地址，形如 http://127.0.0.1:19090 */
  api: string
  /** 控制口密钥，本机当前为空 */
  secret: string
  /** mihomo 内核配置目录，仅用于只读展示 */
  mihomoDir: string
  /** 延迟测试地址 */
  testUrl: string
  /** 单次延迟测试超时（毫秒） */
  testTimeout: number
  delayThresholds: DelayThresholds
}

export const CONFIG_PATH = join(homedir(), '.config', 'mihomo-tui', 'config.json')

export const DEFAULT_CONFIG: AppConfig = {
  api: 'http://127.0.0.1:19090',
  secret: '',
  mihomoDir: join(homedir(), '.config', 'mihomo'),
  testUrl: 'https://www.gstatic.com/generate_204',
  testTimeout: 5000,
  delayThresholds: { good: 300, fair: 800 },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 逐字段校验用户配置，非法字段回退默认值，避免一个笔误导致整个程序起不来 */
function merge(raw: unknown): AppConfig {
  if (!isRecord(raw)) return { ...DEFAULT_CONFIG }
  const thresholds = isRecord(raw.delayThresholds) ? raw.delayThresholds : {}
  return {
    api: typeof raw.api === 'string' && raw.api ? raw.api.replace(/\/+$/, '') : DEFAULT_CONFIG.api,
    secret: typeof raw.secret === 'string' ? raw.secret : DEFAULT_CONFIG.secret,
    mihomoDir:
      typeof raw.mihomoDir === 'string' && raw.mihomoDir ? raw.mihomoDir : DEFAULT_CONFIG.mihomoDir,
    testUrl: typeof raw.testUrl === 'string' && raw.testUrl ? raw.testUrl : DEFAULT_CONFIG.testUrl,
    testTimeout:
      typeof raw.testTimeout === 'number' && raw.testTimeout > 0
        ? raw.testTimeout
        : DEFAULT_CONFIG.testTimeout,
    delayThresholds: {
      good:
        typeof thresholds.good === 'number' && thresholds.good > 0
          ? thresholds.good
          : DEFAULT_CONFIG.delayThresholds.good,
      fair:
        typeof thresholds.fair === 'number' && thresholds.fair > 0
          ? thresholds.fair
          : DEFAULT_CONFIG.delayThresholds.fair,
    },
  }
}

/** 读取配置；文件不存在则生成一份默认配置后返回 */
export function loadConfig(path: string = CONFIG_PATH): AppConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const created = { ...DEFAULT_CONFIG }
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, `${JSON.stringify(created, null, 2)}\n`, 'utf8')
      } catch {
        // 写不进去也不该阻断运行，用内存里的默认值继续
      }
      return created
    }
    throw err
  }

  try {
    return merge(JSON.parse(text))
  } catch {
    // 配置文件坏了不改它，也不崩，用默认值跑
    return { ...DEFAULT_CONFIG }
  }
}
