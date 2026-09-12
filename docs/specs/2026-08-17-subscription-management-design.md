# TUI 订阅管理功能设计文档

**日期：** 2026-08-17  
**状态：** 已实施（v0.2.0，2026-09-13）

> 实施记录（与设计稿的偏差）：
> - 测试框架采用 vitest 替代 Jest + ts-jest（ESM / Node 22 / JSX 原生支持）
> - 编排层落在独立模块 `src/config/subscriptionService.ts`（对应 3.2 依赖图
>   中的 SubscriptionService），视图层只做状态机与渲染
> - `InputField` 补充了 `value` 与 `readOnly`（6.3 编辑流程需要）
> - `ConfigManager` 新增 `pruneBackups()` 落实 9.2 的「备份保留 7 天」
> - 删除流程的缓存清理放在服务确认成功之后（而非重启之前），回滚时
>   缓存仍在，避免回滚后订阅需要重新拉取
> - 新增 `vitest.setup.ts`：测试全局禁止写入生产配置目录（事故防护）
> - 前缀的尾随空格保留语义（`'[Y] '` 拼接节点名），纯空白视为清除

---

## 1. 目标与范围

### 1.1 功能目标

在 TUI 中实现订阅（proxy-provider）的完整生命周期管理：

- **新增订阅**：用户输入订阅名称、URL、前缀后，自动更新配置并重启服务
- **删除订阅**：从配置中移除 provider、相关代理组、缓存文件，自动重启服务
- **编辑订阅**：修改订阅的节点前缀（name 和 url 不可改）
- **查看订阅**：展示订阅列表、节点数、流量、到期时间（已实现）

### 1.2 设计原则

1. **用户体验优先**：整个流程自动化，无需手动执行脚本或重启服务
2. **安全第一**：每步操作都有备份，失败自动回滚，保证系统可用性
3. **实时反馈**：显示详细进度（"正在备份配置..."），避免用户以为程序卡死
4. **架构一致性**：保持"运行时不写配置"的核心原则，所有配置变更封装在专门模块中

### 1.3 非目标

- **不支持批量导入**：首版只支持单个新增/删除，批量操作留待后续迭代
- **不支持订阅分组**：暂不引入订阅分类、标签等高级功能
- **不支持非 systemd 环境**：只支持 Linux + systemd，不考虑 macOS/Windows

---

## 2. 技术决策

### 2.1 架构方案选择

**采用方案：重构迁移脚本为 TypeScript 库模块**

**理由：**
1. 与现有项目技术栈一致（全 TypeScript，严格类型检查）
2. 精确的错误处理与实时进度反馈
3. 长期可维护性最佳
4. 易于扩展（未来添加批量导入、导出功能）

**备选方案（已放弃）：**
- 方案 A：通过 child_process 调用 migrate-config.mjs 脚本 → 进度反馈差，错误处理粗糙
- 方案 C：混合模式（部分逻辑重构） → 代码重复，技术债累积

### 2.2 服务管理约定

- **服务名称**：固定为 `mihomo`
- **重启方式**：`systemctl --user restart mihomo`
- **平台限制**：仅支持 Linux + systemd
- **重启失败处理**：自动回滚配置并重启服务，展示完整的 systemctl 输出

### 2.3 TUI 交互设计

**新增订阅表单：**
- 三个字段：名称（必填）、URL（必填）、前缀（可选）
- 实时校验：名称格式、URL 格式、重复检查
- 提交前二次校验所有字段

**删除订阅确认：**
- 显示将被删除的内容（订阅、代理组、缓存文件）
- 高亮警告"此操作不可撤销"
- 需要用户按 `y` 确认

**进度显示：**
- 显示总步骤数与当前步骤
- 显示当前操作描述（"正在校验配置..."）
- 显示进度百分比与进度条

---

## 3. 架构设计

### 3.1 模块划分

```
src/
├── config/
│   ├── subscriptions.ts    # 订阅数据模型与文件操作
│   ├── skeleton.ts         # 配置骨架生成（重构自 migrate-config.mjs）
│   ├── manager.ts          # 配置管理器（备份、校验、写入、回滚）
│   ├── service.ts          # 服务管理器（systemctl 操作）
│   └── types.ts            # 共享类型定义
├── components/
│   ├── InputDialog.tsx     # 通用输入对话框
│   ├── ConfirmDialog.tsx   # 通用确认对话框
│   └── ProgressDialog.tsx  # 进度提示对话框
└── views/
    └── Providers.tsx       # 订阅视图（增加新增/删除/编辑交互）
```

### 3.2 模块依赖关系

```
Providers.tsx (TUI 视图)
  ↓ 调用
SubscriptionService (业务逻辑编排)
  ↓ 依赖
┌─────────────────┬──────────────────┬─────────────────┐
│ subscriptions.ts│   skeleton.ts    │   manager.ts    │
│ (订阅文件操作)  │  (配置生成)      │  (备份/校验)    │
└─────────────────┴──────────────────┴─────────────────┘
  ↓ 依赖
service.ts (systemctl 操作)
```

---

## 4. 核心模块接口设计

### 4.1 订阅数据模型 (`src/config/subscriptions.ts`)

#### 类型定义

```typescript
/**
 * 订阅条目定义
 */
export interface Subscription {
  /** 订阅名称，只能包含字母数字与 -_ */
  name: string
  /** 订阅 URL（包含敏感 token） */
  url: string
  /** 节点名前缀，可选 */
  prefix?: string
}

/**
 * 订阅清单文件结构
 */
export interface SubscriptionsFile {
  subscriptions: Subscription[]
}
```

#### 核心函数

```typescript
/**
 * 加载订阅清单
 * @param path 订阅清单路径（默认 ~/.config/mihomo-tui/subscriptions.json）
 * @returns 订阅列表
 * @throws {Error} 文件不存在、JSON 格式错误、校验失败
 */
export function loadSubscriptions(path?: string): Subscription[]

/**
 * 保存订阅清单（原子写入：先写临时文件再 rename）
 * @param subs 订阅列表
 * @param path 订阅清单路径
 * @throws {Error} 写入失败、校验失败
 */
export function saveSubscriptions(subs: Subscription[], path?: string): void

/**
 * 校验订阅数据合法性
 * @returns 成功返回 {ok: true, data}，失败返回 {ok: false, error}
 */
export function validateSubscription(sub: Partial<Subscription>): 
  | { ok: true; data: Subscription }
  | { ok: false; error: string }

/**
 * 校验订阅名是否重复
 */
export function isDuplicateName(name: string, existing: Subscription[]): boolean

/**
 * 脱敏显示 URL（打印日志时使用）
 * @example
 * redactUrl('https://example.com/sub?token=abc123')
 * // => 'https://example.com/sub?token=<REDACTED>'
 */
export function redactUrl(url: string): string
```

#### 实现要点

**名称校验规则：**
- 正则：`/^[a-z0-9_-]+$/i`
- 长度：1-32 字符
- 不能与现有订阅重复

