/**
 * 分级 ESC 退出（spec 2026-09-13）：
 * 1. keyCapture 登记表的纯行为
 * 2. App 级回归——对话框/编辑态里按 ESC 只退当前层，TUI 不退出（广播式
 *    useInput 下没有闸门时 App 的 exit() 会被同一个 ESC 再触发一次）
 *
 * App 用不可达的 api 地址挂载：钩子的请求快速失败走错误态，不触真实内核。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App.js'
import type { AppConfig } from '../config.js'
import { createTerminal, delay, textOf, type Terminal } from '../components/__tests__/harness.js'
import { keysCaptured, useKeyCapture } from '../ui/keyCapture.js'
import { Text } from 'ink'
import React from 'react'

const terminals: Terminal[] = []

afterEach(() => {
  for (const t of terminals.splice(0)) t.instance.unmount()
  vi.restoreAllMocks()
})

function mountApp(): Terminal {
  const mihomoDir = mkdtempSync(join(tmpdir(), 'mihomo-tui-appesc-'))
  const config: AppConfig = {
    api: 'http://127.0.0.1:9', // 不可达：钩子快速失败，不触真实内核
    secret: '',
    mihomoDir,
    testUrl: 'http://127.0.0.1:9',
    testTimeout: 500,
  }
  const term = createTerminal(<App config={config} version="test" mode="rule" />, { columns: 110, rows: 34 })
  terminals.push(term)
  return term
}

describe('keyCapture 登记表', () => {
  it('useKeyCapture(true) 登记、卸载注销、false 不登记', async () => {
    function Probe({ on }: { on: boolean }) {
      useKeyCapture(on)
      return <Text>x</Text>
    }
    expect(keysCaptured()).toBe(false)
    const t1 = createTerminal(<Probe on />)
    terminals.push(t1)
    await delay()
    expect(keysCaptured()).toBe(true)
    t1.instance.unmount()
    await delay()
    expect(keysCaptured()).toBe(false)
    const t2 = createTerminal(<Probe on={false} />)
    terminals.push(t2)
    await delay()
    expect(keysCaptured()).toBe(false)
    t2.instance.unmount()
  })
})

describe('App 分级退出闸门', () => {
  it('订阅页新增对话框中按 ESC：对话框关闭、TUI 仍存活', async () => {
    const term = mountApp()
    await delay(120)
    term.press('\t') // → [2] 订阅
    await delay(80)
    term.press('a') // 打开新增对话框
    await delay(80)
    expect(textOf(term.frames())).toContain('添加订阅')
    const before = term.frames().length

    term.press('\x1b') // ESC：只应关闭对话框
    await delay(120)
    // frames() 是累积的，只看 ESC 之后的增量帧
    const tail = textOf(term.frames().slice(before))
    expect(tail).not.toContain('订阅名称') // 对话框已关
    expect(keysCaptured()).toBe(false)

    term.press('\t') // ESC 后再 Tab：应切到 [3] 日志页 = TUI 活着且在响应
    await delay(120)
    const live = textOf(term.frames().slice(before))
    expect(live).toContain('切级别') // [3] 日志页页脚特征；若已退出则无新帧
    term.instance.unmount()
  })

  it('日志页过滤编辑态按 ESC：只退编辑态，TUI 仍存活', async () => {
    const term = mountApp()
    await delay(120)
    term.press('\t')
    await delay(60)
    term.press('\t') // → [3] 日志
    await delay(60)
    term.press('/') // 进入过滤编辑
    await delay(60)
    expect(textOf(term.frames())).toContain('/')
    const before = term.frames().length

    term.press('\x1b')
    await delay(120)
    expect(keysCaptured()).toBe(false)

    term.press('\t') // ESC 后再 Tab：应切到 [4] 连接页
    await delay(120)
    const live = textOf(term.frames().slice(before))
    expect(live).toContain('关闭选中') // [4] 连接页页脚特征；若已退出则无新帧
    term.instance.unmount()
  })

  it('enterConfirms 缺省时 Enter 不确认（删除类确认保持显式 y）；键帽为 y/n 版', async () => {
    const { ConfirmDialog } = await import('../components/ConfirmDialog.js')
    let confirmed = 0
    const t = createTerminal(
      <ConfirmDialog message="确认删除订阅 x？" onConfirm={() => { confirmed++ }} onCancel={() => {}} />,
    )
    terminals.push(t)
    await delay(80)
    expect(textOf(t.frames())).toContain('y 确认')
    expect(textOf(t.frames())).toContain('n/Esc 取消')
    t.press('\r')
    await delay(80)
    expect(confirmed).toBe(0)
    t.press('y')
    await delay(80)
    expect(confirmed).toBe(1)
    t.instance.unmount()
  })

  it('enterConfirms 开启时 Enter 确认（退出确认），键帽为 Enter/Esc 版', async () => {
    const { ConfirmDialog } = await import('../components/ConfirmDialog.js')
    let confirmed = 0
    const t = createTerminal(
      <ConfirmDialog message="确认退出？" enterConfirms onConfirm={() => { confirmed++ }} onCancel={() => {}} />,
    )
    terminals.push(t)
    await delay(80)
    expect(textOf(t.frames())).toContain('Enter 确认')
    expect(textOf(t.frames())).toContain('Esc 取消')
    t.press('\r')
    await delay(80)
    expect(confirmed).toBe(1)
    t.instance.unmount()
  })

  it('主界面 ESC 弹退出确认，Enter 真正退出', async () => {
    const term = mountApp()
    await delay(120)
    term.press('\x1b') // 主界面 ESC：弹确认，不退出
    await delay(120)
    expect(textOf(term.frames())).toContain('确认退出？')
    term.press('\r') // Enter 确认
    await delay(250) // unmount 自身会写收尾帧，等它结束
    const settled = term.frames().length
    term.press('\t') // 已退出则帧数必须冻结
    await delay(150)
    expect(term.frames().length).toBe(settled)
    term.instance.unmount()
  })

  it('退出确认期间全局键停摆；取消回主界面；可再次弹出', async () => {
    const term = mountApp()
    await delay(120)
    term.press('\x1b') // 主界面 ESC → 确认框
    await delay(150)
    expect(textOf(term.frames())).toContain('确认退出？')

    const openMark = term.frames().length
    term.press('\t') // 确认期间：Tab 必须被吞（不切页）
    await delay(100)
    term.press('2') // 数字切页键同样被吞
    await delay(100)
    term.press('\x1b') // ESC 取消
    await delay(150)

    // 取消后的重绘应仍是 [1] 页（←→ 切栏 是 [1] 页脚独有）；
    // 若 Tab/2 穿透了闸门，这里会是 [2]/[3] 页的内容
    const afterCancel = textOf(term.frames().slice(openMark))
    expect(afterCancel).toContain('←→ 切栏')
    expect(afterCancel).not.toContain('a 新增')
    expect(afterCancel).not.toContain('切级别')

    const reopenMark = term.frames().length
    term.press('\x1b') // 主界面仍活着：再按 ESC 确认框再次出现
    await delay(150)
    expect(textOf(term.frames().slice(reopenMark))).toContain('确认退出？')
    term.instance.unmount()
  })
})
