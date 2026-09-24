# v0.3.0 订阅增强（分组 / 重命名 / 类型与内联编辑）设计文档

**日期：** 2026-09-24
**目标版本：** v0.3.0
**状态：** 草稿（Level 2，待评审）
**前置版本：** v0.2.0（TUI 订阅生命周期）、v0.2.1（TUI 美化）

> 修订记录：
> - 2026-09-24 初稿：批量导入 / 分组 / 历史与回滚
> - 2026-09-24 重构：按评审意见收窄范围。**移除**批量导入与订阅历史/回滚；**保留**订阅分组并明确其在节点页的展示；**新增**订阅重命名、订阅类型（远程/本地）、更新间隔、订阅文件内联编辑。

---

## 1. 背景与目标

### 1.1 背景

v0.2.0 的订阅模型只有三个字段：`name`、`url`、`prefix`，且 `name` 与 `url` 在创建后不可改（见 `subscriptionService.ts` 的编辑流程，仅允许改前缀）。这带来四个具体限制：

1. **订阅无法归类**：节点页左侧按订阅名平铺，订阅一多就难分辨哪些是同一用途。
2. **名称一旦定下不能改**：命名出错只能删了重建。
3. **无法表达「本地节点」**：所有订阅都是 `type: http` 拉远程 URL，没有「这一组节点是我自己维护的文件」这种来源。
4. **更新频率不可控**：骨架里 `interval` 写死 3600 秒，不能按订阅单独设定，也不能关闭自动更新。
5. **订阅内容不可直接改**：想调整某个订阅拉下来的节点，只能等内核缓存文件然后在外部编辑器改，TUI 内无入口。

### 1.2 术语说明

| 术语 | 含义 | 为什么重要 |
|------|------|-----------|
| **订阅（Subscription）** | `subscriptions.json` 里的一条清单记录，对应 `config.yaml` 中的一个 proxy-provider | 本工具与内核之间的核心数据契约 |
| **订阅分组（group）** | 挂在订阅上的可选文本标签，只用于界面归类 | 不参与骨架生成，不影响内核行为 |
| **订阅类型（type）** | `remote`（按 URL 拉取）或 `local`（读本地 YAML 文件） | 决定该订阅在骨架里生成 `http` 还是 `file` 型 provider |
| **更新间隔（interval）** | 远程订阅自动重新拉取的分钟数；空表示禁用自动更新 | 映射到 provider 的 `interval` 字段（秒） |
| **锁定（locked）** | 远程订阅被手动编辑后置位的标记，表示「不要再自动拉取覆盖手改内容」 | 防止下次更新把用户的手工修改冲掉 |
| **内联编辑器** | TUI 内打开的整文件文本编辑视图，直接改订阅对应的 YAML 文件 | 免去跳到外部编辑器的往返 |

### 1.3 目标

1. **订阅分组**：`Subscription` 增加可选 `group`；节点页左侧由「订阅名」改为按 `分组名 - 订阅名` 展示并按分组归拢。
2. **订阅重命名**：编辑订阅时可修改 `name`，同步迁移内核缓存文件与配置引用。
3. **类型切换**：新增/编辑订阅时可选「远程 / 本地」。远程走 URL，本地走一份由本工具托管的 YAML 文件。
4. **更新间隔**：远程订阅可设分钟级间隔，留空即禁用自动更新。
5. **内联编辑订阅文件**：新增/编辑表单提供「编辑文件」入口，在 TUI 内直接修改该订阅的 YAML；对远程订阅，保存编辑会**锁定**该订阅（禁用自动更新）以免被覆盖。

**成功标准：**

- 给三个订阅分别设分组后，节点页左侧按分组归拢显示为 `分组名 - 订阅名`。
- 重命名一个订阅后，内核中对应 provider、缓存文件、节点引用都跟随新名字，无残留旧名字。
- 新建一个本地类型订阅，写入 YAML 后不填 URL 即可在节点页看到其节点。
- 把某远程订阅的更新间隔留空，骨架中该 provider 的 `interval` 为 0（不自动更新）。
- 编辑某远程订阅的 YAML 并保存后，该订阅被锁定，后续自动更新不再覆盖该文件。

