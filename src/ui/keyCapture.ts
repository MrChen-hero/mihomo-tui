/**
 * 按键捕获登记表：ink 的 useInput 是广播式的（所有挂载的 hook 都收到同一
 * 按键），没有「内层优先消费」的机制。谁在捕获按键谁在这里登记，App 的
 * 全局 handler 见登记即让路——移植 cc-switch 的内层守卫范式（它的实现靠
 * 事件冒泡 + defaultPrevented，ink 没有等价物）。
 */
import { useEffect } from 'react'

const captured = new Set<symbol>()

/** 当前是否有组件正在捕获全部按键（对话框、文本编辑态、二次确认态等） */
export function keysCaptured(): boolean {
  return captured.size > 0
}

/**
 * 声明本组件在 active 期间捕获全部按键。挂载即登记、卸载即注销，
 * 状态切换（如日志过滤编辑态）传布尔值即可。
 */
export function useKeyCapture(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const token = Symbol('key-capture')
    captured.add(token)
    return () => {
      captured.delete(token)
    }
  }, [active])
}
