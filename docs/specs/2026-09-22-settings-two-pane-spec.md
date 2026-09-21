# 设置页双栏改版规范（Level 2 Concise Spec）

**日期：** 2026-09-22
**状态：** 待批准
**关联：** 叠加于 `docs/specs/2026-09-22-ui-consistency-spec.md`（一致性收口）之上；本规格只覆盖设置页结构改版
**参考：** 节点页双栏机制 `src/views/Proxies.tsx`、`src/ui/Panel.tsx`

---

## 1. 目标与范围

把设置页从「单列居中卡片（`◆ 设置`）」改为**与节点页一致的左侧导航 + 右侧面板双栏布局**：

- **左栏（导航）**：`◆ 设置` 下的设置项列表，分「基础设置 / mihomo 内核」两组，光标在可操作项间移动
- **右栏（配置面板）**：随左侧导航切到当前项，展示该项的**可点改配置行**——每一行都可被选中并按 Enter 修改（语义同左栏 Enter），把原来单行压缩的信息展开成更丰富的面板

**约束（用户已确认）：**
- 保持终端绿主题，`theme.ts` 色值不动
- 复用节点页双栏机制（含左右栏焦点模型），不新造布局原语
- 12 个对话框流程（port/logLevel/confirm/version/install/source 等）的**触发逻辑、传参、回调完全不变**；Enter 无论落在左栏还是右栏，都进入同一对话框
- 只动 Settings 视图层与展示组件；hooks/config/api 零改动

## 2. 非目标

- 不改动任一设置项的写入事务、`applySettings`、内核安装流程
- 不改设置项的集合、分组归属、校验规则
- 不做设置项的增删、不做搜索/过滤
- 右栏不做「就地编辑」（不内嵌输入框/可选值列表直接改）——修改仍走既有对话框，右栏行只是**入口与信息展示**

## 3. 关键设计决策

### 3.1 焦点模型：左右栏可切换（复用节点页）

用户确认「右栏行也可点改」，故引入节点页的左右栏焦点模型：

| 键 | 左栏（导航） | 右栏（配置面板） |
|---|---|---|
| `↑↓`/`jk` | 在可操作项间移动（`ACTIONABLE`，跳过只读项），**同时右栏切到该项** | 在该项的可点改行间移动 |
| `←→`/`hl` | — | 左右栏焦点互切 |
| `Enter` | 进入当前项的对话框 | 等价于左栏 Enter：进入该项对话框 |

- 焦点归属用 `focus: 'nav' | 'panel'` 状态（同节点页 `focus: 'groups' | 'nodes'`）
- **只读项**（外部控制、当前版本）在左栏显示但不落焦点；其详情在右栏展示但行不可选（无 Enter 行为）
- 左栏光标移动 → 右栏同步切换；右栏光标在切项后归零到首行

### 3.2 右栏配置面板：每行可点改

当前项在右栏展开为若干「配置行」，每行 = 标签 + 内容，**该行可被光标选中并按 Enter 进入修改**（等价左栏 Enter）：

```
╭─ 混合端口 ───────────────────────────╮
│ ▌ 当前值   7890                       │  ← 可点改行（焦点行 accent ▌）
│   说明     HTTP/SOCKS 混合代理端口     │  ← 说明行（斜体+dim，仍可选中）
│   取值     1024 – 65535               │
│   影响     写配置并重启，瞬断数秒      │
╰───────────────────────────────────────╯
```

- **统一行结构**：每行 `标签列（padDisplay 对齐）+ 内容`，标签含 `当前值/说明/取值/影响`
- **行数精简**：信息行（说明/取值/影响）也是可点改行的一部分——它们同样触发该项的修改对话框。这样「右栏每一行都可操作」成立，无需额外的「[Enter] 修改」伪行
- 只读项（外部控制/当前版本）右栏行显示 `当前值 + 说明`，行 dim 且不可选

### 3.3 文字层次：终端无字号，用斜体+dim 区分

终端（ink）无字体大小概念，所有字符同一单元格。「说明类文字缩小字体」落地为：

| 内容 | 样式 |
|---|---|
| 当前值 | 现有语义色（开=success/关=muted/版本/端口默认色） |
| 说明 | **斜体 + dim**（`italic dimColor`，最接近「缩小字体」的层次弱化） |
| 取值/影响 | dim（非斜体，与说明区分） |
| 焦点行 | accent `▌` 前缀 + 标签 `rowSelected` |

### 3.4 布局：复用节点页双栏机制

```
╭─ ◆ 设置 ──────────────╮╭─ 混合端口 ─────────────────────────────╮
│ 基础设置               ││ ▌ 当前值   7890                         │
│ ▌ 混合端口      7890   ││   说明     HTTP/SOCKS 混合代理端口       │
│   允许局域网    开     ││   取值     1024 – 65535                  │
│   ...                  ││   影响     写配置并重启，瞬断数秒        │
│ mihomo 内核            ││                                       │
│   切换版本      v1.19  ││   （↑↓ 在本面板行间移动，Enter 修改）    │
╰────────────────────────╯╰────────────────────────────────────────╯
```

- 外层 `<Box flexDirection="row" flexGrow={1}>`，左右各套 `Panel fillHeight`（同节点页）
- **左栏宽**：`Math.min(34, Math.floor(width * 0.34))`；**右栏宽**：`width - 左栏宽 - 2`（沿用节点页 pty 折行规避）
- **窄屏降级**（`width < 100`）：只显示当前焦点栏（同节点页 `narrow` 机制），右栏被隐藏时左栏导航照常，Enter 弹框不受影响
- 底部 `FooterLine` 页脚：`↑↓ 移动 / ←→ 切栏 / Enter 修改`

