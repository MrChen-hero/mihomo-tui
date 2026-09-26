/** 仅保留旧配置，不提供 relay 创建能力；新内核仍由 mihomo -t 拒绝不兼容配置。 */
export function preserveLegacyRelayGroups(
  generated: Record<string, unknown>[],
  previous: unknown,
): Record<string, unknown>[] {
  if (!Array.isArray(previous)) return generated
  const preserved = previous.filter((group): group is Record<string, unknown> =>
    typeof group === 'object' && group !== null && group.type === 'relay' && typeof group.name === 'string')
  const names = new Set(preserved.map((group) => group.name))
  return [...generated.filter((group) => !names.has(group.name)), ...preserved]
}
