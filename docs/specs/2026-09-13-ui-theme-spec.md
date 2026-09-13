# UI 美化与统一主题规范（Level 2 Concise Spec）

**日期：** 2026-09-13
**状态：** 待批准
**参考：** `references/mihari`（Go/Bubbletea 设计系统，抄设计不抄代码）、本机 cc-switch（ratatui）、`docs/specs/2026-08-17-subscription-management-design.md`

---

## 1. 目标与范围

把现有「能用但朴素」的界面升级为与 cc-switch/mihari 同源的视觉语言：语义化主题、内嵌标题卡片、键帽页脚、状态灯。**只动展示层**，不改任何键位行为、数据流与内核交互。

分两期实施，本期交付 P0 + P1：

- **P0 全局外壳**：`src/ui/theme.ts` 主题常量；App 顶栏卡片条；底部状态栏分组着色；各页页脚统一键帽组件与窄宽降级
- **P1 页面面板化**：[1] 节点页双栏加内嵌标题边框面板，键盘焦点与业务选中样式分离；[2] 订阅页表格加边框容器、流量使用率条、到期/错误语义色；[3] 日志 / [4] 连接页级别与速率语义色；四个对话框（Input/Confirm/Progress/Error）统一走 theme

**P2（本期不做，登记为后续）**：状态栏速率 sparkline、空态居中提示、ASCII banner。

## 2. 非目标

- 不更换框架（继续 ink 7 + React），不迁移 Bubbletea/ratatui
- 不改左侧导航结构（4 个页面用顶栏胶囊 tab 足够，页面增多再评估 rail）
- 不改任何按键行为、轮询逻辑、订阅事务与内核 API 调用
- 不引入新运行时依赖（纯自研组件，禁新增 npm 包）

## 3. 设计原则

1. **语义 token 唯一来源**：全部颜色来自 `theme.ts`，业务代码禁止硬编码色值（mihari 的核心纪律）
2. **颜色承载语义而非装饰**：青=焦点/交互、绿=健康/速率、黄=注意、红=错误/危险、灰暗=次要；「关闭/未知」是合法中性态用灰，只有「该开没开/故障」用红（mihari statusdot 哲学）
3. **内嵌标题卡片**：内容区块用 `┌ 标题 ───╮` 边框包裹，标题嵌在边框线上；对话框已是此风格，主界面向它看齐
4. **键帽统一**：快捷键提示一律「青色加粗键名 + dim 说明」，主界面页脚与对话框页脚同一组件

## 4. 设计细节

### 4.1 `src/ui/theme.ts`（新增）

**自有配色「终端绿」（不与参考项目重色）**。语义 token 与角色样式常量，全部 256 色终端安全值：

| token | 值 | 外观 | 用途 |
|---|---|---|---|
| accent | 40（#00d700） | 亮终端绿（磷光屏绿） | 焦点、标题、键名、选中指示 |
| success | 71（#5faf5f） | 中绿（苔绿） | 健康、存活数、上下行速率 |
| warning | 184（#d7d75f） | 橄榄黄 | 中等延迟、到期临近 |
| danger | 160（#d70000） | 正红 | 错误、危险、高延迟、过期 |
| info | 73（#5fafaf） | 青碧 | 信息性文本 |
| muted | 244（#808080） | 中灰 | 次要说明、占位符 |
| surfaceBorder | 238（#444444） | 暗灰 | 卡片边框（不抢焦点） |

与参考项目区分：mihari 用靛蓝 63/春绿 78/琥珀 214/珊瑚 203，cc-switch 与现 UI 用 ink 默认 cyan——本方案的焦点绿（40）与健康绿（71）同族不同亮度，形成「绿色磷光终端」的一致身份，四个彩色 token 无一与参考项目重合。

导出角色样式常量：`panelTitle`（边框内嵌标题）、`keyCap`（键名）、`keyHint`（键说明）、`rowFocus`（键盘焦点行：accent 前景 + `▌` 指示条，替代现有整行反色）、`rowSelected`（业务选中：如当前节点，加粗 + `●` 标记，与 rowFocus 可叠加）、`tableHeader`（dim 加粗）、`delayGood/Mid/Bad`（映射现有 DelayBadge 色阶到 token）。

### 4.2 全局外壳（`src/App.tsx`）

顶栏从纯文本行升级为单行卡片条；状态栏分组着色（结构不变）：

```
╭─ ◆ mihomo-tui ────────────────────────────────────────────────────╮
│ ❯ 1 节点   2 订阅   3 日志   4 连接              规则 · 19090 ●    │
╰───────────────────────────────────────────────────────────────────╯
（正文……）
 mihomo v1.19.24 │ ↑ 1.2 MB/s ↓ 8.4 MB/s(绿) │ mem 74.5 MB │ ● 已连接 [Y] 悦·🇹🇼台湾2
```

- 选中 tab：accent 加粗 + `❯`；非选中：muted
- 状态栏：版本/模式 dim，速率绿，内存 dim，断线时连接状态转红 `● 未连接`
- 分隔线 `─` 用 surfaceBorder 色

### 4.3 共享组件（`src/ui/` 新增，纯函数优先、可测）

- `Panel`：`borderStyle="round"` + 标题嵌边框第一行的容器（对齐 InputDialog 现有视觉）
- `FooterLine`：键帽数组 → 单行；实现 mihari `FitFooter` 降级策略——宽度不足时先丢中间段，无条件保底最后一段（如 `ESC 取消`/`q 退出`）与右侧全局段；宽度计算用现有 `displayWidth`
- `StatusDot`/`StatusChip`：`●` + 语义四档（neutral/positive/caution/negative → muted/success/warning/danger）