### 3.5 左栏行渲染

左栏每行 = 焦点符 + 标签 + 当前值缩写（详情挪到右栏，故左栏更紧凑）：

- **焦点符**：`▌`（accent，本栏焦点时）/ `❯`（muted，焦点在右栏时的驻留位）—— 完全复用节点页 `rowBar` 语义
- **分区标题**：「基础设置」「mihomo 内核」为不可选分组头（dim，跳过焦点），样式用一致性收口的 `SectionHeader`（同期落地）或暂 `tableHeader`
- **当前值缩写**：开关类 `开/关`、版本号、端口等短值，超长 `displayWidth` 截断

## 4. 数据结构变更

`RowDef` 扩充两个可选字段（驱动右栏面板）：

```ts
interface RowDef {
  key: RowKey
  label: string
  editable: boolean
  section: '基础设置' | 'mihomo 内核'
  /** 右栏「说明」行 */
  description?: string
  /** 右栏「取值」行（合法范围/可选值/开关枚举） */
  constraint?: string
}
```

12 行的 `description`/`constraint` 常量一次性补齐，写死视图层，不进 config。

新增纯函数（可测）：

- `panelLines(row: RowDef, value: {text,color?}, impact: string | undefined): PanelLine[]` — 把一项收敛为右栏配置行列表（`当前值/说明/取值/影响`，缺省省略），每行带 `editable` 标记（只读项的行不可选）
- 复用现有 `valueOf`/`boolText`/`prettyPath`，不重写取值逻辑

## 5. 组件职责

- `src/views/Settings.tsx`：重写渲染层为双栏；新增 `focus: 'nav' | 'panel'` 状态、`panelCursor` 状态、`RowDef.description/constraint` 常量、`panelLines` 纯函数；`↑↓`/`←→`/`Enter` 按焦点模型分派
- `src/ui/Panel.tsx`：复用，不改
- 对话框组件（Input/Confirm/List/Progress）：**零改动**，触发逻辑不变
- 状态/数据流：`values`/`update`/`releases`/模块级缓存、`reload`/`applyNow`/`checkUpdate` 等**全部不动**

## 6. 焦点与状态流转

```
非对话框态（active && !dialog）：
  ←→/hl     → focus 在 nav/panel 间切换（panel 仅在当前项 editable 时可入）
  ↑↓/jk     → nav：moveCursor（ACTIONABLE 内）→ 右栏切项 + panelCursor 归零
              panel：panelCursor 在该项配置行间移动（仅 editable 行可选）
  Enter     → nav：onRowEnter(ACTIONABLE[navCursor])
              panel：onRowEnter(当前项)（与 nav 同入口，同对话框）
对话框态：
  useInput 让路（现状不变），对话框独占
```

- 初始：`focus='nav'`、navCursor=0（混合端口）、右栏显示混合端口、panelCursor=0

## 7. 边界与回归红线

- **窄终端**（<100 列）：只显示当前焦点栏；右栏隐藏时左栏导航 + Enter 弹框不受影响
- **CJK/emoji**：`▌` ambiguous 宽度沿用行内余量吸收；右栏说明/影响文案按 `displayWidth` 折行或截断
- **矮终端**（body < 20 行）：沿用 `spacious` 降级，右栏各行紧凑排布
- **加载中**：`values === undefined` 时左栏值显示 `…`，右栏「当前值」行显示 `…`，说明/取值行正常
- **斜体降级**：`italic` 在不支持的终端静默无效（ink/终端能力决定），不破坏布局
- **回归红线**：
  - 12 个对话框流程的触发、传参、回调**零改动**（`confirmFor`/`openVersionDialog`/`applyNow`/`runInstall`/`saveSource` 等不动）
  - 全量 `npm test` 通过（设置页断言逐条更新；新增 `panelLines` 单测）
  - `npm run typecheck` + `npm run build` 通过

## Execution Checkpoints

- [ ] 1. `RowDef` 补 `description/constraint`，12 行常量补齐；`panelLines` 纯函数 + 单测
- [ ] 2. 双栏布局落地：左右 Panel + row 容器 + fillHeight，复用节点页宽度/窄屏降级机制
- [ ] 3. 焦点模型：`focus: nav|panel` + `panelCursor`，`↑↓`/`←→`/`Enter` 按栏分派，光标移动同步右栏
- [ ] 4. 左栏行渲染（焦点符 `▌`/`❯` + 分组头跳焦点 + 值缩写）；右栏配置行渲染（标签对齐 + 说明斜体 dim + 行可点改）
- [ ] 5. 全量 `npm test` + `npm run typecheck` + `npm run build` 通过；110×34 / 80×24 两档 pty 截屏验收

## 验证

1. 新增：`panelLines` 纯函数单测（可操作项 4 行齐全且 editable、只读项行不可选、缺省字段省略）
2. 回归：全量 `npm test`（设置页断言更新）、`npm run typecheck`、`npm run build` 通过
3. 人工：pty 截屏验收——宽屏双栏、`←→` 切栏、左栏移动右栏同步、右栏行可选且 Enter 弹框、只读项不落焦点、窄屏（80 列）单栏降级、说明行斜体 dim 层次可辨
