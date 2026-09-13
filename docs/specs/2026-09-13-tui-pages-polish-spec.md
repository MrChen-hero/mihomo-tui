# TUI 页面打磨：面板等高、顶栏均布、[] 切换、日志/连接页 Panel 化

日期：2026-09-13 · 级别：Level 2 · 前置：终端绿主题（be57b08）与分级 ESC（9b50727）已完成

## 1. 目标与范围

四项视图层打磨，全部沿用已建立的组件范式（Panel/FooterLine/rowFocus/tableHeader/keyCapture）：

1. **[1] 节点页双栏等高**：代理组面板的外框高度与节点面板齐平（当前组少时右下角缺一块）
2. **顶栏标签均匀铺满并居中**：`1 节点 2 订阅 3 日志 4 连接` 在卡片内均匀分布、逐格居中，标签数量增减自适应（未来加顶栏功能自动铺平）
3. **顶栏 `[` / `]` 切换**：`[` 向左切一个标签、`]` 向右切，Tab 循环行为不变（cc-switch 为 GUI 无键位切换可抄，`[]` 为 TUI 惯例）
4. **[3] 日志页 / [4] 连接页 Panel 化**：对齐 [2] 订阅页的设计——全宽内嵌标题 Panel + tableHeader 行 + 语义色

不做：状态栏、对话框、订阅页的进一步改动；无数据层/键位处理逻辑变化（新增 `[`/`]` 两个全局键除外）。

## 2. 设计

### 2.1 双栏等高（`src/ui/Panel.tsx` + `src/views/Proxies.tsx`）

- `Panel` 新增可选 `fillHeight?: boolean`：为 true 时内层 bordered Box 追加 `flexGrow={1}`（不影响既有调用方，缺省 false）
- 节点页双栏的行容器本就 `alignItems` 拉伸（ink 默认），组面板 `fillHeight` 后其底边与节点面板底边**齐平**；组列表内容仍顶部对齐，空隙留在框内
- 窄屏单栏模式同样启用 fillHeight（面板撑满 body，观感一致）

### 2.2 顶栏标签均布（`src/ui/TopBar.tsx`）

- 纯函数 `tabCells(tabs, active, availWidth): { text: string; active: boolean }[]`：
  - 每格宽度 `floor(availWidth / tabs.length)`，标签文本（选中 `❯ N 名` / 非选中 `N 名`）在格内**居中**（左_pad = floor((cellW-labelW)/2)，padDisplay 语义）
  - 标签数量增减 → 格宽自动重算（自适应未来顶栏扩展）
- 布局：`tabsAvail = 内宽 - 右侧状态段宽`；渲染 = 各格拼接 + 剩余列补齐 + 右侧状态段（`规则 · 19090 ●`）
- **降级**：按格校验 `格宽 < 最宽标签显示宽 + 1`（每格容下最宽标签且至少留 1 列间隙的充分条件，足以保证逐格不溢出）时回退现有紧凑布局（左对齐 + topBarGap），避免挤压错位
- 选中格仍 accent+bold，非选中 muted；现有 topBarGap 在降级分支继续使用

### 2.3 `[` / `]` 切换（`src/App.tsx`）

- 全局 useInput 新增：`[` → `setTab((t) => (t + TABS.length - 1) % TABS.length)`，`]` → `(t + 1) % TABS.length`（与 Tab 同为循环式）；位于 keysCaptured 闸门之后，对话框/编辑态不响应
- App 页脚提示 `Tab 循环` → `Tab/[] 循环`（键帽数 3 不变）

### 2.4 [3]/[4] 页 Panel 化（`src/views/Logs.tsx` / `src/views/Conns.tsx`）

- **日志**：`<Panel title={`日志 · ${level}`} fillHeight>` 包裹；面板内首行为 tableHeader 样式状态行：`⏸ 已暂停（Space 继续） · 过滤 /xxx · 缓冲 N/1000 · 已滚过 M`（dim；⏸ 用 warning 色；无过滤/滚过时省略对应段）；日志行渲染与级别语义色不变（无行选中标记——日志无光标）；空态文案保留
- **连接**：`<Panel title={`连接 · ${conns.length}`} fillHeight>` 包裹现有表头+列表（表头已是 tableHeader、行已有 ▌ rowFocus 与 success 速率列）；累计行 `共 N 条 累计 ↑↓ 排序` 与 D 确认 danger Panel 保留在面板下方
- 高度预算：两页 listHeight 各减 2（Panel 顶线+底边）

## 3. 组件职责与数据流

- `Panel.fillHeight` 是唯一新增组件 API，纯展示；`tabCells` 为纯函数（可测），TopBar 其余逻辑不动
- `[`/`]` 只动 App 全局 handler（新增两个分支），各视图/对话框按键处理零改动
- 键位登记（keyCapture）体系不受影响

## 4. 边界与回归红线

- 顶栏降级分支保证极窄终端不破版；`tabCells` 单元测试覆盖 4/3/5 个标签与窄宽回退
- Panel 既有调用方（TopBar/对话框/订阅页/退出确认）不传 fillHeight，行为零变化
- 回归红线：全部 useInput 分支除新增 `[`/`]` 外逐字节不变；全量测试与 build 必须通过

## 5. Execution Checkpoints

- [x] 1. Panel `fillHeight` + 节点页双栏等高；pty 验证组/节点面板底边齐平 → 子代理审查
- [x] 2. 顶栏 `tabCells` 均布居中（纯函数+测试）+ `[`/`]` 切换与页脚提示 → 子代理审查
- [x] 3. 日志页/连接页 Panel 化对齐订阅页设计；两档宽度 pty 验收 → 子代理审查
- [x] 4. 全量 `npm test` + `npm run build` + 终审 → 提交

## 6. 验证

1. 新增单测：`tabCells` 格宽/居中/降级回退；Panel fillHeight 无 fillHeight 时的回归（既有 ui-kit 测试不变）
2. 回归：全量 236 项测试 + build；app-esc 6 项（键位体系）
3. 人工：pty 两档宽度四页截屏——组/节点底边齐平、顶栏均布、[3]/[4] 面板化观感

## 7. 遗留备忘（审查通过后登记，均非阻塞）

- 日志/连接列表满载时面板内容区留 1 行余量（与改造前行为一致，非回归）；未来想榨满 flexGrow 空间可再收 1 行预算
- 退出确认框键帽沿用 ConfirmDialog 标准件 `Enter/y 确认 · n/Esc 取消`，与 esc spec §3 文案 `Enter 确认退出 · ESC 取消` 存在字面偏差，归前置 spec 范畴
- pty 驱动脚本在进程退出后保留末帧，「退出后空屏」无法从截图直接证据化（exit status 0 与 app-esc 单测已覆盖）