**URL 校验规则：**
- 必须以 `http://` 或 `https://` 开头
- 通过 `new URL()` 解析不抛异常
- 长度不超过 2048 字符

**原子写入流程：**
1. 序列化为 JSON（2 空格缩进）
2. 写入 `<path>.tmp`
3. `fs.renameSync(tmpPath, path)` 原子替换
4. 失败时删除临时文件

---

### 4.2 配置骨架生成 (`src/config/skeleton.ts`)

#### 类型定义

```typescript
/**
 * 区域组定义
 */
export interface RegionDef {
  name: string
  filter: string  // Go RE2 正则
}

/**
 * 配置生成选项
 */
export interface SkeletonOptions {
  /** 是否启用 DNS（默认 true） */
  enableDns?: boolean
  /** 测速 URL */
  testUrl?: string
  /** 区域组定义（可自定义） */
  regions?: RegionDef[]
}

/**
 * 解析后的 YAML 配置对象
 */
export type ParsedYaml = Record<string, unknown>
```

#### 核心函数

```typescript
/**
 * 生成完整的配置骨架对象
 * @param oldConfig 旧配置（保留 sniffer、rules 等手工设置）
 * @param subscriptions 订阅列表
 * @param options 生成选项
 * @returns {skeleton, warnings} skeleton 为配置对象，warnings 为警告列表
 */
export function buildSkeleton(
  oldConfig: ParsedYaml,
  subscriptions: Subscription[],
  options?: SkeletonOptions
): {
  skeleton: ParsedYaml
  warnings: string[]
}

/**
 * 生成 proxy-providers 段
 */
export function buildProviders(
  subscriptions: Subscription[],
  testUrl: string
): Record<string, unknown>

/**
 * 生成 proxy-groups 段
 */
export function buildGroups(
  subscriptions: Subscription[],
  regions: RegionDef[],
  testUrl: string
): unknown[]

/**
 * 改写 rules 中的组引用（处理重命名与缺失的组）
 * @returns {rules, missing} rules 为新规则列表，missing 为缺失的组名与出现次数
 */
export function rewriteRules(
  rules: string[],
  groupNames: Set<string>
): {
  rules: string[]
  missing: Map<string, number>
}

/**
 * 生成订阅域名直连规则（防止拉取订阅时死锁）
 */
export function subscriptionDirectRules(subscriptions: Subscription[]): string[]
```

#### 重构要点

**从 migrate-config.mjs 迁移的常量：**
- `REGIONS`: 9 个区域组定义
- `DNS_UPSTREAM`: 本机实测可用的 DNS 上游
- `EXCLUDE_FILTER`: 过滤机场广告节点的正则
- `RENAME_GROUPS`: 旧组名到新组名的映射
- `PURPOSE_GROUPS`: 用途分流组（AI、Google、YouTube 等）

**纯函数设计：**
- 所有函数无副作用，输入相同则输出相同
- 不直接读写文件，文件操作由 ConfigManager 负责
- 返回警告列表而非直接 console.log

**警告类型：**
- `rules 中 3 条指向的组 'AI-fallback' 已不存在，改指向'兜底分流'`
- `dns.enable: false → true，17 行 nameserver-policy 将开始生效`

---

### 4.3 配置管理器 (`src/config/manager.ts`)

#### 类实现

```typescript
/**
 * 配置管理器：负责备份、校验、写入、回滚
 */
export class ConfigManager {
  constructor(
    /** mihomo 配置目录（默认 ~/.config/mihomo） */
    readonly mihomoDir: string,
    /** mihomo 二进制路径（用于 -t 校验） */
    readonly mihomoBin: string
  )

  /**
   * 读取当前配置文件
   * @throws {Error} 文件不存在或解析失败
   */
  loadConfig(): ParsedYaml

  /**
   * 备份当前配置
   * @returns 备份文件路径（如 config.yaml.bak.20260817-012345）
   */
  backup(): string

  /**
   * 用 mihomo -t 校验配置（在临时目录）
   * @returns {ok: true} | {ok: false, output: string}
   */
  validate(yamlText: string): { ok: true } | { ok: false; output: string }

  /**
   * 写入新配置（原子操作：先写 .tmp 再 rename）
   * @throws {Error} 写入失败
   */
  writeConfig(yamlText: string): void

  /**
   * 从备份回滚
   * @throws {Error} 备份文件不存在或复制失败
   */
  rollback(backupPath: string): void

  /**
   * 确保 providers 缓存目录存在
   */
  ensureProvidersDir(): void

  /**
   * 删除指定 provider 的缓存文件
   * @param name provider 名称
   */
  deleteProviderCache(name: string): void

  /**
   * 完整流程：生成 + 备份 + 校验 + 写入
   * @returns 成功返回 {ok: true, backupPath, warnings}
   *          失败返回 {ok: false, error, phase}
   *          phase 为失败阶段：'generate' | 'backup' | 'validate' | 'write'
   */
  applyConfig(
    subscriptions: Subscription[],
    options?: { enableDns?: boolean }
  ): 
    | { ok: true; backupPath: string; warnings: string[] }
    | { ok: false; error: string; phase: string }
}
```

#### 实现要点

**备份文件名格式：**
```typescript
const timestamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\..+$/, '')
  .replace('T', '-')
// => "20260817-012345"
const backupPath = `${configPath}.bak.${timestamp}`
```

**校验流程（临时目录）：**
1. 创建临时目录：`mkdtempSync(join(tmpdir(), 'mihomo-validate-'))`
2. 写入配置到 `<tmpdir>/config.yaml`
3. 执行 `mihomo -t -d <tmpdir> -f <tmpdir>/config.yaml`
4. 解析 stdout/stderr
5. 清理临时目录

**原子写入流程：**
```typescript
const tmpPath = `${configPath}.tmp`
writeFileSync(tmpPath, yamlText, 'utf8')
renameSync(tmpPath, configPath)  // 原子操作
```

**回滚流程：**
```typescript
if (!existsSync(backupPath)) throw new Error('备份文件不存在')
copyFileSync(backupPath, configPath)
```

---

### 4.4 服务管理器 (`src/config/service.ts`)

#### 类实现

```typescript
/**
 * systemd 服务管理器
 */
export class ServiceManager {
  constructor(readonly serviceName: string = 'mihomo')

  /**
   * 检查服务是否运行
   * @returns true 表示 active，false 表示其他状态
   */
  async isActive(): Promise<boolean>

  /**
   * 重启服务
   * @throws {Error} 重启失败，包含 stderr 输出
   */
  async restart(): Promise<void>

  /**
   * 获取服务状态（用于错误诊断）
   * @returns systemctl status 的完整输出
   */
  async status(): Promise<string>
}
```

#### 实现要点

**isActive 实现：**
```typescript
async isActive(): Promise<boolean> {
  try {
    const result = await execPromise(
      'systemctl',
      ['--user', 'is-active', this.serviceName]
    )
    return result.stdout.trim() === 'active'
  } catch {
    return false
  }
}
```

