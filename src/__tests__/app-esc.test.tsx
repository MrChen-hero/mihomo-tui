/**
 * 分级 ESC 退出（spec 2026-09-13）：
 * 1. keyCapture 登记表的纯行为
 * 2. App 级回归——对话框/编辑态里按 ESC 只退当前层，TUI 不退出（广播式
 *    useInput 下没有闸门时 App 的 exit() 会被同一个 ESC 再触发一次）
 *
 * App 用不可达的 api 地址挂载：钩子的请求快速失败走错误态，不触真实内核。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App.js'
import { MihomoClient } from '../api/client.js'
import { RuleService } from '../config/ruleService.js'
import { readRuleSnapshot } from '../config/ruleDocument.js'
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
  it('规则编辑输入与 Tab 不穿透，Ctrl+C 经草稿放弃确认后退出', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mihomo-app-rule-edit-'))
    const path = join(dir, 'config.yaml'), subs = join(dir, 'subs.json')
    writeFileSync(path, 'rules: ["MATCH,DIRECT"]\n')
    writeFileSync(subs, '{"subscriptions":[{"name":"local","type":"local"}]}')
    vi.spyOn(RuleService.prototype, 'open').mockReturnValue(readRuleSnapshot(path, subs))
    vi.spyOn(MihomoClient.prototype, 'rules').mockResolvedValue([{ type: 'Match', payload: '', proxy: 'DIRECT' }])
    vi.spyOn(MihomoClient.prototype, 'ruleProviders').mockResolvedValue({})
    const mode = vi.spyOn(MihomoClient.prototype, 'setMode').mockResolvedValue(undefined)
    const term = mountApp(); await delay(100)
    for (const key of ['3', 'e', 'a', '\x1b[B', '\r', 'DOMAIN,aedJK123456m.example,DIRECT', '\r']) {
      term.press(key); await delay(70)
    }
    expect(textOf(term.frames())).toContain('未保存')
    expect(mode).not.toHaveBeenCalled()
    const mark = term.frames().length
    term.press('\t'); await delay(70)
    expect(textOf(term.frames().slice(mark))).not.toContain('切级别')
    term.press('\x03'); await delay(100)
    expect(textOf(term.frames())).toContain('放弃未保存草稿并退出程序')
    term.press('n'); await delay(70)
    expect(keysCaptured()).toBe(true)
    term.press('\x03'); await delay(70); term.press('y'); await delay(200)
    const settled = term.frames().length
    term.press('\t'); await delay(100)
    expect(term.frames().length).toBe(settled)
  })
  it('规则页详情/输入 ESC 不退出，m 不穿透为全局模式修改', async () => {
    vi.spyOn(MihomoClient.prototype, 'rules').mockResolvedValue([
      { type: 'Domain', payload: 'example.com', proxy: 'DIRECT' },
    ])
    vi.spyOn(MihomoClient.prototype, 'ruleProviders').mockResolvedValue({})
    const setMode = vi.spyOn(MihomoClient.prototype, 'setMode').mockResolvedValue(undefined)
    const term = mountApp()
    await delay(120)
    term.press('3'); await delay(100)
    term.press('m'); await delay(100)
    expect(setMode).not.toHaveBeenCalled()
    expect(textOf(term.frames())).toContain('[标记]')
    term.press('\r'); await delay(100)
    expect(keysCaptured()).toBe(true)
    let mark = term.frames().length
    term.press('\x1b'); await delay(100)
    expect(keysCaptured()).toBe(false)
    expect(textOf(term.frames().slice(mark))).not.toContain('确认退出？')
    term.press('t'); await delay(100)
    expect(keysCaptured()).toBe(true)
    mark = term.frames().length
    term.press('\x1b'); await delay(100)
    expect(keysCaptured()).toBe(false)
    expect(textOf(term.frames().slice(mark))).not.toContain('确认退出？')
    term.press('4'); await delay(100)
    expect(textOf(term.frames().slice(mark))).toContain('切级别')
  })
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

    term.press('\t') // ESC 后再 Tab：应切到 [3] 规则页 = TUI 活着且在响应
    await delay(120)
    const live = textOf(term.frames().slice(before))
    expect(live).toContain('切类型') // [3] 规则页页脚特征；若已退出则无新帧
    term.instance.unmount()
  })

  it('日志页过滤编辑态按 ESC：只退编辑态，TUI 仍存活', async () => {
    const term = mountApp()
    await delay(120)
    term.press('\t')
    await delay(60)
    term.press('\t')
    await delay(60)
    term.press('\t') // → [4] 日志
    await delay(60)
    term.press('/') // 进入过滤编辑
    await delay(60)
    expect(textOf(term.frames())).toContain('/')
    const before = term.frames().length

    term.press('\x1b')
    await delay(120)
    expect(keysCaptured()).toBe(false)

    term.press('\t') // ESC 后再 Tab：应切到 [5] 连接页
    await delay(120)
    const live = textOf(term.frames().slice(before))
    expect(live).toContain('关闭选中') // [5] 连接页页脚特征；若已退出则无新帧
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

  it('数字键 6 打开设置页；设置页 ESC 仍走分级退出', async () => {
    const mihomoDir = mkdtempSync(join(tmpdir(), 'mihomo-tui-appset-'))
    writeFileSync(join(mihomoDir, 'config.yaml'), 'mode: rule\nmixed-port: 17890\nlog-level: info\n', 'utf8')
    const config: AppConfig = {
      api: 'http://127.0.0.1:9', // 不可达：不触真实内核
      secret: '',
      mihomoDir,
      testUrl: 'http://127.0.0.1:9',
      testTimeout: 500,
      downloadSource: { mode: 'custom', customPrefix: 'http://127.0.0.1:9/' },
    }
    const term = createTerminal(<App config={config} version="test" mode="rule" />, {
      columns: 110,
      rows: 34,
    })
    terminals.push(term)
    await delay(150)
    term.press('6')
    await delay(150)
    const text = textOf(term.frames())
    expect(text).toContain('◆ 设置')
    expect(text).toContain('17890')
    expect(text).toContain('▌ 混合端口')

    term.press('\x1b') // 设置页 ESC：弹退出确认（分级退出语义不变）
    await delay(150)
    expect(textOf(term.frames())).toContain('确认退出？')
    term.press('n')
    await delay(150)
    expect(textOf(term.frames())).toContain('◆ 设置') // 取消后回到设置页
    term.instance.unmount()
  })
})
