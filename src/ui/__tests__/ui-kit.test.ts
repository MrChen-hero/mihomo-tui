/**
 * UI 组件库纯函数测试：主题 token、面板标题行宽度、页脚降级策略、状态语义。
 */
import { describe, expect, it } from 'vitest'
import { colors, styles, toneColor } from '../theme.js'
import { MIN_PANEL_WIDTH, panelTopLine, panelTopParts } from '../Panel.js'
import { fitFooterHints, footerWidth, type FooterHint } from '../FooterLine.js'
import { statusText, TAB_CELL_CAP, tabCells, tabRowText, topBarGap } from '../TopBar.js'
import { displayWidth } from '../../commands/output.js'

describe('theme 终端绿配色', () => {
  it('token 为约定的 256 色值（终端绿身份，不与参考项目重色）', () => {
    expect(colors.accent).toBe('ansi256(40)')
    expect(colors.success).toBe('ansi256(71)')
    expect(colors.warning).toBe('ansi256(184)')
    expect(colors.danger).toBe('ansi256(160)')
    expect(colors.info).toBe('ansi256(73)')
    expect(colors.muted).toBe('ansi256(244)')
    expect(colors.surfaceBorder).toBe('ansi256(238)')
  })

  it('不得混入参考项目的色值（mihari 63/78/214/203/75）', () => {
    const banned = ['ansi256(63)', 'ansi256(78)', 'ansi256(214)', 'ansi256(203)', 'ansi256(75)']
    for (const value of Object.values(colors)) {
      expect(banned).not.toContain(value)
    }
  })

  it('toneColor 四档语义映射', () => {
    expect(toneColor.positive).toBe(colors.success)
    expect(toneColor.caution).toBe(colors.warning)
    expect(toneColor.negative).toBe(colors.danger)
    expect(toneColor.neutral).toBe(colors.muted)
  })

  it('角色样式与 colors 同源', () => {
    expect(styles.panelTitle.color).toBe(colors.accent)
    expect(styles.keyCap.color).toBe(colors.accent)
    expect(styles.rowFocus.color).toBe(colors.accent)
    expect(styles.rowSelected.bold).toBe(true)
  })
})

describe('panelTopLine 内嵌标题边框行', () => {
  it('ASCII 标题：总宽度恰为 width 列', () => {
    const line = panelTopLine('Proxies', 40)
    expect(line).toMatch(/^╭─ Proxies ─+╮$/)
    expect(displayWidth(line)).toBe(40)
  })

  it('CJK 标题按显示宽度补齐（代理组占 6 列）', () => {
    const line = panelTopLine('代理组', 40)
    expect(line.startsWith('╭─ 代理组')).toBe(true)
    expect(line.endsWith('╮')).toBe(true)
    expect(displayWidth(line)).toBe(40)
  })

  it(`窄于 ${MIN_PANEL_WIDTH} 列退化为无标题的纯边框行`, () => {
    const line = panelTopLine('代理组', 12)
    expect(line).toBe('╭' + '─'.repeat(10) + '╮')
    expect(panelTopParts('代理组', 12)).toEqual({ title: '代理组', tail: '╮' })
  })

  it('超长标题按显示宽截断，顶线不超 width', () => {
    const longTitle = '一'.repeat(12) // 显示宽 24
    const parts = panelTopParts(longTitle, 20)
    expect(displayWidth(parts.title)).toBeLessThanOrEqual(14)
    expect(displayWidth(panelTopLine(longTitle, 20))).toBe(20)
    expect(parts.title.endsWith('…')).toBe(true)
  })

  it('极窄宽度不产生负重复，返回合法字符串', () => {
    expect(panelTopLine('x', 2)).toBe('╭╮')
    expect(typeof panelTopLine('x', 1)).toBe('string')
  })
})