**restart 实现：**
```typescript
async restart(): Promise<void> {
  try {
    await execPromise(
      'systemctl',
      ['--user', 'restart', this.serviceName],
      { timeout: 10000 }
    )
  } catch (err) {
    const stderr = err.stderr || err.message
    throw new Error(`重启服务失败: ${stderr}`)
  }
}
```

**status 实现：**
```typescript
async status(): Promise<string> {
  try {
    const result = await execPromise(
      'systemctl',
      ['--user', 'status', this.serviceName]
    )
    return result.stdout
  } catch (err) {
    return err.stdout || err.stderr || err.message
  }
}
```

---

## 5. TUI 交互组件设计

### 5.1 通用输入对话框 (`src/components/InputDialog.tsx`)

#### 组件接口

```typescript
export interface InputField {
  /** 字段名（显示用） */
  label: string
  /** 字段键 */
  key: string
  /** 占位符 */
  placeholder?: string
  /** 是否必填 */
  required?: boolean
  /** 校验函数，返回错误信息或 undefined */
  validate?: (value: string) => string | undefined
  /** 是否密码字段（显示为 *** ） */
  secret?: boolean
}

export interface InputDialogProps {
  title: string
  fields: InputField[]
  width?: number
  /** 提交回调 */
  onSubmit: (values: Record<string, string>) => void
  /** 取消回调 */
  onCancel: () => void
}

export function InputDialog(props: InputDialogProps): JSX.Element
```

#### 交互逻辑

**键盘操作：**
- 输入字符：更新当前字段值，触发实时校验
- `↑`/`↓`: 切换字段
- `Tab`: 下一个字段
- `Enter`: 当前字段通过校验则进入下一字段，最后一个字段则提交
- `ESC`: 取消

**实时校验：**
- 每次输入后立即调用 `field.validate(value)`
- 错误信息显示在字段下方（红色）
- 有错误时禁止提交

**显示效果：**

```
┌─ 新增订阅 ──────────────────────────────────┐
│                                            │
│  订阅名称 (只能包含字母数字与 -_)           │
│  > my-airport_                             │
│  ✓ 名称格式正确                             │
│                                            │
│  订阅 URL                                  │
│    https://example.com/subscribe?token=... │
│                                            │
│  节点前缀 (可选，如 [M] )                   │
│    [M]                                     │
│                                            │
│  ↑↓ 切换字段  Enter 下一步  ESC 取消        │
└────────────────────────────────────────────┘
```

**错误显示：**

```
┌─ 新增订阅 ──────────────────────────────────┐
│                                            │
│  订阅名称 (只能包含字母数字与 -_)           │
│  > my airport                              │
│  ✗ 名称不能包含空格                         │
│                                            │
│  ...                                       │
└────────────────────────────────────────────┘
```

---

### 5.2 确认对话框 (`src/components/ConfirmDialog.tsx`)

#### 组件接口

```typescript
export interface ConfirmDialogProps {
  title: string
  message: string | string[]  // 支持多行消息
  /** 高危操作用红色显示 */
  danger?: boolean
  /** 确认回调 */
  onConfirm: () => void
  /** 取消回调 */
  onCancel: () => void
}

export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element
```

#### 交互逻辑

**键盘操作：**
- `y` 或 `Y`: 确认
- `n` 或 `N` 或 `ESC`: 取消

**显示效果：**

```
┌─ 确认删除 ──────────────────────────────┐
│                                        │
│  确定删除订阅 "yuetoto" 吗？            │
│                                        │
│  这将执行以下操作：                     │
│  • 从订阅清单中移除                     │
│  • 删除代理组 "机场-yuetoto"            │
│  • 清理缓存文件 providers/yuetoto.yaml │
│  • 重启 mihomo 服务                    │
│                                        │
│  此操作不可撤销！                       │
│                                        │
│  y 确认  n 取消                         │
└────────────────────────────────────────┘
```

---

### 5.3 进度对话框 (`src/components/ProgressDialog.tsx`)

#### 组件接口

```typescript
export interface ProgressDialogProps {
  title: string
  /** 当前步骤描述 */
  current: string
  /** 总步骤数 */
  total: number
  /** 当前步骤索引（从 0 开始） */
  step: number
  /** 已完成的步骤列表 */
  completed?: string[]
  /** 是否可取消 */
  cancelable?: boolean
  onCancel?: () => void
}

export function ProgressDialog(props: ProgressDialogProps): JSX.Element
```

#### 显示效果

```
┌─ 正在添加订阅 ──────────────────────────┐
│                                        │
│  [3/6] 正在生成新配置...                │
│  ████████████░░░░░░░░░░░░░  50%        │
│                                        │
│  已完成：                               │
│  ✓ 校验订阅信息                         │
│  ✓ 更新订阅清单                         │
│  • 正在生成新配置...                    │
│                                        │
│  ESC 取消                               │
└────────────────────────────────────────┘
```

---

## 6. 完整业务流程

### 6.1 新增订阅流程

#### 步骤概览

1. **用户输入** - 显示表单，收集名称、URL、前缀
2. **校验输入** - 检查格式、重复性
3. **更新订阅清单** - 追加到 subscriptions.json
4. **生成新配置** - 调用 buildSkeleton 生成完整配置
5. **备份旧配置** - 创建 config.yaml.bak.{timestamp}
6. **校验新配置** - 用 mihomo -t 校验
7. **写入新配置** - 原子写入 config.yaml
8. **重启服务** - systemctl --user restart mihomo
9. **验证服务状态** - 检查服务是否正常运行

#### 详细实现