---

## 2. 范围与非目标

### 2.1 范围内

- `Subscription` 数据模型扩展：`group?`、`type`、`interval?`、`locked?`。
- 订阅重命名的完整迁移（配置、缓存文件、引用）。
- 新增/编辑订阅表单重构为多字段：类型、名称、订阅链接、更新间隔、编辑文件。
- 本地类型订阅的文件托管（`~/.config/mihomo/providers/<name>.yaml`）。
- TUI 内联 YAML 编辑器（单文件、基础编辑）。
- 节点页左侧按分组展示。
- 远程订阅「编辑后锁定」机制。

### 2.2 非目标

- **不做批量导入**：逐条新增/编辑即可，批量留待后续。
- **不做订阅历史与回滚**：变更追溯不在本版范围。
- **不做本地节点的表单式逐协议录入**：本地订阅的内容一律通过内联 YAML 编辑器维护；SS/Trojan/VMess/VLESS 的分字段表单属于 v0.4.0，本版不提前实现。
- **不做分组的独立管理**：`group` 是自由文本，不建分组表、不做分组重命名级联（重命名分组 = 逐条改订阅的 group）。
- **不做语法高亮与智能补全**：内联编辑器只提供文本编辑、行号与基础校验，不做成完整 IDE。
- **不改动订阅历史/审计**：本版变更不记录快照。

---

## 3. 总体设计

### 3.1 模块划分

```
src/
├── config/
│   ├── types.ts              # Subscription 增 group/type/interval/locked
│   ├── subscriptions.ts      # 校验扩展；loadSubscriptions 兼容旧格式
│   ├── skeleton.ts           # provider 生成按 type 分支；interval 映射
│   └── subscriptionService.ts# 重命名迁移；本地文件托管；锁定逻辑
├── views/
│   ├── Providers.tsx         # 新增/编辑表单改为多字段
│   ├── Proxies.tsx           # 左侧按「分组名 - 订阅名」展示
│   └── YamlEditor.tsx        # 新增：内联 YAML 编辑器视图
└── components/
    └── (复用 InputDialog / ConfirmDialog / ProgressDialog)
```

### 3.2 写入边界

| 操作 | 写入目标 | 是否重启 |
|------|---------|---------|
| 改 group / interval / locked | `subscriptions.json` + 重新生成 config | 是（走现有事务） |
| 重命名 | `subscriptions.json` + 缓存文件改名 + 重新生成 config | 是 |
| 切换为本地类型 | 创建本地 YAML + 重新生成 config | 是 |
| 内联编辑保存 | 订阅对应的 YAML 文件（`providers/<name>.yaml`） | 否（热更新 provider） |
| 远程订阅编辑后锁定 | 置 `locked` + `interval` 置空 + 写文件 | 编辑本身热更新；锁定写 config 走事务 |

内联编辑保存走内核热更新（`PUT /providers/proxies/{name}`），**不重启**。涉及 `subscriptions.json` 与 config 的变更仍走 v0.2.0 的 `applyChange` 事务（备份/校验/回滚/重启）。

---

## 4. 数据模型

### 4.1 `Subscription` 扩展

```typescript
export interface Subscription {
  /** 订阅名称，^[a-z0-9_-]{1,32}$，可重命名 */
  name: string
  /** 订阅类型：remote 拉 URL，local 读本地文件 */
  type: 'remote' | 'local'
  /** 远程订阅 URL；type=local 时为空 */
  url?: string
  /** 节点名前缀，可选 */
  prefix?: string
  /** 分组标签，可选，1–16 字符 */
  group?: string
  /** 自动更新间隔（分钟）；空/0 表示禁用自动更新 */
  interval?: number
  /** 远程订阅被手动编辑后锁定，禁止自动更新覆盖 */
  locked?: boolean
}
```

**校验规则：**