### 4.4 [1] 节点页（`src/views/Proxies.tsx`）

双栏各套 Panel（标题嵌边框），行样式分离：

```
┌ 代理组 ──────────────────────┐┌ 节点 · AUTO [按延迟] 190/228 可用 ─────────┐
│ ❯ AUTO              190/228  │ │ ▌ > [J] 🇭🇰【亚洲】香港04丨专线【3x】  57ms │
│   机场-jkun         93/110   │ │   [L] 🇯🇵日本高速02|BGP|CUCM           76ms │
│   ● 机场-yuetoto    56/69   │ │   ● [Y] 悦·🇹🇼台湾2（当前在用，rowSelected）│
└──────────────────────────────┘└────────────────────────────────────────────┘
 ❯❯ 移动  ←→ 切栏  Enter 选用  t 测速  v 只看可用   ←→/Tab 切换  r 刷新  q 退出
```

- `▌` accent 指示条 = 键盘焦点行（替代整行反色，CJK 行不再闪白）；`●` = 业务选中（当前在用节点），两者可同时出现
- 组行内 `●` 表示该组当前被 PROXY 选中（沿用现有 currentNode 逻辑，仅换符号与色）
- 页脚换 FooterLine，键位集合与行为完全不变

### 4.5 [2] 订阅页（`src/views/Providers.tsx`）

- 表格外套全宽 Panel（标题 `订阅 · N`，N 为数量，对齐 mihari `FormatSubscriptionsTitle`）
- USAGE 列改为「数值 + 使用率条」：复用现有 `progressBar`（剩余 <10% 转红）
- UPDATED 列 dim；到期 <7 天 warning、已过期 danger
- 更新失败行的红框错误盒改用 Panel（danger 边框 + `⚠` 标题），与 ConfirmDialog 语言一致

### 4.6 [3] 日志 / [4] 连接

- 日志：级别语义色（info=muted/info、warn=warning、error=danger），时间戳 dim，其余不变
- 连接：表头 tableHeader 样式；↑↓ 速率列 success 色；空态文案保持

### 4.7 对话框统一

InputDialog/ConfirmDialog/ProgressDialog/错误盒的颜色与键帽全部改引 theme 常量（视觉不变，来源统一），行为零改动。

## 5. 组件职责与数据流

- `src/ui/*` 只做纯渲染与宽度计算，不发请求、不读文件；视图层把 theme + 组件组合进现有 JSX
- 现有 hooks、commands、config 层零改动；`fitDisplay/padDisplay/displayWidth` 继续作为唯一的宽度工具
- App 级 focus 规则不变（`active` 仍只控制键盘焦点归属）

## 6. 边界与错误处理

- **窄终端**：FooterLine 降级（丢中间段保底段）；Panel 最小宽度 20 列，低于此退化为无边框纯文本（避免边框错位）
- **CJK/emoji 宽度**：一切裁切补齐走 `displayWidth` 系函数，禁止 `slice`（沿用现有纪律）
- **色彩降级**：交给 ink（256 色终端为目标环境；无 TTY 场景本来就不渲染 TUI）
- **回归红线**：不改任何 `useInput` 分支与按键字节处理；现有 194 个测试全部保持通过（改样式断言的除外，逐条更新）

## Execution Checkpoints

- [ ] 1. `theme.ts` + `src/ui/` 组件落地（Panel/FooterLine/StatusDot/KeyCap），配套纯函数单测
- [ ] 2. App 外壳：顶栏卡片条 + 状态栏分组着色，pty 截屏验收
- [ ] 3. [1] 节点页双栏 Panel 化 + rowFocus/rowSelected 分离，现有键位行为不变
- [ ] 4. [2] 订阅页 Panel + 使用率条 + 到期/错误语义色
- [ ] 5. [3]/[4] 页与四个对话框统一接 theme
- [ ] 6. 全量 `npm test` + `npm run build` 通过；四页 pty 截屏人工验收后提交

## 技术债（UI 完善后实施，本期不 doing）

**TD-1 mihomo 内核下载与管理（参考 mihari `internal/core/`）**

- 现状：本机内核 `/4t/usr/chenjw/bin/mihomo` 靠手动升级；TUI 无法查看/更新内核版本
- 目标：TUI 内内核管理——展示当前版本（对照运行中内核 `v1.19.24` 与最新 Release）、从 GitHub Releases 下载指定版本、校验后替换二进制并重启服务
- mihari 参考实现（只抄思路）：
  - `internal/core/install.go`：`Installer.Install`/`DetectVersion`（安装编排与版本探测）
  - `internal/core/provenance.go`：可信下载——下载 Release 资产 → 校验（checksum/来源配对）→ 暂存 → 原子 `commitTrusted` 替换
  - `internal/core/migration.go`：`DownloadMigrationCore` 按平台/goos/arch 拉取
  - TUI 入口在其 System 页（版本对比 + 提权更新流）
- 对我们的落地形态：System 附近新增「内核」区块或 [2] 订阅页外的新 tab；下载用 GitHub API + `https_proxy` 走本机代理；替换前强制 `mihomo -t` 校验 + 备份旧二进制 + systemd 重启确认（复用 ServiceManager）
- 前置条件：UI 美化完成（新外壳/对话框组件就绪后，内核管理页直接复用）

## 验证

1. 新增：theme token 完整性断言 + FooterLine 降级策略纯函数测试（宽度递减时节丢弃序、保底段存活）
2. 回归：全量 `npm test`（194 项）与 `npm run build` 通过
3. 人工：pty 逐页截屏（110×34 与 80×24 两档宽度）对照本 spec 样稿验收；窄宽下页脚不折行
