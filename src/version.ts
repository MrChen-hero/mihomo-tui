/**
 * 版本号来源链：编译期注入 > 环境变量 > package.json > '0.0.0-dev' 哨兵。
 * bun build --compile 的产物里没有 package.json，import.meta.url 指向虚拟路径，
 * 读盘必炸——编译期必须 --define 注入；其余运行形态（tsx 源码、dist、npm 发布包）
 * 都读得到 package.json，兜底保证「不注入也正确」。产物若误打出 0.0.0-dev，
 * 即为 define 未生效的诊断信号。
 */
import { readFileSync } from 'node:fs'

declare global {
  // bin 胶水与 bun --define 都写这个全局；declare global 的纯值绑定只能用 var
  var __MIHOMO_TUI_VERSION__: string | undefined
}

export const VERSION: string =
  nonEmpty(globalThis.__MIHOMO_TUI_VERSION__) ??
  nonEmpty(process.env['MIHOMO_TUI_VERSION']) ??
  readPackageVersion() ??
  '0.0.0-dev'

/** 空串不是有效版本号：env 与注入通道都可能带来空值 */
function nonEmpty(value: string | undefined): string | undefined {
  return value ? value : undefined
}

/** package.json 读不到（编译产物）不算错误，只是退回下一级来源 */
function readPackageVersion(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown
    }
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : undefined
  } catch {
    return undefined
  }
}
