# mihomo-tui 开发文档

## 项目概述

mihomo-tui 是一个基于 Node.js + TypeScript + Ink 开发的终端管理工具，用于通过 REST API 控制 mihomo 代理内核。

**核心设计原则：**
- ✓ 运行时代码**绝不写** `config.yaml`，所有操作通过 API 完成
- ✓ 配置变更只由迁移脚本在显式 `--apply` 时执行，且强制备份 + 校验
- ✓ TUI 与 CLI 双模式，管道场景自动降级为 CLI
- ✓ 内存安全：环形缓冲、按需渲染、可见性控制

## 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Node.js | ≥ 22 | 运行时（内置 `fetch` 与 `WebSocket`，无需 ws/undici/axios）|
| TypeScript | 5.x | 类型安全（勿升级 7.x，Ink 生态尚未适配）|
| Ink | 7.x | TUI 框架（React for CLI）|
| React | 19.x | Ink 的 peer 依赖 |
| commander | 15.x | CLI 参数解析 |
| yaml | 2.x | 只用于读取配置做展示，不用于写 |

## 项目结构

```
mihomo-tui/
├── src/
│   ├── api/              # API 客户端层
│   │   ├── client.ts     # REST API 封装
│   │   ├── status.ts     # 状态数据组装
│   │   ├── stream.ts     # WebSocket 流基础设施
│   │   └── types.ts      # API 类型定义
│   ├── commands/         # CLI 命令实现
│   │   ├── conn.ts       # 连接管理（含 reload）
│   │   ├── logs.ts       # 日志查询
│   │   ├── output.ts     # 输出格式化与统一退出
│   │   ├── provider.ts   # 订阅管理
│   │   ├── proxy.ts      # 节点管理
│   │   └── status.ts     # 状态概览
│   ├── components/       # TUI 通用组件
│   │   ├── DelayBadge.tsx    # 延迟五状态着色标签
│   │   ├── ScrollList.tsx    # 可滚动列表
│   │   └── StatusBar.tsx     # 底部状态栏
│   ├── hooks/            # React Hooks
│   │   ├── useProxies.ts     # 节点数据（轮询 + 测速 + 切换）
│   │   ├── useProviders.ts   # 订阅数据（轮询 + 更新）
│   │   └── useStream.ts      # WebSocket 流（状态/日志/连接）
│   ├── views/            # TUI 标签页视图
│   │   ├── Conns.tsx         # [4] 连接
│   │   ├── Logs.tsx          # [3] 日志
│   │   ├── Providers.tsx     # [2] 订阅
│   │   └── Proxies.tsx       # [1] 节点
│   ├── App.tsx           # TUI 主入口（标签页容器 + 全局快捷键）
│   ├── cli.tsx           # CLI + TUI 路由
│   └── config.ts         # 配置管理
├── scripts/
│   └── migrate-config.mjs    # 配置迁移脚本（唯一允许写 config.yaml 的入口）
├── docs/                 # 设计与开发文档（本文件所在目录）
├── bin/mihomo-tui        # 可执行入口
├── README.md             # 用户文档
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
└── package.json
```

## 架构设计

### 1. API 客户端层 (`src/api/`)

**REST API 封装 (`client.ts`)**

```typescript
export class MihomoClient {
  constructor(config: Config)
  
  // 核心 API
  async version(): Promise<string>
  async configs(): Promise<ConfigResponse>
  async setMode(mode: 'rule' | 'global' | 'direct'): Promise<void>
  async reload(): Promise<void>
  
  // 节点管理
  async proxies(): Promise<Record<string, Proxy>>
  async selectProxy(group: string, node: string): Promise<void>
  async testDelay(node: string, url: string, timeout: number): Promise<number>
  
  // 订阅管理
  async providers(): Promise<Record<string, Provider>>
  async updateProvider(name: string): Promise<void>
  async healthCheck(name: string): Promise<void>
  
  // 连接管理
  async connections(): Promise<Connection[]>
  async closeConnection(id: string): Promise<void>
  async closeAllConnections(): Promise<void>
}
```