| 字段 | 规则 |
|------|------|
| `name` | 沿用现有 `^[a-z0-9_-]{1,32}$`，清单内唯一 |
| `type` | 必填，`remote` 或 `local`；旧数据缺省按 `remote` 处理 |
| `url` | `type=remote` 时必填（http/https，≤2048）；`type=local` 时必须为空 |
| `group` | 可选；`/^[\p{L}\p{N}][\p{L}\p{N} -]{0,15}$/u`；空串归一为 `undefined` |
| `interval` | 可选正整数（分钟），范围 1–43200（30 天）；空/`0` 视为禁用 |
| `locked` | 布尔；仅 `type=remote` 有意义 |

**向后兼容：** 旧 `subscriptions.json` 无 `type`/`group`/`interval`/`locked`。读取时 `type` 缺省为 `remote`，其余缺省为 `undefined`，不报错、不需迁移脚本。

### 4.2 骨架映射（`skeleton.ts`）

当前所有订阅都生成 `type: http` 且 `interval: 3600`。改为按订阅分支：

```yaml
# type: remote 且未锁定
proxy-providers:
  <name>:
    type: http
    url: <url>
    path: ./providers/<name>.yaml
    interval: <interval*60 或 0>     # 分钟转秒；空/locked → 0

# type: local，或 remote 但 locked
proxy-providers:
  <name>:
    type: file
    path: ./providers/<name>.yaml
    interval: 0
```

要点：

- `interval` 分钟 → 秒写入；空、`0` 或 `locked` 一律写 `0`（mihomo 中 `interval: 0` 表示不自动更新）。
- `locked` 的远程订阅**仍保留 url**（记录来源），但 provider 改为 `type: file` 读取本地已编辑文件，避免内核按 url 重新拉取覆盖。
- `health-check` 块保持现有逻辑不变。

### 4.3 本地文件托管

- 本地类型订阅的内容文件：`~/.config/mihomo/providers/<name>.yaml`。
- 新建本地订阅时若文件不存在，创建一个空骨架：

  ```yaml
  proxies: []
  ```

- 该目录与文件由内核与本工具共用（内核 `path` 也指向它），权限遵循内核要求。

---

## 5. 订阅重命名

重命名是本版最需要谨慎的操作，因为 `name` 被多处引用。

### 5.1 影响面

| 位置 | 处理 |
|------|------|
| `subscriptions.json` | 更新 `name` |
| `config.yaml` 的 proxy-provider key | 由骨架按新名字重新生成 |
| `./providers/<old>.yaml` 缓存/内容文件 | 重命名为 `<new>.yaml` |
| proxy-groups 中引用该订阅节点的条目 | 由骨架重新生成（订阅节点名带前缀，组引用在骨架内） |
| 内核运行时已加载的旧 provider | 重启后按新配置加载 |

### 5.2 事务顺序

重命名复用 `applyChange`，在其「写 manifest」之前插入文件迁移步骤：

```
校验新名字（格式 + 不重名）
  → 备份 config
  → 写新 subscriptions.json
  → 重命名 providers/<old>.yaml → providers/<new>.yaml
  → 骨架重新生成 config
  → mihomo -t 校验
  → 原子写 config
  → 重启 + 复验
```

**失败回滚：** 任一步失败，除了现有的 config 与 manifest 回滚外，还需把 `providers/<new>.yaml` 改回 `<old>.yaml`。文件改名用 `rename(2)`，同一文件系统内原子。

### 5.3 手写引用扫描与提示

订阅名会作为节点前缀的一部分出现在用户**手写**的规则里（`rules` 中直接写了带前缀的节点名或订阅名）。骨架重新生成时只会改它自己管理的部分，这些手写引用不会自动跟随重命名。

因此重命名提交前增加一步扫描：

- 扫描范围：当前 `config.yaml` 里非骨架生成的 `rules` 条目（即用户手写保留下来的规则）。
- 匹配：查找包含旧订阅名的规则行。
- 结果处理：**只提示，不自动改写**。若命中，弹确认列出受影响的规则行数与示例，提示「这些手写引用不会自动更新，需自行修改」，用户确认后才继续重命名事务。
- 未命中则静默通过，不打断流程。

### 5.4 约束

- 新名必须满足 `name` 校验且不与现有订阅冲突。
- 重命名不改变 `type`/`url`/`group` 等其他字段（那些走各自的编辑路径）。

