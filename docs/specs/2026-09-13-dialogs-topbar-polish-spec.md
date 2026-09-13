# 对话框打磨（确认框 cc-switch 化 + 输入框槽位化）+ 顶栏收紧 spec

日期：2026-09-13 · 级别：Level 2 · 前置：页面打磨 spec（40eaa84）已完成

## 1. 目标与范围

三项纯视觉打磨（用户验收驱动），键位行为、数据流、内核交互零变化：

1. **ConfirmDialog 视觉重构**：对齐 cc-switch 确认卡片——键帽反色块顶部居中、问题文案居中于中下部、上下大留白；退出确认与删除订阅确认两个调用方统一新范式
2. **InputDialog 槽位化**：对齐宽松结构——字段恒为内嵌标题槽位框（聚焦亮起/非聚焦退后），消灭非聚焦裸文本行；字段间与页脚留白对齐新范式
3. **顶栏标签收紧**：`tabCells` 格宽封顶 16 列、标签块整体居中，消除满铺均分导致的松散感（110 档每格 23 列、格内空隙 ~15 列）

不做：ProgressDialog/错误盒/Conns 内联 danger Panel、`tabCells` 极窄降级分支语义、任何 `useInput` 分支、输入编辑/粘贴/开窗逻辑。

## 2. 问题根因

- 现 `ConfirmDialog`：标题/文案/键帽三段左对齐、顶部堆叠、零垂直留白——视觉拥挤；cc-switch 参考图为键帽行（反色块）顶部居中 + 问题文案居中 + 大留白，无独立标题行
- 现 `InputDialog`：聚焦字段是 3 行边框盒、非聚焦字段是 1 行 dim 裸文本（`<my-airport>` 游离无容器）——同表单两套视觉语言，焦点切换时行数增减、下方内容跳动；字段间零间距，与宽松范式脱节
- 现顶栏 `tabCells`：`floor(availWidth/count)` 无上限满铺，宽终端格宽远超标签宽度，居中后变成稀疏大空隙

## 3. 设计

### 3.1 ConfirmDialog 新范式（`src/components/ConfirmDialog.tsx`）

```
╭──────────────────────────────────────────╮
│        [Enter 确认]  [Esc 取消]           │ ← 键帽反色块（Text inverse），顶部居中
│                                          │
│                确认退出？                 │ ← 主文案居中
│   内核服务不受影响，仍在后台运行           │ ← 说明行居中（dim）
│                                          │
╰──────────────────────────────────────────╯
```

- **键帽行**：顶部居中，两块 `Text inverse` 并排（块间两空格）。内容按 `enterConfirms` 切换：退出确认 `[Enter 确认] [Esc 取消]`、删除确认 `[y 确认] [n/Esc 取消]`；inverse 中性反色（不引入新色相），danger 语义仍由红边框 + 红文案承担
- **文案区**：主文案行居中，后续行居中且 dim（message 数组逐行渲染，首行默认色、其余 dimColor；danger 时全红不变）
- **留白**：`paddingY={2}` + 键帽行与文案间空行；内容区高度 ≈ 1 键帽 + 1 空行 + N 文案，总框高 80×24 下安全（body ~19 行 > 框高 ~10）
- **API 变更**：移除 `title` prop（cc-switch 无标题行）；调用方标题信息并入 message：
  - App 退出确认：`message={['确认退出？', '内核服务不受影响，仍在后台运行']}`
  - Providers 删除订阅确认：标题并入首行（如 `确认删除订阅 <name>？` + 后续说明行）
- 双轴居中由 App 现有模态独占逻辑承担，零改动；`useKeyCapture`/`useInput` 逻辑逐字节不变

### 3.2 InputDialog 槽位化（`src/components/InputDialog.tsx`）

设计语言：把 Panel 的内嵌标题边框**递归下沉到字段级**——每个字段恒为一个 mini-Panel 槽位，同一张卡片内三层退晕（外卡 accent 标题 → 字段槽 surfaceBorder/accent → 内容 dim/默认），整卡一种边框语言。

```
╭─ ◆ 添加订阅 ──────────────────────────────────────╮
│                                                    │
│  ╭─ 订阅名称 * ──────────────────────────────────╮ │ ← 非聚焦槽：surfaceBorder 暗灰框
│  │ my-airport                                    │ │   + dim 值/占位（恒有框，不再裸奔）
│  ╰───────────────────────────────────────────────╯ │
│  ╭─ 订阅 URL * ──────────────────────────────────╮ │
│  │ https://example.com/upload                    │ │
│  ╰───────────────────────────────────────────────╯ │
│  ╭─ 节点名前缀 ───────────────────────────────────╮ │ ← 聚焦槽：accent 框 + accent 标题
│  │ ▏<可选，如 [X]>                               │ │   + inverse 光标块；出错转 danger
│  ╰───────────────────────────────────────────────╯ │
│                                                    │
│  Enter 提交  ↑↓ 切换  Ctrl+U 清空  ESC 取消  支持整串粘贴 │
╰────────────────────────────────────────────────────╯
```