```typescript
async function handleAddSubscription(input: {
  name: string
  url: string
  prefix?: string
}) {
  const steps = [
    '校验订阅信息',
    '更新订阅清单',
    '生成新配置',
    '备份旧配置',
    '写入新配置',
    '重启服务',
    '验证服务状态'
  ]
  
  let currentStep = 0
  let backupPath: string | undefined
  let oldSubs: Subscription[] | undefined
  
  // 辅助函数：更新进度对话框
  const updateProgress = (step: number, message: string) => {
    setDialog({
      type: 'progress',
      title: '正在添加订阅',
      step,
      total: steps.length,
      current: message,
      completed: steps.slice(0, step)
    })
  }
  
  try {
    // ===== 步骤 1: 校验订阅信息 =====
    updateProgress(currentStep++, steps[0])
    
    const validation = validateSubscription({
      name: input.name.trim(),
      url: input.url.trim(),
      prefix: input.prefix?.trim()
    })
    
    if (!validation.ok) {
      throw new Error(validation.error)
    }
    
    const newSub = validation.data
    
    // ===== 步骤 2: 更新订阅清单 =====
    updateProgress(currentStep++, steps[1])
    
    oldSubs = loadSubscriptions()
    
    if (isDuplicateName(newSub.name, oldSubs)) {
      throw new Error(`订阅名称 "${newSub.name}" 已存在`)
    }
    
    const newSubs = [...oldSubs, newSub]
    saveSubscriptions(newSubs)
    
    // ===== 步骤 3: 生成新配置 =====
    updateProgress(currentStep++, steps[2])
    
    const manager = new ConfigManager(config.mihomoDir, mihomoBin)
    const oldConfig = manager.loadConfig()
    const { skeleton, warnings } = buildSkeleton(oldConfig, newSubs)
    const yamlText = YAML.stringify(skeleton, {
      lineWidth: 0,
      singleQuote: true
    })
    
    // ===== 步骤 4: 备份旧配置 =====
    updateProgress(currentStep++, steps[3])
    
    backupPath = manager.backup()
    
    // ===== 步骤 5: 校验并写入新配置 =====
    updateProgress(currentStep++, steps[4])
    
    // 先在临时目录校验
    const validateResult = manager.validate(yamlText)
    if (!validateResult.ok) {
      throw new Error(`配置校验失败:\n${validateResult.output}`)
    }
    
    // 写入
    manager.writeConfig(yamlText)
    
    // 写入后再次校验（带真实的 provider 目录）
    const configPath = join(config.mihomoDir, 'config.yaml')
    const realValidate = manager.validate(readFileSync(configPath, 'utf8'))
    if (!realValidate.ok) {
      manager.rollback(backupPath)
      throw new Error(
        `配置写入后校验失败（已回滚）:\n${realValidate.output}`
      )
    }
    
    // 确保 providers 目录存在
    manager.ensureProvidersDir()
    
    // ===== 步骤 6: 重启服务 =====
    updateProgress(currentStep++, steps[5])
    
    const service = new ServiceManager()
    await service.restart()
    
    // ===== 步骤 7: 验证服务状态 =====
    updateProgress(currentStep++, steps[6])
    
    // 等待服务完全启动
    await new Promise(resolve => setTimeout(resolve, 1500))
    
    const isActive = await service.isActive()
    if (!isActive) {
      // 服务挂了，回滚所有变更
      manager.rollback(backupPath)
      saveSubscriptions(oldSubs)
      await service.restart()
      
      const statusOutput = await service.status()
      throw new Error(
        `服务启动失败（已回滚）:\n${statusOutput}`
      )
    }
    
    // ===== 成功 =====
    setDialog({ type: 'none' })
    onMessage(`✓ 订阅 "${newSub.name}" 添加成功`)
    
    // 显示警告（如有）
    if (warnings.length > 0) {
      onMessage(`⚠ ${warnings[0]}`)
    }
    
    providers.refresh()
    
  } catch (err) {
    // ===== 错误处理与回滚 =====
    const errorPhase = steps[currentStep - 1] || '未知阶段'
    
    // 判断是否需要回滚
    if (currentStep >= 2 && oldSubs) {
      // 已修改订阅清单，需要回滚
      try {
        saveSubscriptions(oldSubs)
        if (backupPath) {
          const manager = new ConfigManager(config.mihomoDir, mihomoBin)
          manager.rollback(backupPath)
          const service = new ServiceManager()
          await service.restart()
        }
      } catch (rollbackErr) {
        setDialog({
          type: 'error',
          message: `原错误: ${err.message}\n\n回滚失败: ${rollbackErr.message}`
        })
        return
      }
    }
    
    setDialog({
      type: 'error',
      message: `添加失败（${errorPhase}）:\n${err.message}`
    })
  }
}
```

#### 错误处理策略

| 失败阶段 | 已修改内容 | 回滚操作 | 用户提示 |
|---------|-----------|---------|---------|
| 步骤 1（校验输入） | 无 | 无需回滚 | "订阅名称格式错误" |
| 步骤 2（更新清单） | subscriptions.json | 从内存恢复旧值 | "保存订阅清单失败" |
| 步骤 3（生成配置） | subscriptions.json | 从内存恢复旧值 | "生成配置失败：..." |
| 步骤 4（备份） | subscriptions.json | 从内存恢复旧值 | "无法创建备份" |
| 步骤 5（写入） | subscriptions.json + config.yaml | 恢复订阅清单 + 从备份恢复配置 | "配置写入失败（已回滚）" |
| 步骤 6（重启） | 全部 | 全部回滚 + 重启服务 | "服务重启失败（已回滚）" |
| 步骤 7（验证） | 全部 | 全部回滚 + 重启服务 | "服务启动失败（已回滚）：[status 输出]" |

---

### 6.2 删除订阅流程

#### 步骤概览

1. **显示确认对话框** - 列出将被删除的内容
2. **用户确认** - 按 `y` 确认
3. **加载订阅清单** - 读取现有订阅
4. **更新订阅清单** - 过滤掉要删除的订阅
5. **重新生成配置** - 调用 buildSkeleton
6. **备份旧配置** - 创建备份
7. **写入新配置** - 原子写入
8. **清理缓存文件** - 删除 providers/{name}.yaml
9. **重启服务** - systemctl restart
10. **验证服务状态** - 检查服务

#### 详细实现

