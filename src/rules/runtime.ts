import { HttpStatusError, KernelUnreachableError, type MihomoClient } from '../api/client.js'
import type { RuleItem } from '../api/types.js'

export type RuleClient = Pick<MihomoClient, 'rules' | 'ruleProviders' | 'updateRuleProvider' | 'setRuleDisabled'>

/** 不含计数和禁用状态，统计变化不影响序列身份。 */
export function ruleSequence(rules: RuleItem[]): string {
  return JSON.stringify(rules.map(({ index, type, payload, proxy }) => [index, type, payload, proxy]))
}

export function canDisableRule(rule: RuleItem): boolean {
  return Number.isInteger(rule.index) && rule.index! >= 0 && typeof rule.extra?.disabled === 'boolean'
}

export function isUnsupportedApi(err: unknown): boolean {
  return err instanceof HttpStatusError && [404, 405].includes(err.status)
}

export interface ToggleResult {
  status: 'confirmed' | 'unsupported' | 'stale' | 'unconfirmed'
  rules: RuleItem[]
  detail?: string
}

/** 无自动重试：PATCH 与外部 reload 之间无法实现条件写入。 */
export async function toggleRule(
  client: Pick<RuleClient, 'rules' | 'setRuleDisabled'>,
  snapshot: RuleItem[],
  position: number,
): Promise<ToggleResult> {
  const selected = snapshot[position]
  if (!selected || !canDisableRule(selected)) return { status: 'unsupported', rules: snapshot }
  const fresh = await client.rules()
  const current = fresh[position]
  if (ruleSequence(fresh) !== ruleSequence(snapshot) || current?.extra?.disabled !== selected.extra?.disabled) {
    return { status: 'stale', rules: fresh }
  }
  if (!current || !canDisableRule(current)) return { status: 'unsupported', rules: fresh }
  const disabled = !current.extra!.disabled
  try {
    await client.setRuleDisabled(current.index!, disabled)
  } catch (err) {
    if (isUnsupportedApi(err)) return { status: 'unsupported', rules: fresh }
    if (err instanceof KernelUnreachableError) return { status: 'unconfirmed', rules: fresh, detail: err.message }
    throw err
  }
  try {
    const after = await client.rules()
    if (ruleSequence(after) !== ruleSequence(fresh) || after[position]?.extra?.disabled !== disabled) {
      return { status: 'unconfirmed', rules: after }
    }
    return { status: 'confirmed', rules: after }
  } catch (err) {
    return { status: 'unconfirmed', rules: fresh, detail: err instanceof Error ? err.message : String(err) }
  }
}