---

## 6. 类型切换与锁定

### 6.1 远程 → 本地

- 表单把类型改为本地后，`url` 清空，`interval` 清空。
- 若 `providers/<name>.yaml` 已存在（内核之前拉取的缓存），**保留其内容**作为本地文件起点，不覆盖。
- 若不存在，创建空骨架 `proxies: []`。

### 6.2 本地 → 远程

- 必须填写 `url`。
- 切换后内核会按 url 重新拉取，**本地编辑的内容将被覆盖**。表单提交前弹确认：「切换为远程会在下次更新时覆盖本地内容，确认？」

### 6.3 编辑后锁定（远程订阅）

- 用户对 `type=remote` 的订阅执行「编辑文件」并保存：
  1. 把编辑内容原子写入 `providers/<name>.yaml`。
  2. 置 `locked = true`，`interval` 置空。
  3. 触发一次 config 事务，使骨架把该 provider 改为 `type: file`（见 §4.2），停止内核按 url 拉取。
- **解锁**：编辑表单里提供「恢复自动更新」动作，清除 `locked`、恢复 `interval`，骨架改回 `type: http`。再次拉取会覆盖手改内容，需确认。

---

## 7. 内联文本编辑器（可复用组件）

### 7.1 参考与取舍

两个参考项目都**没有**可直接照搬的多行编辑器：

- `references/mihari` 的订阅表单（`internal/tui/pages/subscriptions/form.go`）是多个单行 `textinput`；其 `internal/tui/ui/viewport.go` 的 `EnsureLineVisible` 提供「让焦点行保持在可视窗口内」的滚动算法，本组件借用该语义。
- `references/cc-switch` 的编辑是 Web `<textarea>`（`src/components/ui/textarea.tsx`），只借鉴「受控值 + 明确的保存/放弃」这一交互意图。

实现基础是本项目 `InputDialog`：它已解决单行场景的码点数组编辑、光标、横向开窗（`inputWindow`）与粘贴。编辑器在此之上扩展为多行，并做成**与文件无关的通用组件**，供订阅 YAML、以及日后规则、本地节点等场景复用。

### 7.2 组件分层

```
src/components/textEditor.ts     # 纯逻辑：文档模型 + 按键归约 + 滚动窗口（无 Ink）
src/components/TextEditor.tsx    # Ink 视图：渲染 + 键盘/粘贴绑定
src/views/yamlFile.ts            # 已有：订阅文件校验与锁定（编辑器的一个使用方）
```

**纯逻辑与视图分离**是为了可测：文档模型用 vitest 直接测，不依赖终端渲染。

### 7.3 文档模型（`textEditor.ts`）

```typescript
export interface EditorState {
  lines: string[]        // 每行是普通字符串；行内编辑按码点数组
  row: number            // 光标行（0 基）
  col: number            // 光标列（码点下标）
  scroll: number         // 可视窗口首行
}

export type EditorAction =
  | { type: 'insert'; text: string }      // 可含换行，支持粘贴多行
  | { type: 'backspace' } | { type: 'delete' }
  | { type: 'move'; dir: 'left' | 'right' | 'up' | 'down' | 'home' | 'end' }
  | { type: 'moveLine'; dir: 'up' | 'down' }   // 光标移到上/下一行行首

export function reduce(state: EditorState, action: EditorAction, viewHeight: number): EditorState
export function visibleLines(state: EditorState, viewHeight: number): { start: number; lines: string[] }
```

行为约定：

- **换行**：`insert` 含 `\n` 时拆行，光标落到新行。
- **跨行退格**：行首 Backspace 把当前行并入上一行。
- **上下移动**：列号尽量保持（目标行更短时落到行尾）。
- **滚动**：每次归约后用「焦点行保持可见」调整 `scroll`（借鉴 mihari `EnsureLineVisible`：光标行超出窗口就平移，窗口小于内容时不越界）。
- **横向**：单行超宽时复用 `inputWindow` 按光标列开窗，不折行。

### 7.4 视图（`TextEditor.tsx`）