```typescript
async function handleDeleteSubscription(name: string) {
  // 先显示确认对话框
  setDialog({
    type: 'confirm',
    title: '确认删除',
    message: [
      `确定删除订阅 "${name}" 吗？`,
      '',
      '这将执行以下操作：',
      '• 从订阅清单中移除',
      `• 删除代理组 "机场-${name}"`,
      `• 清理缓存文件 providers/${name}.yaml`,
      '• 重启 mihomo 服务',
      '',
      '此操作不可撤销！'
    ],
    danger: true,
    onConfirm: () => confirmDelete(name),
    onCancel: () => setDialog({ type: 'none' })
  })
}

async function confirmDelete(name: string) {
  const steps = [
    '加载订阅清单',
    '更新订阅清单',
    '重新生成配置',
    '备份旧配置',
    '写入新配置',
    '清理缓存文件',
    '重启服务',
    '验证服务状态'
  ]
  
  let currentStep = 0
  let backupPath: string | undefined
  let oldSubs: Subscription[] | undefined
  
  const updateProgress = (step: number, message: string) => {
    setDialog({
      type: 'progress',
      title: '正在删除订阅',
      step,
      total: steps.length,
      current: message,
      completed: steps.slice(0, step)
    })
  }
  
  try {
    // ===== 步骤 1: 加载订阅清单 =====
    updateProgress(currentStep++, steps[0])
    
    oldSubs = loadSubscriptions()
    const newSubs = oldSubs.filter(s => s.name !== name)
    
    if (newSubs.length === oldSubs.length) {
      throw new Error(`订阅 "${name}" 不存在`)
    }
    
    if (newSubs.length === 0) {
      throw new Error('不能删除最后一个订阅')
    }
    
    // ===== 步骤 2: 更新订阅清单 =====
    updateProgress(currentStep++, steps[1])
    saveSubscriptions(newSubs)
    
    // ===== 步骤 3-5: 生成、备份、写入配置 =====
    updateProgress(currentStep++, steps[2])
    
    const manager = new ConfigManager(config.mihomoDir, mihomoBin)
    const oldConfig = manager.loadConfig()
    const { skeleton } = buildSkeleton(oldConfig, newSubs)
    const yamlText = YAML.stringify(skeleton, {
      lineWidth: 0,
      singleQuote: true
    })
    
    updateProgress(currentStep++, steps[3])
    backupPath = manager.backup()
    
    updateProgress(currentStep++, steps[4])
    const validateResult = manager.validate(yamlText)
    if (!validateResult.ok) {
      throw new Error(`配置校验失败:\n${validateResult.output}`)
    }
    manager.writeConfig(yamlText)
    
    // ===== 步骤 6: 清理缓存文件 =====
    updateProgress(currentStep++, steps[5])
    manager.deleteProviderCache(name)
    
    // ===== 步骤 7-8: 重启并验证 =====
    updateProgress(currentStep++, steps[6])
    const service = new ServiceManager()
    await service.restart()
    
    updateProgress(currentStep++, steps[7])
    await new Promise(resolve => setTimeout(resolve, 1500))
    
    const isActive = await service.isActive()
    if (!isActive) {
      manager.rollback(backupPath)
      saveSubscriptions(oldSubs)
      await service.restart()
      
      const statusOutput = await service.status()
      throw new Error(`服务启动失败（已回滚）:\n${statusOutput}`)
    }
    
    // ===== 成功 =====
    setDialog({ type: 'none' })
    onMessage(`✓ 订阅 "${name}" 已删除`)
    providers.refresh()
    
  } catch (err) {
    // 回滚逻辑与新增订阅相同
    if (currentStep >= 2 && oldSubs) {
      try {
        saveSubscriptions(oldSubs)
        if (backupPath) {
          const manager = new ConfigManager(config.mihomoDir, mihomoBin)
          manager.rollback(backupPath)
          const service = new ServiceManager()
          await service.restart()
        }
      } catch (rollbackErr) {
        setDialog({
          type: 'error',
          message: `删除失败且回滚失败:\n${err.message}\n\n${rollbackErr.message}`
        })
        return
      }
    }
    
    setDialog({
      type: 'error',
      message: `删除失败: ${err.message}`
    })
  }
}
```

---

### 6.3 编辑订阅流程

#### 功能范围

- **可编辑字段**：`prefix`（节点前缀）
- **不可编辑字段**：`name`（订阅名称）、`url`（订阅链接）

#### 实现

```typescript
async function handleEditSubscription(name: string) {
  const subs = loadSubscriptions()
  const target = subs.find(s => s.name === name)
  
  if (!target) {
    onMessage(`订阅 "${name}" 不存在`)
    return
  }
  
  setDialog({
    type: 'input',
    title: '编辑订阅',
    fields: [
      {
        label: `订阅名称: ${name} (不可修改)`,
        key: '_readonly',
        value: '',
        disabled: true
      },
      {
        label: '节点前缀 (可选，如 [M] )',
        key: 'prefix',
        value: target.prefix || '',
        placeholder: '[M] ',
        validate: (value) => {
          if (value.length > 10) {
            return '前缀长度不能超过 10 字符'
          }
          return undefined
        }
      }
    ],
    onSubmit: async (values) => {
      const newPrefix = values.prefix.trim() || undefined
      
      // 前缀没变化，直接返回
      if (newPrefix === target.prefix) {
        setDialog({ type: 'none' })
        onMessage('未做修改')
        return
      }
      
      // 更新订阅清单
      const updated = subs.map(s =>
        s.name === name ? { ...s, prefix: newPrefix } : s
      )
      
      // 执行完整的配置更新流程
      await applySubscriptionChange(updated, '正在更新订阅')
      
      setDialog({ type: 'none' })
      onMessage(`✓ 订阅 "${name}" 已更新`)
      providers.refresh()
    },
    onCancel: () => setDialog({ type: 'none' })
  })
}

/**
 * 通用的订阅变更应用函数（新增、删除、编辑都复用）
 */
async function applySubscriptionChange(
  newSubs: Subscription[],
  progressTitle: string
) {
  const oldSubs = loadSubscriptions()
  let backupPath: string | undefined
  
  try {
    saveSubscriptions(newSubs)
    
    const manager = new ConfigManager(config.mihomoDir, mihomoBin)
    const oldConfig = manager.loadConfig()
    const { skeleton, warnings } = buildSkeleton(oldConfig, newSubs)
    const yamlText = YAML.stringify(skeleton, { lineWidth: 0, singleQuote: true })
    
    backupPath = manager.backup()
    
    const validateResult = manager.validate(yamlText)
    if (!validateResult.ok) {
      throw new Error(`配置校验失败:\n${validateResult.output}`)
    }
    
    manager.writeConfig(yamlText)
    
    const service = new ServiceManager()
    await service.restart()
    
    await new Promise(resolve => setTimeout(resolve, 1500))
    const isActive = await service.isActive()
    if (!isActive) {
      manager.rollback(backupPath)
      saveSubscriptions(oldSubs)
      await service.restart()
      throw new Error('服务启动失败（已回滚）')
    }
    
    if (warnings.length > 0) {
      onMessage(`⚠ ${warnings[0]}`)
    }
    
  } catch (err) {
    // 回滚
    saveSubscriptions(oldSubs)
    if (backupPath) {
      const manager = new ConfigManager(config.mihomoDir, mihomoBin)
      manager.rollback(backupPath)
      const service = new ServiceManager()
      await service.restart()
    }
    throw err
  }
}
```

---

## 7. 订阅视图增强

### 7.1 状态管理

#### 对话框状态

```typescript
type DialogState = 
  | { type: 'none' }
  | { type: 'input'; props: InputDialogProps }
  | { type: 'confirm'; props: ConfirmDialogProps }
  | { type: 'progress'; props: ProgressDialogProps }
  | { type: 'error'; message: string }

const [dialog, setDialog] = useState<DialogState>({ type: 'none' })
```

### 7.2 快捷键扩展

**现有快捷键：**
- `↑↓jk` - 移动光标
- `u` - 更新当前订阅
- `U` - 更新全部订阅
- `c` - 健康检查
- `Enter` - 展开节点列表
- `r` - 刷新

**新增快捷键：**
- `a` - 新增订阅
- `d` - 删除当前订阅
- `e` - 编辑当前订阅

### 7.3 键盘事件处理