- **字段槽位恒 3 行**（内嵌标题顶线 + 内容行 + 底线），四态：
  - 聚焦：边框与内嵌标题 accent（label bold），`invalid` 时整体 danger（红框红标题）
  - 非聚焦：边框 surfaceBorder（暗灰退后），label 与内容 dim
  - readOnly：恒 surfaceBorder + dim，`（只读）` 标注随槽位标题渲染，永不高亮
  - secret：值掩码 `*` 逻辑不变
- **顶线自绘**：复用 `Panel.tsx` 已导出的 `panelTopParts`（标题截断/极窄降级逻辑同源），label 与 danger `*` 分色拼接；不新增组件文件（槽位渲染为 InputDialog 内部函数）
- **焦点指示去重**：移除标签行 `❯` 前缀——accent 边框本身即焦点指示，双重标记冗余
- **内容行**：聚焦态的 inverse 光标块、空值 `<placeholder>`、`inputWindow` 开窗滚动逐字节保留；非聚焦态值/占位 dim
- **留白**：字段组间 `marginTop={1}`；错误集中展示（⚠ 行）与 FooterLine 键帽页脚保持现结构，页脚前空一行
- **高度预算**：3 字段 ≈ 3×3 行 + 2 间隔 + 页脚区 2 行 + 可能 1 错误行 ≈ 14 行内容，80×24（body ~19 行）安全；卡片宽/居中降级（`min(64, max(44, width-8))`、<44 全宽）不变
- 键位：`useInput`/`usePaste`/`useKeyCapture` 全部逻辑逐字节不变，只动字段行 JSX

### 3.3 顶栏格宽封顶 + 标签块居中（`src/ui/TopBar.tsx`）

- 导出常量 `TAB_CELL_CAP = 16`；`tabCells` 内 `cellWidth = Math.min(Math.floor(availWidth / count), TAB_CELL_CAP)`
- 降级判断不变：实际格宽 `< 最宽标签显示宽 + 1` 时返回 null 走紧凑回退（CAP 不影响该语义）
- 留白改两侧分配（替代现「余数补中部」）：块宽 `cellWidth × count`，`leftPad = floor((availWidth - blockWidth) / 2)`，`rightGap = availWidth - blockWidth - leftPad`（整除余数自然并入两侧，标签块视觉居中）；原 `leftover` 逻辑删除
- 渲染：`leftPad` + 各格 + `rightGap` + 状态段（贴右不变）；极窄回退分支不动

## 4. 组件职责与数据流

- `ConfirmDialog` 只动 JSX 结构与 props，键位处理、keyCapture 登记、调用方回调零改动
- `InputDialog` 只动字段渲染 JSX（`renderValue` → 槽位三态），编辑/校验/粘贴/开窗纯函数（`inputWindow`/`sanitizeInput`/`validateField` 等）零改动
- `tabCells` 纯函数签名不变（`tabs, active, availWidth` → `TabCell[] | null`），内部加封顶；`topBarGap`/`statusText`/`tabRowText` 等降级分支函数不动

## 5. 边界与回归红线

- `dialogs.test.tsx` 中旧文案/结构断言逐条更新：ConfirmDialog（`Enter/y 确认  n/Esc 取消`、标题行）→ 新键帽/居中结构；InputDialog（`❯ 标签` 前缀、非聚焦裸占位行）→ 内嵌标题槽位断言；`app-esc.test.tsx` 退出确认流断言同步更新；所有按键行为断言本身必须原样通过
- 纪律：色值一律引 `src/ui/theme.ts`（`inverse` 是属性非色值）；文本宽度一律 `displayWidth` 系，禁 slice（槽位顶线拼接同受约束）
- 回归红线：全量测试与 build 通过；`tabCells` 既有 4/3/5 标签与空表用例在 CAP 下语义仍成立（100 列 5 标签格宽 20 > 16 触发封顶，断言改为 16 + 居中留白）

## 6. Execution Checkpoints

- [x] 1. ConfirmDialog 新布局 + 两调用方文案/props 更新 + dialogs/app-esc 测试逐条对齐 → 相关测试绿
- [x] 2. InputDialog 槽位化（四态槽位 + 顶线自绘 + 留白）+ dialogs/providers-flows 测试逐条对齐 → 相关测试绿
- [x] 3. `tabCells` 格宽封顶 + 标签块居中留白 + ui-kit 测试对齐 → 测试绿
- [x] 4. 全量 `npm test` + `npm run build` + pty 两档验收（退出框/删除框/添加订阅框新观感、顶栏紧凑、极窄回退不破版）→ 子代理审查 → 提交（feat/docs 分两笔）

## 7. 验证

1. 单测：`tabCells` 封顶格宽 16、左右留白和 = availWidth、CAP 下降级判断仍生效；dialogs 新结构断言（键帽反色块、槽位边框色、内嵌标题）
2. pty 两档（110×34 / 80×24）：主界面 ESC 弹新退出确认框、订阅页 d 打开删除确认框、订阅页 a 打开槽位化添加订阅框（含焦点切换后非聚焦槽退后观感）、顶栏标签块居中紧凑；键序以 ESC Enter 收尾