```tsx
export interface TextEditorProps {
  title: string
  initialText: string
  height: number
  width: number
  /** 保存前校验；返回错误文案则不保存、在状态栏显示 */
  validate?: (text: string) => string | undefined
  onSave: (text: string) => void
  onCancel: () => void
}
```

- 渲染：行号 + 文本；光标用反色块；脏状态在底栏显示「已修改」。
- 键位：方向键/Home/End 移动，字符输入，Backspace/Delete 删除，Enter 换行；`Ctrl-S` 校验后 `onSave`；`ESC` 有未保存修改时先确认再 `onCancel`。
- 粘贴：走 ink 的 bracketed paste，整段作为一次 `insert`（可含多行）。
- **不做**：语法高亮、搜索替换、撤销重做、多光标（YAGNI）。

### 7.5 订阅场景的接入

`Providers.tsx` 的新增/编辑表单增加「编辑文件」入口（表单内按键，如 `Ctrl-O`）：

1. 挂起表单，按订阅名读取 `providers/<name>.yaml`（不存在则用 `proxies: []\n`）。
2. 打开 `TextEditor`，`validate` 传 `checkProxyFile`（`yamlFile.ts`）。
3. 保存：原子写文件；若是远程订阅，再调 `editSubscription(name, { locked: true })` 触发锁定事务（§6.3）。
4. 关闭编辑器，回到表单，表单已填字段保留。

编辑器组件本身不感知「订阅 / 锁定」——那些是调用方的职责，从而保证可复用。

### 7.6 测试

- `textEditor.ts`：插入（含多行粘贴）、跨行退格、上下移动保持列、滚动窗口跟随光标、横向开窗。覆盖率 ≥ 90%。
- `TextEditor.tsx`：ink-testing-library 验证 `Ctrl-S` 触发 `onSave`、校验失败不保存并显示错误、`ESC` 在脏状态下不直接退出。

---

## 8. 表单重构（新增 / 编辑订阅）

现有新增表单是三个字段（名称、URL、前缀）。重构为：

| 字段 | 控件 | 说明 |
|------|------|------|
| 类型 | 切换（远程 / 本地） | 切换时联动显示/隐藏其他字段 |
| 名称 | 文本 | 新增必填；编辑时可改（触发重命名，§5） |
| 订阅链接 | 文本 | 仅远程类型显示且必填 |
| 更新间隔 | 数字（分钟） | 仅远程类型显示；留空 = 禁用自动更新 |
| 前缀 | 文本 | 可选，沿用现有 |
| 分组 | 文本 | 可选 |
| 编辑文件 | 按钮 | 打开内联编辑器（§7） |

**联动规则：**

- 类型 = 本地：隐藏「订阅链接」与「更新间隔」，「编辑文件」可用。
- 类型 = 远程：显示「订阅链接」「更新间隔」；「编辑文件」可用，但保存时触发锁定（§6.3）。
- 编辑已锁定的远程订阅：显示「已锁定，自动更新已禁用」提示与「恢复自动更新」动作。

提交走 `runFlow` 进度对话框，底层仍是 `applyChange` 事务。

---

## 9. 节点页左侧展示

`src/views/Proxies.tsx` 左侧列表现按订阅/代理组名平铺。改为按分组归拢，条目显示为 `分组名 - 订阅名`：

```
代理组 · 8
 ─ 香港专线 ─
▌ 香港专线 - yuetoto
  香港专线 - ax-hk
 ─ 备用 ─
   备用 - ax-thinker
 ─ 未分组 ─
   backup-node
```

- 无 `group` 的订阅归入「未分组」，「未分组」放在最后。
- 组内按订阅名排序，组与组之间按组名排序。
- 仅影响**显示**；底层选中、切换节点的逻辑不变，仍按订阅/组的真实 `name` 操作。
- 名称超宽时沿用现有 `truncateDisplay`。

---

## 10. 错误处理