```typescript
useInput(
  (input, key) => {
    // 对话框打开时，键盘事件由对话框处理
    if (dialog.type !== 'none') return
    
    // 导航
    if (key.upArrow || input === 'k') {
      setIndex((i) => Math.max(0, i - 1))
      return
    }
    if (key.downArrow || input === 'j') {
      setIndex((i) => Math.min(rows.length - 1, i + 1))
      return
    }
    
    // 新增订阅
    if (input === 'a') {
      setDialog({
        type: 'input',
        props: {
          title: '新增订阅',
          fields: [
            {
              label: '订阅名称 (只能包含字母数字与 -_)',
              key: 'name',
              required: true,
              validate: (value) => {
                if (!/^[a-z0-9_-]+$/i.test(value)) {
                  return '名称只能包含字母数字与 -_'
                }
                if (value.length < 1 || value.length > 32) {
                  return '名称长度必须在 1-32 字符之间'
                }
                const existing = providers.providers.map(p => p.name)
                if (existing.includes(value)) {
                  return '订阅名称已存在'
                }
                return undefined
              }
            },
            {
              label: '订阅 URL',
              key: 'url',
              required: true,
              validate: (value) => {
                try {
                  new URL(value)
                  if (!value.startsWith('http://') && !value.startsWith('https://')) {
                    return 'URL 必须以 http:// 或 https:// 开头'
                  }
                  if (value.length > 2048) {
                    return 'URL 长度不能超过 2048 字符'
                  }
                  return undefined
                } catch {
                  return 'URL 格式错误'
                }
              }
            },
            {
              label: '节点前缀 (可选，如 [M] )',
              key: 'prefix',
              placeholder: '[M] ',
              validate: (value) => {
                if (value.length > 10) {
                  return '前缀长度不能超过 10 字符'
                }
                return undefined
              }
            }
          ],
          onSubmit: (values) => {
            void handleAddSubscription(values)
          },
          onCancel: () => setDialog({ type: 'none' })
        }
      })
      return
    }
    
    // 删除订阅
    if (input === 'd' && current) {
      void handleDeleteSubscription(current.name)
      return
    }
    
    // 编辑订阅
    if (input === 'e' && current) {
      void handleEditSubscription(current.name)
      return
    }
    
    // 更新订阅
    if (input === 'u' && current) {
      onMessage(`正在更新 ${current.name} ...`)
      void providers.update(current.name).then(() => {
        onMessage(`${current.name} 更新完成`)
      })
      return
    }
    
    // 其他快捷键保持不变...
  },
  { isActive: active }
)
```

### 7.4 渲染逻辑

```typescript
return (
  <Box flexDirection="column" flexGrow={1}>
    {/* 订阅列表 */}
    <Text bold underline>
      {padDisplay('NAME', 14)}
      {padDisplay('NODES', 12)}
      {padDisplay('USAGE', 14)}
      {'UPDATED'}
    </Text>
    
    <ScrollList
      items={rows}
      selected={index}
      height={listHeight}
      emptyText="当前配置没有 proxy-providers"
      renderItem={(row, _i, isSelected) => (
        <Text
          color={isSelected ? 'black' : undefined}
          backgroundColor={isSelected ? 'cyan' : undefined}
        >
          {`${isSelected ? '>' : ' '} `}
          {padDisplay(row.name, 12)}
          {row.updating ? (
            <Text color="cyan">{padDisplay(`${spinnerFrame(tick)} 更新中`, 12)}</Text>
          ) : (
            <Text color={row.alive > 0 ? 'green' : 'red'}>
              {padDisplay(`${row.alive}/${row.nodes}`, 12)}
            </Text>
          )}
          {padDisplay(row.remaining === undefined ? '---' : formatBytes(row.remaining), 14)}
          {formatRelativeTime(row.updatedAt)}
        </Text>
      )}
    />
    
    {/* 错误提示框 */}
    {current?.error ? (
      <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
        <Text color="red" bold>
          {`${current.name} 更新失败`}
        </Text>
        <Text color="red" wrap="wrap">
          {current.error}
        </Text>
      </Box>
    ) : null}
    
    {/* 对话框渲染 */}
    {dialog.type === 'input' ? <InputDialog {...dialog.props} /> : null}
    {dialog.type === 'confirm' ? <ConfirmDialog {...dialog.props} /> : null}
    {dialog.type === 'progress' ? <ProgressDialog {...dialog.props} /> : null}
    {dialog.type === 'error' ? (
      <Box borderStyle="round" borderColor="red" paddingX={1}>
        <Text color="red">{dialog.message}</Text>
        <Text dimColor>按任意键关闭</Text>
      </Box>
    ) : null}
    
    {/* 底部快捷键提示 */}
    <Text dimColor>
      {' ↑↓ 移动  a 新增  d 删除  e 编辑  u 更新  U 全部更新  c 健康检查  Enter 展开节点  r 刷新'}
    </Text>
  </Box>
)
```

---

## 8. 实施计划

### 8.1 开发阶段划分

#### **阶段 1：基础模块重构（2-3 天）**

**目标：** 将 migrate-config.mjs 的核心逻辑重构为 TypeScript 模块

**任务清单：**
1. 创建 `src/config/types.ts` - 共享类型定义
2. 创建 `src/config/subscriptions.ts` - 订阅文件操作
   - 实现 `loadSubscriptions()`
   - 实现 `saveSubscriptions()` 带原子写入
   - 实现 `validateSubscription()`
   - 实现 `isDuplicateName()`
   - 实现 `redactUrl()`
   - 编写单元测试
3. 创建 `src/config/skeleton.ts` - 配置生成
   - 迁移常量（REGIONS、DNS_UPSTREAM 等）
   - 实现 `buildProviders()`
   - 实现 `buildGroups()`
   - 实现 `rewriteRules()`
   - 实现 `subscriptionDirectRules()`
   - 实现 `buildSkeleton()`
   - 编写单元测试
4. 创建 `src/config/manager.ts` - 配置管理器
   - 实现 `loadConfig()`
   - 实现 `backup()`
   - 实现 `validate()`
   - 实现 `writeConfig()` 带原子写入
   - 实现 `rollback()`
   - 实现 `ensureProvidersDir()`
   - 实现 `deleteProviderCache()`
   - 实现 `applyConfig()`
   - 编写集成测试
5. 创建 `src/config/service.ts` - 服务管理器
   - 实现 `isActive()`
   - 实现 `restart()`
   - 实现 `status()`
   - 编写集成测试（需要真实 systemd 环境）

**验收标准：**
- ✅ 所有模块通过类型检查（`npm run typecheck`）
- ✅ 单元测试覆盖率 ≥ 80%
- ✅ 能够通过命令行测试完整流程（读取订阅 → 生成配置 → 校验）
- ✅ 保持 migrate-config.mjs 脚本可用（作为对照组）

---

#### **阶段 2：TUI 交互组件（1-2 天）**

**目标：** 实现通用的对话框组件

**任务清单：**
1. 创建 `src/components/InputDialog.tsx`
   - 实现多字段表单
   - 实现实时校验与错误显示
   - 实现键盘导航（Tab、Enter、ESC）
   - 测试不同字段组合
2. 创建 `src/components/ConfirmDialog.tsx`
   - 实现确认/取消逻辑
   - 实现 danger 模式（红色警告）
   - 测试多行消息显示