**WebSocket 流基础 (`stream.ts`)**

所有流共享同一个 WebSocket 连接，通过 `traffic`、`log`、`connections` 三个主题分发：

```typescript
export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface StreamOptions {
  onData: (data: any) => void
  onStateChange: (state: StreamState) => void
}

export function createStream(config: Config, topic: string, options: StreamOptions)
```

**内存安全机制：**
- 日志流使用 1000 行环形缓冲，自动淘汰旧数据
- 连接流直接替换整个列表，无累积
- 流在组件不可见时暂停渲染（通过 `visible` 参数控制）

### 2. TUI 视图层 (`src/components/`)

**核心设计：**
- 所有组件都是纯函数组件，使用 React Hooks 管理状态
- 双栏布局：左栏列表 + 右栏详情
- 统一快捷键：`↑↓jk` 移动、`←→hl` 切栏、`Tab` 切换标签页、`q` 退出

**节点视图 (`Proxies.tsx`)**

- 左栏：代理组列表（默认只显示含真实节点的组）
- 右栏：选中组的节点列表，按延迟升序排列
- 节点状态：绿色(< 300ms) / 黄色(300-800ms) / 红色(> 800ms) / 灰色(未测试) / 红色超时
- 快捷键：
  - `Enter` - 选用节点
  - `u` - 解除 url-test 组钉选
  - `t` - 测速（左栏测整组，右栏测单节点）
  - `s` - 切换排序（延迟 / 配置顺序）
  - `v` - 只看可用节点
  - `a` - 显示/隐藏聚合组
  - `m` - 切换模式（规则 → 全局 → 直连）
  - `r` - 刷新

**订阅视图 (`Providers.tsx`)**

- 显示所有 provider：节点数、流量、到期时间、最后更新时间
- 快捷键：
  - `u` - 更新当前 provider
  - `U` - 更新全部 provider
  - `c` - 健康检查
  - `Enter` - 展开节点列表

**日志视图 (`Logs.tsx`)**

- 环形缓冲 1000 行，自动淘汰旧日志
- 支持关键字过滤（实时搜索）
- 快捷键：
  - `l` - 循环切换级别（info / warning / error / debug / silent）
  - `/` - 输入过滤关键字
  - `Space` - 暂停/恢复
  - `c` - 清屏

**连接视图 (`Connections.tsx`)**

- 实时显示所有活跃连接
- 快捷键：
  - `d` - 关闭选中连接
  - `D` - 关闭全部（需按 `y` 确认）
  - `s` - 切换排序（流量 / 时间 / 主机）

**状态栏 (`StatusBar.tsx`)**

底部常驻，显示：
- 内核版本
- 当前模式（规则 / 全局 / 直连）
- 实时速率（↑ 上传 / ↓ 下载）
- 累计流量
- 内存占用
- 控制口连接状态

### 3. Hooks 层 (`src/hooks/`)

**数据获取 Hooks**

```typescript
// 节点数据（轮询）
useProxies(config: Config): {
  groups: GroupItem[]
  testingGroup: string | null
  testNode: (group: string, node: string) => Promise<void>
  testGroup: (group: string) => Promise<void>
  selectNode: (group: string, node: string) => Promise<void>
  unfixGroup: (group: string) => Promise<void>
  refresh: () => Promise<void>
}

// 订阅数据（轮询）
useProviders(config: Config): {
  providers: ProviderItem[]
  update: (name: string) => Promise<void>
  updateAll: () => Promise<void>
  healthCheck: (name: string) => Promise<void>
  refresh: () => Promise<void>
}
```

**流式数据 Hooks**

```typescript
// 状态流（上传/下载速率、内存）
useStatusStream(config: Config): StreamState & TrafficData

// 日志流（环形缓冲）
useLogStream(config: Config, level: LogLevel, visible: boolean): {
  logs: LogEntry[]
  clear: () => void
}

// 连接流
useConnectionsStream(config: Config, visible: boolean): {
  connections: Connection[]
  close: (id: string) => Promise<void>
  closeAll: () => Promise<void>
}
```