| 场景 | 行为 |
|------|------|
| 重命名新名非法或重名 | 校验阶段拒绝，不开启事务 |
| 重命名中途失败 | 回滚 config、manifest，并把缓存文件改回旧名 |
| 本地订阅文件缺失 | 自动重建空骨架 `proxies: []` |
| 内联编辑 YAML 解析失败 | 底部提示错误，阻止保存，不写文件 |
| 编辑远程订阅保存 | 写文件 + 置 locked + config 事务；事务失败则文件改动也回滚 |
| 本地→远程切换 | 提交前确认，提示内容将被覆盖 |
| 间隔超出 1–43200 | 表单内红字拒绝 |

---

## 11. Execution Checkpoints

| # | Checkpoint | 交付物 | 验证 |
|---|-----------|-------|------|
| 1 | ✅ 数据模型扩展 + 兼容读取 | `types.ts` / `subscriptions.ts` + 单测 | 旧 JSON（无 type/group）加载为 remote 且不报错 |
| 2 | ✅ 骨架按 type/interval/locked 分支 | `skeleton.ts` + 单测 | remote 写 http+间隔，locked/local 写 file+interval 0 |
| 3 | ✅ 订阅重命名迁移 | `subscriptionService.ts` + 集成测试 | 改名后文件迁移、失败回滚改回旧名 |
| 4 | ✅ 表单重构（类型/名称/链接/间隔/分组） | `Providers.tsx` | 联动字段提交走事务 |
| 5 | ✅ 内联文本编辑器（可复用） | `textEditor.ts` + `TextEditor.tsx` + 订阅接入 | 模型单测 + 视图测试（Ctrl-S 保存、校验失败不保存、ESC 脏状态先确认）；订阅页 `o` 打开 |
| 6 | ✅ 远程编辑锁定（状态层） | `lockAfterEdit` + `editSubscription({locked})` | 锁定后骨架该 provider 为 file 且 interval 0 |
| 7 | ✅ 节点页分组展示 | `groupDisplay.ts` + `Proxies.tsx` | 左侧按 `分组名 - 订阅名` 归拢，未分组在最后 |

---

## 12. 验证方案

- **单测**：`subscriptions.ts` 校验分支、`skeleton.ts` 的 type/interval 映射、重命名回滚、YAML 校验，覆盖率保持 `src/config/` ≥ 94% 基线。
- **重命名集成测试**：临时目录 + stub mihomo/systemctl（沿用 `subscriptionService.test.ts` 的模式），断言失败时缓存文件名恢复旧值。
- **手测**：
  1. 三个订阅设不同分组，节点页左侧按 `分组 - 订阅` 归拢。
  2. 重命名一个订阅，确认节点页与内核 provider 都变新名。
  3. 新建本地订阅，编辑器写入节点 YAML，节点页出现这些节点。
  4. 编辑一个远程订阅的 YAML，确认被锁定且不再自动更新。
  5. 对锁定订阅执行「恢复自动更新」，确认解除锁定。

---

## 13. 兼容性与迁移

| 源 | 处理 |
|----|------|
| 旧 `subscriptions.json`（仅 name/url/prefix） | `type` 缺省 remote，其余缺省空，无缝加载 |
| 已有内核缓存 `providers/<name>.yaml` | 保留；切换为本地或锁定时作为起点 |
| 降回 v0.2.x | 新字段会被旧版忽略或拒绝；降级前需手动移除 group/type/interval/locked |

不改 mihomo 内核 API。`provider ls/update/check` 的输出与退出码不变。

---

## 14. 已决事项

1. **锁定粒度**：按**整订阅**锁定。不做「只锁定被改节点、其余随远程更新」的细粒度。
2. **分组重命名**：**不**提供批量改分组入口。改分组名即逐条修改订阅的 `group` 字段。
3. **重命名时的手写引用**：重命名前扫描用户手写规则中对旧订阅名的引用，**提示但不自动改写**，用户确认后继续（见 §5.3）。

## 15. 开放问题

1. **内联编辑器的多字节与宽字符**：中文、emoji 的光标列对齐在终端里易出错，实施时需验证 Ink 下的光标定位。
2. **本地文件与内核缓存同路径的并发**：内核更新与用户编辑可能同时写 `providers/<name>.yaml`。锁定机制（interval 0 + type file）就是为避免这一点，需确认 locked 后内核确实不再写该文件。

---

**规范完。待评审 → 进入实施。**