3. 创建 `src/components/ProgressDialog.tsx`
   - 实现进度条渲染
   - 实现已完成步骤列表
   - 实现取消逻辑（可选）
   - 测试长步骤名称的显示

**验收标准：**
- ✅ 所有组件在 Ink 环境中正常渲染
- ✅ 键盘交互符合预期
- ✅ 错误信息清晰可读
- ✅ 窄终端（80 列）下布局不错乱

---

#### **阶段 3：业务流程集成（2-3 天）**

**目标：** 将配置管理模块与 TUI 集成，实现完整的增删改查

**任务清单：**
1. 增强 `src/views/Providers.tsx`
   - 添加对话框状态管理
   - 实现 `handleAddSubscription()`
   - 实现 `handleDeleteSubscription()`
   - 实现 `handleEditSubscription()`
   - 实现 `applySubscriptionChange()` 通用函数
   - 添加新快捷键（a、d、e）
   - 更新底部提示栏
2. 实现错误处理与回滚
   - 区分可恢复错误与不可恢复错误
   - 实现分阶段回滚逻辑
   - 展示详细错误信息（包含 systemctl 输出）
3. 实现进度反馈
   - 在每个步骤开始时更新进度对话框
   - 显示已完成步骤列表
4. 集成测试
   - 测试新增订阅（正常流程）
   - 测试新增订阅（各阶段失败场景）
   - 测试删除订阅（正常流程）
   - 测试删除订阅（服务启动失败场景）
   - 测试编辑订阅
   - 测试并发操作（连续按 a → ESC → a）

**验收标准：**
- ✅ 新增订阅成功后，TUI 自动刷新显示新订阅
- ✅ 删除订阅后，相关缓存文件已删除
- ✅ 任一步骤失败时，配置完全回滚到旧状态
- ✅ 服务启动失败时，能展示完整的 systemctl status 输出
- ✅ 用户可以随时按 ESC 取消操作（在进度开始前）

---

#### **阶段 4：文档与发布（1 天）**

**任务清单：**
1. 更新 `README.md`
   - 添加订阅管理功能说明
   - 更新快捷键列表
   - 添加常见问题（如"订阅名称已存在"怎么办）
2. 更新 `DEVELOPMENT.md`
   - 添加配置管理模块的架构说明
   - 更新模块依赖图
   - 添加单元测试运行指南
3. 创建 `CHANGELOG.md`
   - 记录 v0.2.0 的新功能
   - 记录破坏性变更（如有）
4. Git 提交
   - 按模块分别提交（phase-1、phase-2、phase-3）
   - 编写详细的 commit message
5. 打标签与发布
   - `git tag v0.2.0`
   - 推送到远程仓库

**验收标准：**
- ✅ 文档覆盖所有新功能
- ✅ 示例截图清晰
- ✅ Git 历史清晰可读

---

### 8.2 测试策略

#### **单元测试（Jest + ts-jest）**

**测试范围：**
- `src/config/subscriptions.ts` - 所有导出函数
- `src/config/skeleton.ts` - 所有导出函数
- `src/config/manager.ts` - 除 systemctl 调用外的所有函数

**测试用例示例：**

```typescript
// src/config/__tests__/subscriptions.test.ts
describe('validateSubscription', () => {
  it('应接受合法的订阅', () => {
    const result = validateSubscription({
      name: 'my-airport',
      url: 'https://example.com/sub',
      prefix: '[M] '
    })
    expect(result.ok).toBe(true)
  })
  
  it('应拒绝包含空格的名称', () => {
    const result = validateSubscription({
      name: 'my airport',
      url: 'https://example.com/sub'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('名称只能包含字母数字与 -_')
  })
  
  it('应拒绝非法 URL', () => {
    const result = validateSubscription({
      name: 'test',
      url: 'not-a-url'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('URL 格式错误')
  })
})
```

---

#### **集成测试（手动测试脚本）**

**测试脚本：** `scripts/test-subscription-mgmt.sh`

```bash
#!/bin/bash
# 测试订阅管理功能的集成测试脚本

set -e

echo "=== 订阅管理功能集成测试 ==="

# 1. 备份现有配置
echo "1. 备份现有配置..."
cp ~/.config/mihomo/config.yaml /tmp/config.yaml.backup
cp ~/.config/mihomo-tui/subscriptions.json /tmp/subscriptions.json.backup

# 2. 测试新增订阅（使用 Node.js 脚本）
echo "2. 测试新增订阅..."
node -e "
const { addSubscription } = require('./dist/config/manager.js');
addSubscription({
  name: 'test-airport',
  url: 'https://example.com/sub?token=test',
  prefix: '[T] '
}).then(() => console.log('✓ 新增成功')).catch(err => {
  console.error('✗ 新增失败:', err.message);
  process.exit(1);
});
"

# 3. 验证服务状态
echo "3. 验证服务状态..."
if systemctl --user is-active mihomo; then
  echo "✓ 服务运行正常"
else
  echo "✗ 服务未运行"
  exit 1
fi

# 4. 验证订阅清单
echo "4. 验证订阅清单..."
if grep -q "test-airport" ~/.config/mihomo-tui/subscriptions.json; then
  echo "✓ 订阅清单已更新"
else
  echo "✗ 订阅清单未更新"
  exit 1
fi

# 5. 验证配置文件
echo "5. 验证配置文件..."
if grep -q "test-airport" ~/.config/mihomo/config.yaml; then
  echo "✓ 配置文件已更新"
else
  echo "✗ 配置文件未更新"
  exit 1
fi

# 6. 测试删除订阅
echo "6. 测试删除订阅..."
node -e "
const { deleteSubscription } = require('./dist/config/manager.js');
deleteSubscription('test-airport').then(() => {
  console.log('✓ 删除成功');
}).catch(err => {
  console.error('✗ 删除失败:', err.message);
  process.exit(1);
});
"

# 7. 恢复原配置
echo "7. 恢复原配置..."
cp /tmp/config.yaml.backup ~/.config/mihomo/config.yaml
cp /tmp/subscriptions.json.backup ~/.config/mihomo-tui/subscriptions.json
systemctl --user restart mihomo

echo "=== 所有测试通过 ==="
```

---

#### **TUI 手动测试清单**

**测试场景：**

1. **新增订阅 - 正常流程**
   - [ ] 按 `a` 打开表单
   - [ ] 输入名称、URL、前缀
   - [ ] 观察实时校验（名称格式、URL 格式）
   - [ ] 提交后显示进度对话框
   - [ ] 进度条正常更新
   - [ ] 完成后列表自动刷新
   - [ ] 新订阅出现在列表中

2. **新增订阅 - 名称重复**
   - [ ] 输入已存在的订阅名称
   - [ ] 校验错误显示"订阅名称已存在"
   - [ ] 无法提交表单

3. **新增订阅 - URL 格式错误**
   - [ ] 输入非法 URL（如 `not-a-url`）
   - [ ] 校验错误显示"URL 格式错误"
   - [ ] 无法提交表单

