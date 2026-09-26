import { useEffect, useRef } from 'react'

const guards = new Map<symbol, (exit: () => void) => void>()
/** Separate from ordinary key capture: Ctrl+C must consult transaction guards first. */
export function requestGuardedExit(exit: () => void): boolean {
  const guard = [...guards.values()].at(-1)
  if (!guard) return false
  guard(exit)
  return true
}
export function useExitGuard(handler: (exit: () => void) => void): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    const token = Symbol('rule-exit')
    guards.set(token, exit => latest.current(exit))
    return () => { guards.delete(token) }
  }, [])
}