**性能优化：`visible` 参数**

日志流和连接流在对应标签页不可见时不会触发组件重渲染，避免高频数据流拖慢整个 App。

### 4. CLI 命令层 (`src/commands/`)

每个子命令都是独立模块，支持 `--json` 输出：

```bash
# 状态概览
proxy_tui status [--json]

# 节点管理
proxy_tui proxy ls [组名] [--json]
proxy_tui proxy use <组> <节点>
proxy_tui proxy unfix <组>
proxy_tui proxy test <组>

# 订阅管理
proxy_tui provider ls [--json]
proxy_tui provider update [名称]
proxy_tui provider check <名称>

# 日志查询
proxy_tui logs -f              # 跟随模式
proxy_tui logs -n 20 -g error  # 抓取 20 条含 error 的日志

# 连接管理
proxy_tui conn ls [-s traffic|time|host] [-n 数量] [--json]
proxy_tui conn close <id|--all>

# 配置重载
proxy_tui reload
```

## 核心功能实现

### 1. 节点延迟测试

**单节点测试：**
```typescript
const delay = await client.testDelay(nodeName, testUrl, timeout)
```

**整组测试：**
```typescript
// 并发测试组内所有节点
await Promise.all(
  nodes.map(node => 
    client.testDelay(node.name, testUrl, timeout)
      .catch(() => -1) // 超时返回 -1
  )
)
```

**延迟分级：**
- 绿色：< 300ms（good）
- 黄色：300-800ms（fair）
- 红色：> 800ms（poor）
- 灰色：未测试（`---`）
- 红色：超时/错误（`超时`）

### 2. 节点过滤与排序

**过滤聚合组：**

聚合组定义：所有成员都是其他组（`type: 'Selector' | 'URLTest' | 'Fallback'`）的组。

```typescript
const isAggregateGroup = (group: Proxy) =>
  group.all?.every(name => {
    const member = proxiesMap[name]
    return member?.type === 'Selector' || 
           member?.type === 'URLTest' || 
           member?.type === 'Fallback'
  })
```

**内置出站过滤：**

过滤掉 `DIRECT`、`REJECT`、`PASS` 等内置策略：

```typescript
const BUILTIN_OUTBOUNDS = ['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE', 'GLOBAL']
```

**延迟排序：**

```typescript
function sortByDelay(a: Proxy, b: Proxy): number {
  const delayA = a.history?.[0]?.delay ?? Infinity
  const delayB = b.history?.[0]?.delay ?? Infinity
  if (delayA === Infinity && delayB === Infinity) return 0
  if (delayA === Infinity) return 1
  if (delayB === Infinity) return -1
  return delayA - delayB
}
```

### 3. 模式切换

mihomo 支持三种模式：

| 模式 | 英文 | 说明 |
|------|------|------|
| 规则 | rule | 根据配置文件规则分流（默认）|
| 全局 | global | 所有流量走代理 |
| 直连 | direct | 所有流量直连，不走代理 |

**API 调用：**

```typescript
// 获取当前模式
const { mode } = await client.configs()

// 切换模式
await client.setMode('global')
```

**TUI 快捷键：**

按 `m` 键循环切换：规则 → 全局 → 直连 → 规则

### 4. 订阅更新

**单个更新：**
```typescript
await client.updateProvider(providerName)
```

**全部更新：**
```typescript
const providers = await client.providers()
await Promise.all(
  Object.keys(providers).map(name => 
    client.updateProvider(name).catch(() => {})
  )
)
```

**健康检查：**
```typescript
await client.healthCheck(providerName)
```

### 5. 日志流处理

**环形缓冲实现：**

```typescript
const MAX_LOGS = 1000

useEffect(() => {
  if (!visible) return // 不可见时不处理
  
  const stream = createStream(config, 'log', {
    onData: (entry: LogEntry) => {
      setLogs(prev => {
        const next = [...prev, entry]
        return next.length > MAX_LOGS 
          ? next.slice(-MAX_LOGS) 
          : next
      })
    }
  })
  
  return () => stream.close()
}, [config, visible])
```