4. **新增订阅 - 配置校验失败**
   - [ ] 手动修改 config.yaml 引入语法错误
   - [ ] 尝试新增订阅
   - [ ] 显示错误："配置校验失败: ..."
   - [ ] 订阅清单已回滚（未写入新订阅）

5. **删除订阅 - 正常流程**
   - [ ] 选中订阅后按 `d`
   - [ ] 显示确认对话框，列出将被删除的内容
   - [ ] 按 `y` 确认
   - [ ] 显示进度对话框
   - [ ] 完成后列表自动刷新
   - [ ] 订阅已从列表中消失
   - [ ] 缓存文件 `providers/{name}.yaml` 已删除

6. **删除订阅 - 取消操作**
   - [ ] 按 `d` 打开确认对话框
   - [ ] 按 `n` 或 `ESC` 取消
   - [ ] 对话框关闭，订阅未删除

7. **删除订阅 - 最后一个订阅**
   - [ ] 只剩一个订阅时按 `d`
   - [ ] 显示错误："不能删除最后一个订阅"

8. **编辑订阅 - 修改前缀**
   - [ ] 按 `e` 打开编辑表单
   - [ ] 修改前缀（如 `[Y] ` → `[YUE] `）
   - [ ] 提交后配置更新
   - [ ] 重启服务
   - [ ] TUI 刷新后前缀已变化

9. **并发操作测试**
   - [ ] 快速按 `a` → `ESC` → `a`
   - [ ] 表单状态正确
   - [ ] 按 `u` 更新订阅时按 `a`
   - [ ] 对话框正确显示（更新进度中不允许打开新对话框）

10. **错误恢复测试**
    - [ ] 新增订阅后立即停止 mihomo 服务
    - [ ] TUI 显示"服务启动失败（已回滚）"
    - [ ] 检查配置文件已回滚
    - [ ] 手动启动服务，服务正常运行

---

## 9. 风险与缓解

### 9.1 技术风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| **重构 migrate-config.mjs 时引入 Bug** | 高 - 可能破坏现有配置 | 中 | 1. 保留原脚本作为对照<br>2. 编写详尽的单元测试<br>3. 先在测试环境验证 |
| **systemctl 操作失败无法回滚** | 高 - 服务无法启动 | 低 | 1. 始终先备份配置<br>2. 失败时自动回滚并重启<br>3. 显示完整的 systemctl status 输出 |
| **原子写入失败导致配置损坏** | 高 - 配置文件损坏 | 极低 | 1. 使用 rename() 保证原子性<br>2. 写入前先写 .tmp 文件<br>3. 保留备份文件 |
| **订阅清单与配置文件不同步** | 中 - 订阅列表错乱 | 低 | 1. 清单和配置在同一事务中更新<br>2. 失败时两者同时回滚 |
| **TUI 在进度中卡死** | 中 - 用户体验差 | 低 | 1. 所有 async 操作设置超时<br>2. 允许用户按 ESC 中断（在安全点） |

### 9.2 用户体验风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| **新增订阅耗时过长** | 中 - 用户以为卡死 | 中 | 1. 显示详细进度（当前步骤）<br>2. 显示已完成步骤列表<br>3. 重启服务后等待 1.5 秒确保启动 |
| **错误信息难以理解** | 中 - 用户不知如何修复 | 中 | 1. 显示完整的 mihomo -t 输出<br>2. 显示 systemctl status 输出<br>3. 添加常见错误的解释 |
| **误删订阅** | 高 - 需要重新添加 | 低 | 1. 显示确认对话框<br>2. 列出将被删除的内容<br>3. 高亮"不可撤销"警告<br>4. 配置备份保留 7 天 |

---

## 10. 未来扩展

### 10.1 短期扩展（v0.3.0）

- **批量导入订阅**：从 JSON 文件导入多个订阅
- **导出订阅清单**：导出当前订阅为 JSON 文件（脱敏 URL）
- **订阅备注**：为每个订阅添加自定义备注
- **订阅测速**：测试订阅中所有节点的延迟

### 10.2 中期扩展（v0.4.0）

- **订阅分组**：将订阅分为"主力"、"备用"、"测试"等组
- **订阅模板**：保存常用的 provider 配置为模板
- **订阅历史**：记录订阅的更新历史（节点数变化、流量消耗）
- **自动更新**：定时自动更新所有订阅（可配置）

### 10.3 长期扩展（v1.0.0）

- **订阅转换**：支持多种订阅格式（SIP008、Clash、V2Ray）
- **订阅分享**：导出订阅配置供其他设备使用
- **订阅监控**：监控订阅的可用性、节点数变化、流量消耗趋势
- **Web 管理界面**：提供 Web UI 管理订阅（可选）

---

## 11. 附录

### 11.1 mihomo API 参考

**更新 Provider：**
```
PUT /providers/proxies/{name}
无 body
返回：204 No Content（成功）或 500（失败）
```

**健康检查：**
```
GET /providers/proxies/{name}/healthcheck
返回：204 No Content
```

**获取 Provider 列表：**
```
GET /providers/proxies
返回：{
  providers: {
    [name]: {
      name: string
      type: "Proxy"
      vehicleType: "HTTP" | "File" | "Compatible"
      proxies: ProxyItem[]
      subscriptionInfo?: {
        Upload: number
        Download: number
        Total: number
        Expire: number  // Unix 时间戳（秒）
      }
      updatedAt: string  // ISO 8601
    }
  }
}
```

### 11.2 配置文件格式参考

**subscriptions.json：**
```json
{
  "subscriptions": [
    {
      "name": "yuetoto",
      "prefix": "[Y] ",
      "url": "https://example.com/sub?token=xxx"
    }
  ]
}
```

**config.yaml（proxy-providers 段）：**
```yaml
proxy-providers:
  yuetoto:
    type: http
    url: https://example.com/sub?token=xxx
    path: ./providers/yuetoto.yaml
    interval: 3600
    exclude-filter: '(?i)(剩余|到期|官网|流量)'
    override:
      additional-prefix: '[Y] '
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 300
      lazy: true
```

### 11.3 参考资料

- [mihomo 官方文档](https://wiki.metacubex.one/)
- [mihomo API 参考](https://wiki.metacubex.one/config/api/)
- [Ink 官方文档](https://github.com/vadimdemedes/ink)
- [systemd 用户服务](https://www.freedesktop.org/software/systemd/man/systemd.service.html)

---

## 执行检查清单

在开始实施前，确认以下检查项：

- [ ] 所有技术决策已确认（方案 B、systemd、Linux only）
- [ ] 模块接口设计已评审
- [ ] 错误处理策略已明确
- [ ] 回滚机制已设计
- [ ] 测试策略已制定
- [ ] 开发环境已准备（Node 24、TypeScript 5.x、Jest）
- [ ] 备份机制已准备（手动备份现有配置）

---

**设计文档完成。准备进入实施阶段。**