describe('tabCells 标签均布', () => {
  const TABS = ['节点', '订阅', '日志', '连接']

  it('格宽封顶 TAB_CELL_CAP，标签在格内居中', () => {
    const cells = tabCells(TABS, 0, 100)
    expect(cells).not.toBeNull()
    // floor(100/4)=25 超上限 → 封顶 16
    for (const c of cells!) expect(displayWidth(c.text)).toBe(TAB_CELL_CAP)
    // 选中格标签 '节点' 显示宽 4，pad 8，左 4 右 4
    expect(cells![0]!.text.trim()).toBe('节点')
    const text0 = cells![0]!.text
    const leadingSpaces = text0.length - text0.trimStart().length
    const trailingSpaces = text0.length - text0.trimEnd().length
    expect(leadingSpaces).toBeGreaterThanOrEqual(3)
    expect(trailingSpaces).toBeGreaterThanOrEqual(3)
    expect(cells![0]!.active).toBe(true)
    expect(cells![1]!.active).toBe(false)
  })

  it('标签数量增减自适应格宽：超过上限封顶，低于上限按均分', () => {
    // 3 个标签 42 列：floor(14) > CAP → 格宽封顶 10
    const three = tabCells(TABS.slice(0, 3), 1, 42)
    expect(three).not.toBeNull()
    for (const c of three!) expect(displayWidth(c.text)).toBe(TAB_CELL_CAP)
    // 未来顶栏加标签：5 个标签在 100 列自动重算为 10（封顶）
    const five = tabCells([...TABS, '设置'], 4, 100)
    expect(five).not.toBeNull()
    for (const c of five!) expect(displayWidth(c.text)).toBe(TAB_CELL_CAP)
  })

  it('格宽装不下最宽标签时返回 null（回退紧凑布局）', () => {
    // '❯ 1 节点' 显示宽 8，均分后格宽 2 → 回退
    expect(tabCells(TABS, 0, 8)).toBeNull()
  })

  it('空标签表返回 null（守卫除零，走紧凑回退）', () => {
    expect(tabCells([], 0, 100)).toBeNull()
  })

  it('标签块居中：块外留白分两侧且和 = 剩余列', () => {
    // TopBar 渲染逻辑的镜像计算：4 标签封顶格宽 12 → 块宽 48，avail 92 → 两侧各 22
    const cells = tabCells(TABS, 0, 92)!
    const blockWidth = cells.length * TAB_CELL_CAP
    const extra = 92 - blockWidth
    expect(blockWidth).toBe(TABS.length * TAB_CELL_CAP)
    expect(extra).toBe(44)
    expect(Math.floor(extra / 2)).toBe(22)
    expect(extra - Math.floor(extra / 2)).toBe(22)
  })
})

describe('TopBar 顶栏纯函数', () => {
  const tabs = ['节点', '订阅', '日志', '连接'] as const

  it('tabRowText：无数字，2 空格分隔', () => {
    const row = tabRowText(tabs, 0)
    expect(row).toBe('节点  订阅  日志  连接')
  })

  it('statusText：模式 · 端口 + 状态点', () => {
    expect(statusText('规则', '19090')).toBe('规则 · 19090 ●')
  })

  it('topBarGap：左分组 + 间隙 + 右分组 = 内宽', () => {
    const gap = topBarGap(tabs, 0, '规则', '19090', 100)
    expect(gap).toBeGreaterThanOrEqual(1)
    const left = displayWidth(tabRowText(tabs, 0))
    const right = displayWidth(statusText('规则', '19090'))
    expect(left + gap + right).toBe(100)
  })

  it('topBarGap：极窄时至少保留 1 列间隙', () => {
    expect(topBarGap(tabs, 0, '规则', '19090', 10)).toBe(1)
  })
})

describe('FooterLine 页脚降级', () => {
  const hints: FooterHint[] = [
    { key: '↑↓', label: '移动' },
    { key: '←→', label: '切栏' },
    { key: 'Enter', label: '选用' },
    { key: 't', label: '测速' },
    { key: 'v', label: '只看可用' },
    { key: 'r', label: '刷新' },
    { key: 'q', label: '退出' },
  ]

  it('footerWidth 按 CJK 显示宽计算', () => {
    // ↑↓(2)+1+移动(4) + 2 + q(1)+1+退出(4) = 15
    expect(footerWidth([{ key: '↑↓', label: '移动' }, { key: 'q', label: '退出' }])).toBe(15)
  })

  it('宽度充足时全保留', () => {
    expect(fitFooterHints(hints, 500)).toEqual(hints)
  })

  it('宽度不足时从中间开始丢，首段其次，永远保底最后一段', () => {
    const fitted = fitFooterHints(hints, 20)
    expect(fitted.at(-1)).toBe(hints.at(-1)) // q 退出 保底
    expect(fitted.length).toBeLessThan(hints.length)
    // 只剩两段仍超宽时丢首段；保底段超宽时 label 硬截断为 …
    const extreme = fitFooterHints(hints, 4)
    expect(extreme).toEqual([{ key: 'q', label: '…' }])
  })

  it('两段页脚同样受宽度检查约束（不再绕过）', () => {
    const two: FooterHint[] = [
      { key: 'Enter', label: '确认' },
      { key: 'ESC', label: '取消' },
    ]
    expect(fitFooterHints(two, 10)).toEqual([two[1]])
    expect(fitFooterHints(two, 500)).toEqual(two)
  })

  it('保底段也放不下时对 label 做硬截断', () => {
    const fitted = fitFooterHints([{ key: 'q', label: '退出' }], 4)
    expect(footerWidth(fitted, undefined)).toBeLessThanOrEqual(4)
    expect(fitted[0]!.key).toBe('q')
  })
})
