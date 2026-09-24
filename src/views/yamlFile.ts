/**
 * 订阅 YAML 文件的校验（v0.3.0 §7）。
 *
 * 编辑器（TextEditor）通过 validate 回调使用它：必须是合法 YAML 且顶层
 * 含 proxies 数组，空文件视为合法。锁定逻辑不在这里——保存远程订阅时由
 * 调用方走 editSubscription({ locked: true })。
 */
import YAML from 'yaml'

export type YamlCheck = { ok: true } | { ok: false; error: string }

/**
 * 校验订阅文件文本：必须是合法 YAML，且顶层含 `proxies` 数组。
 * 空文件视为合法（等价于空节点列表）。
 */
export function checkProxyFile(text: string): YamlCheck {
  if (text.trim() === '') return { ok: true }
  let parsed: unknown
  try {
    parsed = YAML.parse(text)
  } catch (err) {
    return { ok: false, error: `YAML 解析失败：${err instanceof Error ? err.message : String(err)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: '文件顶层必须是映射（包含 proxies 字段）' }
  }
  const proxies = (parsed as Record<string, unknown>).proxies
  if (!Array.isArray(proxies)) {
    return { ok: false, error: '缺少 proxies 数组' }
  }
  return { ok: true }
}