**关键字过滤：**

```typescript
const filtered = logs.filter(log =>
  !keyword || log.payload.toLowerCase().includes(keyword.toLowerCase())
)
```

### 6. 连接管理

**获取连接列表：**
```typescript
const connections = await client.connections()
```

**关闭连接：**
```typescript
// 单个关闭
await client.closeConnection(id)

// 全部关闭
await client.closeAllConnections()
```

**排序：**
- `traffic` - 按流量降序
- `time` - 按连接时间降序
- `host` - 按目标主机字母序

## 性能优化

### 1. 渲染优化

**可见性控制：**

日志流和连接流只在对应标签页可见时渲染：

```typescript
const logs = useLogStream(config, logLevel, tab === 2)
const connections = useConnectionsStream(config, tab === 3)
```

**Spinner 按需启动：**

只在真正有加载任务时才启动心跳：

```typescript
const spinning = 
  Boolean(proxies.testingGroup) || 
  providers.providers.some(p => p.updating)

useEffect(() => {
  if (!spinning) return
  const timer = setInterval(() => setTick(t => t + 1), 120)
  return () => clearInterval(timer)
}, [spinning])
```

### 2. 内存管理

**环形缓冲：**
- 日志流限制 1000 行，自动淘汰旧数据
- 连接流直接替换，无累积

**流清理：**
- 所有 `useEffect` 都返回清理函数
- WebSocket 在组件卸载时关闭
- 定时器在依赖变化时清理

### 3. API 调用优化

**轮询间隔：**
- 节点数据：5 秒
- 订阅数据：10 秒
- 状态流：实时（WebSocket）

**并发控制：**
- 整组测速：`Promise.all` 并发，但单个失败不影响其他
- 订阅更新：顺序执行，避免并发冲突

## 配置迁移

**迁移脚本 (`scripts/migrate-config.mjs`)**

安全三步：
1. 备份原文件到 `.backup/config.{timestamp}.yaml`
2. 写入新配置
3. `mihomo -t` 校验，失败则回滚

**触发方式：**
```bash
node scripts/migrate-config.mjs --apply
```

**关键约定：**
- 运行时代码**绝不**写 `config.yaml`
- 所有操作通过 API 完成（内存中变更）
- 持久化只在显式迁移时发生

## 开发指南

### 本地开发

```bash
# 安装依赖
npm install

# 开发构建（监听模式）
npm run build -- --watch

# 运行 TUI
node dist/cli.js

# 运行 CLI
node dist/cli.js status --json
```

### 添加新功能

**1. 添加 API 方法**

在 `src/api/client.ts` 中添加新方法：

```typescript
async newFeature(): Promise<FeatureResponse> {
  return this.request<FeatureResponse>('/new-endpoint')
}
```

**2. 添加 Hook（可选）**

如果需要在 TUI 中使用，创建对应的 Hook：

```typescript
// src/hooks/useNewFeature.ts
export function useNewFeature(config: Config) {
  const [data, setData] = useState<FeatureData>()
  
  useEffect(() => {
    const client = new MihomoClient(config)
    const fetch = async () => {
      const result = await client.newFeature()
      setData(result)
    }
    fetch()
    const timer = setInterval(fetch, 5000)
    return () => clearInterval(timer)
  }, [config])
  
  return data
}
```

**3. 添加 TUI 视图（可选）**

在 `src/components/` 中创建新组件：

```typescript
// src/components/NewFeature.tsx
export function NewFeature({ config }: { config: Config }) {
  const data = useNewFeature(config)
  
  return (
    <Box flexDirection="column">
      {/* 组件内容 */}
    </Box>
  )
}
```

**4. 添加 CLI 命令（可选）**

在 `src/commands/` 中创建新命令：

```typescript
// src/commands/newfeature.ts
export async function newFeatureCommand(config: Config, opts: Options) {
  const client = new MihomoClient(config)
  const result = await client.newFeature()
  
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    // 格式化输出
  }
}
```

在 `src/cli.tsx` 中注册命令：

