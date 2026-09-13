# 分级 ESC 退出 + 添加订阅对话框美化 spec

日期：2026-09-13 · 级别：Level 2 · 前置：终端绿主题改造已完成（be57b08）

## 1. 目标与范围

两项：

1. **分级 ESC 退出**（修 bug + 新交互）：对话框/输入态里按 ESC 只退当前层，不再整只 TUI 退出；主界面按 ESC 弹出退出确认，Enter 才真正退出。
2. **添加订阅对话框美观化**：对齐 mihari/cc-switch 的弹窗语言——居中窄卡片、标题区、键帽页脚。

不做：ProgressDialog 视觉重排（仅沿用现有结构）、ConfirmDialog 结构改动（复用）、其他页面的行样式调整。

## 2. 问题根因（已实测确认）

ink 的 `useInput` 是**广播式**的：所有挂载的 hook 都收到同一按键，没有「最内层优先消费」的机制。当前：

- 对话框打开按 ESC → InputDialog 的 handler 调 `onCancel()`，**同时** App 的 handler 也收到 ESC → `exit()`，整只 TUI 退出（用户报告的 bug）。
- `1`-`4`/`Tab`/`m` 全局键同样穿透对话框（背景切页）。
- 日志页 `/` 编辑过滤词时按 ESC：LogsView 退出编辑态 + App 退出，同病。

## 3. 参考项目结论（主对话深读）

**cc-switch**（Tauri/React，桌面端）：ESC 永远只退一层。守卫三件套——忙碌时忽略；文本输入聚焦时让输入框自己处理；内层组件先消费（`defaultPrevented` 即阻断外层）。表单范式：字段标签 + 行内校验消息 + 主按钮就绪态。其退出由桌面窗口系统承担，无应用内退出确认。

**mihari**（Bubbletea TUI，直接可比）：按键**优先级链**——`ctrl+c` 硬退（始终）→ 覆盖层 → 模态吃掉全部按键 → 页面分发；`q` 仅在非文本输入态退出。确认弹窗：居中窄卡片 `min(64, width-8)`，文案三段（对象/影响/回滚-muted），双按钮选中式且**默认选中取消**。

**本设计的移植**：ink 无事件冒泡，用「按键捕获登记表」实现等价的内层优先：谁在捕获按键谁登记，App 的全局 handler 见登记即让路。`ctrl+c` 沿用 mihari 语义保持硬退出。

## 4. 交互设计：三层退出状态机

```
对话框层（InputDialog/ConfirmDialog/ProgressDialog/日志过滤编辑/连接确认）
  ESC → 只关当前层（现状行为，修复穿透）
  Enter/y/n/编辑键 → 当前层消费
        ↓ 关闭后
主界面层（四页）
  ESC → 弹出退出确认（新）
  Tab/1-4/m/j/k… → 现有全局键不变
        ↓ ESC
退出确认层（新增，复用 ConfirmDialog 非 danger 态，enterConfirms）
  Enter / y → exit() 真正退出
  ESC / n → 取消回主界面
  其他键 → 忽略（确认层是唯一按键消费者，App 与视图全部停摆）
  （Ctrl+C 任何层都硬退出，mihari 语义）
```

页脚提示随之演进：主界面 `ESC 退出`（语义不变，现在先弹确认）；退出确认框自带键帽 `Enter 确认退出 · ESC 取消`。

## 5. 架构与组件职责

### 5.1 `src/ui/keyCapture.ts`（新增，纯模块 + hook）

```ts
const captured = new Set<symbol>()
export function keysCaptured(): boolean
export function useKeyCapture(active: boolean): void  // effect 增删登记
```

- 登记方（内层优先的实现载体）：
  - InputDialog / ConfirmDialog / ProgressDialog：挂载即登记（`useKeyCapture(true)`）
  - LogsView：`useKeyCapture(editing)`（过滤词编辑态）
  - ConnsView：`useKeyCapture(confirmAll)`（D 确认态）
- App 的全局 `useInput` 顶部：`if (key.ctrl && input === 'c') exit()` 之后紧跟 `if (keysCaptured()) return`。

### 5.2 App.tsx：退出确认层

