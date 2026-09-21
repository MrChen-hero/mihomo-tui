# UI 一致性收口规范（Level 2 Concise Spec）

**日期：** 2026-09-22
**状态：** 待批准
**前作：** `docs/specs/2026-09-13-ui-theme-spec.md`（主题/Panel/FooterLine/语义色已建立）
**参考：** `references/mihari`（lipgloss 设计系统）、`references/cc-switch`（卡片确认语言）

---

## 1. 目标与范围

上一轮美化建立了主题与组件（`theme.ts`、`Panel`、`FooterLine`、`StatusDot`），但落地后**各页/各对话框之间仍有残留的视觉语言分歧**。本期做**一致性收口**：把分歧点收敛到统一的组件与约定上，不引入新视觉概念。

**约束（用户已确认）：**
- **保持终端绿主题**：`theme.ts` 色值一律不动
- **不动整体布局**：不改标签页结构、不改双栏/单栏切换、不改分区划分
- **只动展示层**：不改任何键位行为、数据流、API 调用与事务逻辑

## 2. 非目标

- 不新增视觉概念（不做左侧导航 Rail、不做实底 chip、不做 sparkline）
- 不换配色、不调 theme token
- 不改组件的对外键位与交互行为
- 不重构 hooks / config / api 层

## 3. 收口点（现状分歧 → 统一目标）

### 3.1 行焦点指示符统一 ⭐ 核心分歧

**现状分歧：** 节点页用 `▌`（本栏焦点）/`❯`（驻留光标）；设置页与 ListDialog 用 `❯` 作焦点。同一 app 两套光标语言。

**统一目标：** 全 app 行焦点只用一种语义，分层表达（沿用节点页已建立、且对 CJK 友好的方案）：

| 符号 | 语义 | 颜色 | 出现处 |
|---|---|---|---|
| `▌` | **键盘焦点行**（当前可操作的行） | accent | 节点页双栏、设置页可操作行、ListDialog 光标行 |
| `❯` | **驻留光标**（焦点在另一栏/非激活时的光标驻留位） | muted | 仅节点页双栏的另一栏 |
| `●` | **业务选中**（当前在用节点/被 PROXY 选中的组） | accent 加粗 | 节点页、订阅页当前项 |
| 空格 | 普通行 | — | 全部 |

- **设置页**：`❯ ` 焦点前缀改 `▌ `（accent），行选中样式 `rowSelected` 保留
- **ListDialog**：`❯ ` 光标改 `▌ `（accent），与节点页焦点一致
- **节点页**：维持现状（已是目标形态）
- 纯函数 `rowBar`/`rowBarColor` 从 `Proxies.tsx` 提升到 `src/ui/` 供三处复用，消除重复实现

### 3.2 ProgressDialog 边框语言对齐

**现状分歧：** InputDialog/ConfirmDialog/ListDialog 均用 Panel 同款「内嵌边框标题」（`╭─ 标题 ──╮`），唯 ProgressDialog 用普通 round 边框 + 首行粗体标题。

**统一目标：** ProgressDialog 改为 Panel 同款顶线语言（`panelTopParts`），标题嵌入边框，与其它三个对话框一致。进度条、步骤计数、已完成清单等内容与配色不变。

### 3.3 分区标题组件统一

**现状分歧：** 设置页用 `styles.tableHeader` 渲染分区标题（`  基础设置`），日志/连接页状态行也用 `tableHeader`，但前者是「区块标题」、后者是「状态行」，语义不同却同样式，且设置页分区间留白靠手写 `height={1}` Box。

**统一目标：** 新增 `SectionHeader` 组件（`src/ui/SectionHeader.tsx`）：
- 文本 = `▍ 标题`（accent 色 `▍` + tableHeader 文本），与状态行视觉区分
- 自带「与上区间隔一行」的节奏（组件内 `marginTop`，调用方不再手写空行 Box；首个分区不加）
- 仅设置页使用；日志/连接页状态行维持 `tableHeader`（它们是状态行不是分区标题，不在此列）

### 3.4 空态/加载态文案统一

**现状分歧：** 空态符号混用 `…`、`—`、`（空）`、`等待日志…`、`请先选择代理组`，无统一约定。

**统一目标：** 约定三档（纯文案与符号约定，集中写在 `theme.ts` 注释，组件处复用常量）：

| 场景 | 符号 | 色 | 示例 |
|---|---|---|---|
| 占位/无值 | `—` | muted | 设置页只读行无值 |
| 加载中 | `…` | muted | 值未取到 |
| 列表空态 | 完整短句 | dim | `当前无活跃连接`（保留各页现有短句，仅统一加 dim） |

不强行统一各页的具体空态短句（它们承担引导作用），只统一符号与着色。

## 4. 组件职责

- `src/ui/rowIndicator.ts`（新）：`rowBar`/`rowBarColor` 纯函数（自 Proxies.tsx 提升），供节点页/设置页/ListDialog 复用
- `src/ui/SectionHeader.tsx`（新）：分区标题组件（设置页用）
- `src/components/ProgressDialog.tsx`：改 Panel 顶线语言
- `src/views/Settings.tsx`：焦点前缀 `❯`→`▌`、分区标题换 `SectionHeader`
- `src/components/ListDialog.tsx`：光标 `❯`→`▌`
- `src/views/Proxies.tsx`：`rowBar`/`rowBarColor` 改为从 `ui/` 导入（删除本地实现）
- `theme.ts`：补三段符号约定注释（不改任何值）

## 5. 边界与回归红线

- **CJK/emoji 宽度**：`▌` 属 ambiguous 宽字符，沿用节点页既有纪律——依赖行内余量吸收，不改任何宽度计算逻辑
- **键位零改动**：所有 `useInput` 分支、按键字节处理不变；本 spec 只换渲染符号与样式
- **窄终端**：不触碰任何窄宽降级逻辑（FooterLine 丢段、Panel<20 退化、单栏切换均保持）
- **回归红线**：全量 `npm test` 通过（改样式断言的测试逐条更新）；`npm run typecheck` 与 `npm run build` 通过

## Execution Checkpoints

- [ ] 1. `rowIndicator.ts` 提升 `rowBar`/`rowBarColor` 纯函数 + 单测；Proxies 改为导入复用
- [ ] 2. 设置页/ListDialog 焦点符号 `❯`→`▌`，统一行焦点语言
- [ ] 3. `SectionHeader` 组件落地并接入设置页分区标题
- [ ] 4. ProgressDialog 改 Panel 顶线语言，与其它对话框一致
- [ ] 5. 空态符号约定写入 theme.ts 注释，各页符号/着色对齐
- [ ] 6. 全量 `npm test` + `npm run typecheck` + `npm run build` 通过；逐页 pty 截屏人工验收

## 验证

1. 新增：`rowIndicator` 纯函数单测（焦点/驻留/普通三态与颜色映射）
2. 回归：全量 `npm test`、`npm run typecheck`、`npm run build` 通过（样式断言测试逐条更新）
3. 人工：pty 逐页截屏（节点/订阅/设置 + 打开 ListDialog/ProgressDialog），对照本 spec §3 验收——焦点符号全 app 一致、ProgressDialog 边框与其它对话框一致、分区标题与状态行可区分