```typescript
program
  .command('newfeature')
  .description('New feature description')
  .option('--json', 'JSON output')
  .action(async (opts) => {
    await newFeatureCommand(config, opts)
  })
```

### 测试

**自动化测试脚本：**

```python
# /tmp/test_feature.py
import subprocess
import requests

API = "http://127.0.0.1:19090"

def test_feature():
    resp = requests.get(f"{API}/new-endpoint")
    assert resp.status_code == 200
    print("✓ Feature test passed")

if __name__ == "__main__":
    test_feature()
```

### 调试

**查看 API 响应：**

```bash
curl http://127.0.0.1:19090/proxies | jq
```

**查看 WebSocket 流：**

```bash
websocat ws://127.0.0.1:19090/traffic
websocat ws://127.0.0.1:19090/logs?level=info
websocat ws://127.0.0.1:19090/connections
```

**查看 TUI 渲染：**

添加调试日志：

```typescript
console.error('DEBUG:', data) // stderr 不会污染 TUI
```

## 常见问题

### Q: TUI 无法启动

**A:** 检查 API 端口是否可达：

```bash
curl http://127.0.0.1:19090/version
```

如果失败，检查 mihomo 是否运行：

```bash
ps aux | grep mihomo
```

### Q: 节点测速全部超时

**A:** 检查测速 URL 是否可达：

```bash
curl -I https://www.gstatic.com/generate_204
```

### Q: 日志流占用内存过高

**A:** 检查是否触发了环形缓冲上限，默认 1000 行。如果日志频率过高，考虑：
- 降低日志级别（`warning` 或 `error`）
- 减少 `MAX_LOGS` 常量

### Q: 订阅更新失败

**A:** 常见原因：
- 订阅 URL 过期（提供商变更域名）
- 代理节点被目标服务器 403
- 网络不稳定

查看完整错误：进入 **[2] 订阅** 标签页，按 `u` 更新，错误会显示在红框中。

### Q: 配置变更丢失

**A:** 记住核心原则：**运行时代码绝不写 `config.yaml`**。

所有 TUI/CLI 操作都是内存中变更，重启 mihomo 后丢失。

如需持久化：
1. 编辑 `~/.config/mihomo/config.yaml`
2. 运行 `proxy_tui reload` 热重载

## 贡献指南

### 代码风格

- 使用 2 空格缩进
- 优先使用函数式组件和 Hooks
- 类型优先：所有公开接口必须有类型定义
- 注释优先：复杂逻辑必须有注释说明

### Commit 规范

```
feat: 添加新功能
fix: 修复 Bug
docs: 文档变更
refactor: 重构代码
perf: 性能优化
test: 测试相关
chore: 构建/工具链变更
```

### Pull Request

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feat/new-feature`
3. 提交变更：`git commit -m "feat: 添加新功能"`
4. 推送分支：`git push origin feat/new-feature`
5. 创建 Pull Request

## 版本历史

### v0.1.0 (当前)

**核心功能：**
- ✓ TUI 四标签页（节点 / 订阅 / 日志 / 连接）
- ✓ CLI 子命令（status / proxy / provider / logs / conn / reload）
- ✓ 节点延迟测试（单节点 / 整组）
- ✓ 订阅更新与健康检查
- ✓ 实时日志流（环形缓冲 1000 行）
- ✓ 连接管理（查看 / 关闭）
- ✓ 模式切换（规则 / 全局 / 直连）
- ✓ 配置热重载

**性能优化：**
- ✓ 可见性控制（日志流 / 连接流按需渲染）
- ✓ Spinner 按需启动（避免无意义重渲染）
- ✓ 环形缓冲（日志流内存安全）
- ✓ WebSocket 连接复用

**安全机制：**
- ✓ 运行时代码绝不写 `config.yaml`
- ✓ 配置迁移强制备份 + 校验
- ✓ API 调用错误处理

## 许可证

MIT

## 联系方式

项目地址：<https://github.com/MrChen-hero/mihomo-tui>

---

**更新时间：** 2026-08-17