- `const [confirmExit, setConfirmExit] = useState(false)`
- 全局 handler 的 ESC 分支：`keysCaptured()` 已被上面拦掉；`confirmExit` 开着时本分支不再触发（见下）——故 ESC 在此直接 `setConfirmExit(true)`
- `confirmExit` 开着时按键全部由 ConfirmDialog 消费（Enter/y 确认、ESC/n 取消、其余忽略）；App 全局 handler 靠闸门让路，视图靠 active 停摆
- 确认期间 body 模态独占（视图卸载 → useInput 随之停摆）；**已知取舍**：取消确认后视图本地状态（Proxies 光标/排序、Logs 过滤词、Providers 展开项等）会重置——模态独占换取确认框双轴居中，状态上提留作后续优化
- 渲染：`confirmExit && <ConfirmDialog title="退出 mihomo-tui" message={['确认退出？内核服务不受影响，仍在后台运行']} enterConfirms width={min(56, columns-4)} ... danger={false} />`（按键全部由 ConfirmDialog 消费——它挂载即登记，App 闸门自动让路；App handler 不重复处理 Enter/ESC）
- 确认框**居中独占 body**（后续打磨，对齐 cc-switch 确认卡片语言：双轴居中窄卡、取消在前）：confirmExit 时模态替代页面内容，宽 `min(56, columns-4)` 窄终端自适应

### 5.3 InputDialog 美化（居中窄卡片）

```
                    ╭─ ◆ 添加订阅 ────────────────────────────╮
                    │                                          │
                    │  ❯ 订阅名称 *                            │
                    │  ╭────────────────────────────────────╮  │
                    │  │ <my-airport>                       │  │
                    │  ╰────────────────────────────────────╯  │
                    │    订阅 URL                              │
                    │  ╭────────────────────────────────────╮  │
                    │  │ <https://...>                      │  │
                    │  ╰────────────────────────────────────╯  │
                    │                                          │
                    │  Enter 提交  ↑↓ 切换  Ctrl+U 清空  ESC 取消 │
                    ╰──────────────────────────────────────────╯
```

- 卡片宽 `min(64, max(44, width - 8))`，外层 `<Box justifyContent="center">` 水平居中；宽度不足 44 时退化为现状全宽（Panel 同款降级思路）
- 标题区：`◆` accent + 标题 bold（现状保留）；`required` 字段标签后缀 danger 色 `*`
- 键帽页脚换 FooterLine：`Enter`（最后一项=提交，否则=下一项，上下文切换）`↑↓ 切换` `Ctrl+U 清空` `ESC 取消`；校验错误显示时页脚上方追加 `⚠ <错误文案>`（danger，替代字段行内的错误行——校验提示集中一处更清爽）
- 输入框圆角/光标反色块/粘贴/编辑键全部保留（行为零改动）

## 6. 数据流与边界

- 登记表是模块级 `Set<symbol>`：组件挂载/卸载与状态切换增删，App 在每次按键同步读取——时序安全（对话框先 mount 后接键）
- 退出确认打开时不可能有对话框存活（ESC 只在无登记时到达 App），无嵌套冲突
- ProgressDialog 打开（事务进行中）+ ESC：对话框吃掉 ESC（自身不可取消时忽略），App 让路 → 事务期间不会误退，现状语义保持
- 测试装置（harness）不受影响：登记表随组件 unmount 清理，无泄漏

## 7. Execution Checkpoints

- [x] 1. `keyCapture.ts` + App 闸门 + LogsView/ConnsView 登记接入：对话框打开按 ESC 只关对话框（回归测试锁死「不退出」）
- [x] 2. 退出确认层：主界面 ESC 弹 ConfirmDialog、Enter 退出、ESC 取消、确认期间视图停摆；页脚文案更新
- [x] 3. InputDialog 居中卡片美化 + 键帽页脚 + required 标注 + 错误集中展示；视觉 pty 截屏核对
- [x] 4. 全量 `npm test` + `npm run build` + 两档宽度 pty 验收（对话框 ESC 不退出 / 退出确认流 / 美化观感）→ 子代理审查 → 提交

## 8. 验证

1. 新增单测：keysCaptured 增删、对话框挂载即登记；App 级「对话框中按 ESC 不退出」（harness 挂 App + 打开对话框 + press ESC + 断言仍渲染）；「主界面 ESC → 确认框出现 → Enter 后 unmount」
2. 回归：dialogs.test.tsx 26 项（对话框行为零改动）、providers-flows 7 项、全量 229 项 + build
3. 人工：pty 驱动 `Tab a ESC`（对话框关、TUI 在）、`ESC`（确认框出现）、`Enter`（干净退出 exit code 0）、`ESC ESC`（取消回主界面）
