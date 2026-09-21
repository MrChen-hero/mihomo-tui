/**
 * 设置页双栏右侧面板纯函数 panelLines（spec 2026-09-22 settings-two-pane §4）。
 * 只测纯函数，不渲染——行序、缺省省略、可点改标记、影响段回退。
 */
import { describe, expect, it } from 'vitest'
import { panelLines, type PanelLine } from '../views/Settings.js'
import type { RowDef } from '../views/Settings.js'

const editableRow: RowDef = {
  key: 'port',
  label: '混合端口',
  editable: true,
  section: '基础设置',
  description: 'HTTP/SOCKS 混合代理监听端口',
  constraint: '1024 – 65535',
}

const readOnlyRow: RowDef = {
  key: 'controller',
  label: '外部控制',
  editable: false,
  section: '基础设置',
  description: 'External Controller 地址',
}

function labels(lines: PanelLine[]): string[] {
  return lines.map((line) => line.label)
}

describe('panelLines', () => {
  it('可操作项四行齐全，行序固定为 当前值→说明→取值→影响，全部可点改', () => {
    const lines = panelLines(editableRow, { text: '7890' })
    expect(labels(lines)).toEqual(['当前值', '说明', '取值', '影响'])
    expect(lines.every((line) => line.editable)).toBe(true)
    // 基础设置可编辑项无定制 impact 时回退 IMPACT
    expect(lines.find((l) => l.label === '影响')?.text).toContain('重启服务')
    // 当前值行用传入语义色，说明/取值/影响 dim
    expect(lines[0]?.color).toBeUndefined()
    expect(lines.find((l) => l.label === '说明')?.italic).toBe(true)
    expect(lines.find((l) => l.label === '取值')?.italic).toBeUndefined()
  })

  it('只读项行不可选，且无影响行', () => {
    const lines = panelLines(readOnlyRow, { text: '127.0.0.1:19090' })
    expect(lines.every((line) => !line.editable)).toBe(true)
    expect(labels(lines)).toEqual(['当前值', '说明']) // 只读项无取值/影响
  })

  it('缺省字段省略：无说明/取值/影响时不出现对应行', () => {
    const minimal: RowDef = { key: 'version', label: '当前版本', editable: false, section: 'mihomo 内核' }
    const lines = panelLines(minimal, { text: 'v1.19.24' })
    expect(labels(lines)).toEqual(['当前值'])
  })

  it('内核区可编辑项用定制 impact（不回退基础设置 IMPACT）', () => {
    const kernelRow: RowDef = {
      key: 'switch',
      label: '切换版本',
      editable: true,
      section: 'mihomo 内核',
      impact: '下载 → 校验 → 替换二进制 → 重启服务',
    }
    const lines = panelLines(kernelRow, { text: 'v1.19.24' })
    const impact = lines.find((l) => l.label === '影响')
    expect(impact?.text).toContain('替换二进制')
    expect(impact?.text).not.toContain('活动连接会瞬断')
  })

  it('当前值行的着色透传（如开关行的 success/muted）', () => {
    const lines = panelLines(editableRow, { text: '开', color: 'green' })
    expect(lines[0]?.color).toBe('green')
  })
})
