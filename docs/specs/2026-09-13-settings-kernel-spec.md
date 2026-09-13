# 设置页（第 5 标签）+ mihomo 内核版本切换/镜像下载 spec

日期：2026-09-13 · 级别：Level 2 · 前置：对话框打磨 spec（b7a6b35）已交付

## 1. 目标与范围

顶栏新增第 5 个标签「设置」，两块内容（功能参照 Windows GUI 截图，样式按本项目既有 TUI 语言自行设计）：

1. **基础设置**：混合端口、允许局域网、IPv6、统一延迟、TCP 并发、日志级别、DNS 接管——全部是 mihomo 内核真实存在的配置字段，且全部在 `src/config/skeleton.ts` 的管辖范围内；外部控制地址只读展示（改它会断掉 TUI 自己的连接，不做）
2. **mihomo 内核管理**：当前版本展示、可用更新检查、版本列表选择下载（稳定版列表 + Alpha 最新）、镜像源自动回退/手动锁定/自定义前缀

生效方式统一为：**写 config.yaml（ConfigManager 事务）→ 重启 mihomo 服务**。不走 PATCH /configs 热更——热更不持久（下次订阅应用即丢）、且端口/IPv6 等字段覆盖不全；与订阅事务同款语义，持久且可回滚。

不做（YAGNI）：外部控制/secret 编辑、bind-address、TUN、外部 UI、GeoData 更新、流量滤道、Windows/zip 资产（本项目 Linux + systemd only，见 `src/config/service.ts` 头注释）。

## 2. 事实基础（调研与实测，2026-09-13）

- **内核服务**：`systemctl --user cat mihomo` → `ExecStart=%h/bin/mihomo -d %h/.config/mihomo`。替换 `~/bin/mihomo` + `systemctl --user restart mihomo` 即完成版本切换；`ServiceManager.restart()` 已存在且可注入 stub
- **当前内核**：v1.19.24 linux amd64（`~/bin/mihomo`，36.7MB）；最新稳定版 v1.19.30——真机存在可用更新，天然是验收素材
- **config.yaml 生成语义**：`buildSkeleton` 对 mixed-port/allow-lan/ipv6/unified-delay/tcp-concurrent/log-level 等字段一律「沿用旧值」（pick* from oldConfig）——把修改后的值写回 oldConfig 再走 `ConfigManager.applyConfig` 即天然持久化；**例外是 dns.enable**：现签名 `enableDns ?? true` 无条件翻回 true，需改为从 oldConfig.dns.enable 派生（§3.2）
- **GitHub 连通性实测**（本机）：api.github.com 直连 200（1.7s）；gh-proxy.com 可代理 API（200）；ghfast.top 不代理 API（403）但代理 release 资产下载（206）；release 资产直连下载 206
- **release 资产**：命名 `mihomo-linux-amd64-<tag>.gz`（另有 `-compatible`/`-v1-go120` 等变体）；API assets 带 `digest: "sha256:<hex>"` 与 `size`；Alpha 走 tag `Prerelease-Alpha`，资产名含 `alpha-<hexsha>`
- **releases 列表响应很大**：3 个 release ≈ 470KB（changelog 巨大）——per_page 限制 + 2MB 响应上限 + 15s 超时
- **mihari 借鉴**（references/mihari，只读参考）：安装四段式 staging → 验证（`-v`）→ 原子 rename → 重启；同版本短路；失败时旧二进制保留。mihari 无镜像源，镜像设计为本项目自研

## 3. 设计

### 3.1 设置页 UI（`src/views/Settings.tsx`）

居中卡片（沿用对话框卡片语言：Panel 内嵌标题 + 双轴居中），光标只在可操作行间移动，只读行 dim 且光标跳过：

```
                        ╭─ ◆ 设置 ─────────────────────────────────╮
                        │                                          │
                        │  基础设置（写入 config.yaml 并重启生效）    │
                        │  ❯ 混合端口              17890            │
                        │    允许局域网            关               │
                        │    IPv6                 开               │
                        │    统一延迟              开               │
                        │    TCP 并发              开               │
                        │    日志级别              info             │
                        │    DNS 接管              开               │
                        │    外部控制              127.0.0.1:19090  │ ← 只读
                        │                                          │
                        │  mihomo 内核                              │
                        │    当前版本              v1.19.24         │
                        │    可用更新              v1.19.30         │ ← 检查中…/已是最新/检查失败
                        │  ❯ 切换版本 / 更新                        │
                        │    下载源                自动             │
                        │                                          │
                        │  ↑↓ 选择  Enter 修改                      │
                        ╰──────────────────────────────────────────╯
```

- **数据源**：显示值一律读 config.yaml（`ConfigManager.loadConfig()`，「下次重启将生效的值」语义），不读 GET /configs 运行时值——离线可用、与写入目标一致；当前内核版本复用 App 传入的 `version`（GET /version 启动值）
- **交互流**（每次修改独立应用，语义可预期）：
  - 混合端口：`InputDialog`（单字段，1024–65535 数字校验）→ `ConfirmDialog`（`17890 → 8080` + 影响行「将写入配置并重启服务，活动连接会瞬断数秒」）→ 事务
  - 开关类（允许局域网/IPv6/统一延迟/TCP 并发/DNS 接管）：`ConfirmDialog`（`开 → 关` + 同上影响行）→ 事务
  - 日志级别：`ListDialog`（debug/info/warning/error/silent）→ `ConfirmDialog` → 事务
  - 切换版本：进入即触发一次性更新检查（自动源回退，8s 超时；结果缓存不随 tab 切换重查）→ `ListDialog`（稳定版最近 10 个 + 「Alpha 最新」+ 本机已下载版本（hint 标记「已下载」，可离线切换））→ `ConfirmDialog`（目标版本、体积 ~19MB、影响行 + 「失败自动回滚旧内核」）→ 下载安装事务；选中「当前」标记的版本时同版本短路，提示「已是该版本」不重复下载
  - 可用更新行可操作：Enter 强制重查（自动检查失败后的重试入口）
  - 下载源：`ListDialog`（自动（推荐）/直连 GitHub/gh-proxy.com/ghfast.top/自定义前缀…）→ 立即写 TUI 自身 config.json（与内核无关，无需重启）→ toast
- **颜色/宽度纪律**：全部引 `src/ui/theme.ts`；文本宽度全部 `displayWidth` 系函数

### 3.2 设置事务（`src/config/settingsService.ts` + skeleton 一处语义修正）

`applySettings(config, changes, overrides?)`，完全复刻 `SubscriptionService` 的事务骨架（steps + onProgress + 注入 + 回滚表）：

- 步骤：`读取 → 生成 → 备份 → 写入校验 → 重启 → 确认`（复用 `ProgressDialog`，新增可选 `detail?: string` 行）
- 实现：`loadSubscriptions` 取订阅清单 → `ConfigManager.loadConfig()` 得 oldConfig → 按 changes 变异字段（mixed-port/allow-lan/ipv6/unified-delay/tcp-concurrent/log-level/dns.enable）→ `manager.applyConfig(subs, { oldConfig: 变异后 })`（备份/`mihomo -t` 校验/原子写/写后复验全部现成）→ `service.restart()` → 宽限等待后 `isActive()` 确认
- **回滚**：config.yaml 从备份回滚 + 再次重启；回滚失败把两个错误一起上抛，绝不静默（同订阅事务 6.1 表）
- **skeleton 修正**：`buildSkeleton` 的 `enableDns` 缺省语义从 `?? true` 改为「从 oldConfig.dns.enable 派生（dns 缺失或非记录时 true）」——DNS 接管开关由此跨订阅应用持久；显式传参的行为不变，现有调用方零改动

### 3.3 下载源与镜像回退（`src/kernel/sources.ts`）

```ts
interface DownloadSource { id: string; label: string; apiPrefix: string; dlPrefix: string }
// 前缀 '' = 直连；apiPrefix/dlPrefix 分离（实测 ghfast.top 不代理 API）
SOURCES = [
  { id: 'direct',       label: '直连 GitHub',  apiPrefix: '',                      dlPrefix: '' },
  { id: 'gh-proxy.com', label: 'gh-proxy.com', apiPrefix: 'https://gh-proxy.com/', dlPrefix: 'https://gh-proxy.com/' },
  { id: 'ghfast.top',   label: 'ghfast.top',   apiPrefix: '',                      dlPrefix: 'https://ghfast.top/' },
]
```

- **自动模式**（默认）：按 直连 → gh-proxy.com → ghfast.top 顺序回退，且按请求角色（API/下载）跳过无该能力的源；API 请求单源 8s 超时，下载整体 15 分钟超时
- **手动锁定**：强制单一源，失败直接报错不回退（用户意图优先）；**自定义前缀**：用户输入的前缀同时用于 API 与下载（说明文案注明），存 config.json
- `fetchJsonThrough(path)` 返回 `{ data, sourceId }`（来源展示用）；`2MB` 响应上限

### 3.4 内核版本获取与下载安装（`src/kernel/releases.ts` + `src/kernel/installer.ts`）

- **版本列表**：`GET /repos/MetaCubeX/mihomo/releases?per_page=12`（过滤 prerelease/draft，取前 10）+ `GET .../releases/tags/Prerelease-Alpha`（资产名解析 `alpha-<sha>`）；全部经 `fetchJsonThrough`
- **资产选择**：`mihomo-${goos}-${goarch}-${tag}.gz`（`process.platform`/`process.arch`，`x64→amd64`）；amd64 命中 404 时回退 `-compatible` 变体
- **下载安装四段式**（mihari 范式）：
  1. **staging**：mkdtemp 临时目录，流式下载 .gz → gunzip（`node:zlib`），字节进度回调（content-length 缺失时显示「已下载 X MB」）；上限 128MB；API digest 可得时做 sha256 校验
  2. **验证**：`chmod 0700` → `<candidate> -v`，输出必须含目标 tag（alpha 含 `alpha-<sha>`）
  3. **替换**：旧二进制备份为 `~/bin/mihomo.bak.<时间戳>`（保留最近 2 份，其余清理）→ 原子 rename；目标版本已在本机归档（`~/.local/share/mihomo-tui/kernels/<tag>/mihomo`）则跳过下载直接走 2–4（离线切换）
  4. **重启+确认**：`ServiceManager.restart()` → 轮询 GET /version（500ms × 20 次）确认版本到位
- **失败回滚**：替换后任何一步失败 → 从备份恢复二进制 + 再次重启 + 抛出带阶段信息的错误；staging 残留目录清理
- **同版本短路**：目标 tag 与当前一致且非 Alpha 时提示「已是该版本」不重复下载
- 归档目录只增不删（每份 ~20MB，用户手动清理），spec 记录即可

### 3.5 新组件与接线

- **`src/components/ListDialog.tsx`**（新）：居中列表选择对话框——`borderTitle` 内嵌标题 + items（`{ label, hint?, section?, mark? }`，section 行为不可选的 dim 分组头）+ `❯` 光标 + ↑↓/Enter/ESC；条目少不滚动（≤15），沿用 `useKeyCapture` 分层纪律
- **App 接线**：`TABS` 增「设置」（index 4）；数字键 `1`–`5`；Tab/[/] 循环自然生效；`bodyHeight` 内渲染 `SettingsView`（props：config/version/onMessage/width/height/active）；80 列顶栏 5 格自动收窄（`tabCells` 既有降级语义覆盖）
- **AppConfig（config.json）新增**：`mihomoBin?: string`（默认 `~/bin/mihomo`，测试注入用）、`downloadSource: { mode: 'auto'|'direct'|'gh-proxy.com'|'ghfast.top'|'custom', customPrefix?: string }`；`merge()` 逐字段校验非法回退默认，既有用户配置文件缺字段自动补默认值

## 4. 错误处理与回滚（汇总）

| 失败点 | 处置 |
|---|---|
| 配置事务任一步失败 | ConfigManager 阶段化回滚（备份还原）+ 重启恢复现场，错误带 phase |
| 版本列表/更新检查失败 | 显示「检查失败」（danger），可重试；不阻塞其他设置项 |
| 下载中断/超时/超限 | staging 清理，目标二进制未动，报错 |
| sha256/`-v` 验证失败 | staging 清理，报错，目标二进制未动 |
| 替换后重启失败 | 自动还原备份二进制 + 再次重启 + 上抛（两段错误都保留） |
| 手动锁定源不可达 | 直接报错（不静默回退），提示可切回自动 |

## 5. 验证与安全边界

- 单测：settingsService 事务/回滚（stub ConfigManager+ServiceManager，注入临时目录）；installer 四段式（stub 二进制脚本 + stub systemctl + mock fetch——digest 校验、404 回退 compatible、失败回滚、离线切换、同版本短路）；sources 回退顺序与角色跳过；Settings 视图光标/只读跳过/对话框流；ListDialog 键位；buildSkeleton dns 派生
- pty 验收（110×34 与 80×24）：**只走视觉与按键流**——切到设置页、移动光标、打开/关闭各对话框（端口输入 ESC 取消、版本列表、下载源列表）、ESC 分级退出不受影响；**不真实应用设置、不真实下载/重启**（涉及真实 config.yaml 与 systemd 服务）；版本列表的只读 GET 请求允许真实发生
- 纪律：每 Checkpoint 一个只读子代理审查；色值引 theme.ts；文本宽度 displayWidth 系

## 6. 备忘（CP3 审查记录的实现取舍）

- alpha 滚动 tag 的归档按 sha 键控（`kernels/Prerelease-Alpha-<sha>/`）；这类历史 alpha 不进「本机已下载」列表（离线切回需 sha 级验证信息），仅作磁盘存档
- 下载进度不可取消（ProgressDialog 全按键捕获，非 cancelable）；下载整体 15 分钟超时是上限，正常下载约 20MB 数秒到数十秒
- JSON 响应上限 4MB、资产上限 128MB 为防滥用软上限；自定义前缀指向任意服务器时由 sha256/digest 与 `-v` 标记校验兜底
- 探针保守回滚：重启后 10s 内 /version 未就绪会回滚新内核（内核启动极慢的环境可能误判）
- alpha 资产无 compatible 回退变体（官方 alpha 资产命名未提供）
- settingsService 事务的 config.yaml.bak.* 由订阅事务的 7 天清理策略兜底，本事务不主动清理
- 应用设置步骤「生成新配置」会按当前订阅清单整体重建 config.yaml（与订阅事务同语义），手工加入的非骨架字段由骨架 pick* 逻辑保留

## 7. Execution Checkpoints

- [x] CP1：设置页骨架——第 5 标签接线、Settings 视图（行渲染/光标/只读跳过）、settingsService 事务 + skeleton dns 派生修正、ListDialog + ProgressDialog detail 扩展；单测绿
- [x] CP2：内核子系统——sources/releases/installer + 版本列表与下载源对话框接线 + config.json 新字段；单测绿（mock 网络 + stub 二进制/服务）
- [x] CP3：只读子代理审查通过（禁改文件；审查代码与测试，不触碰真实服务/配置）
- [x] CP4：全量 npm test + npm run build + pty 验收（110×34 / 80×24）+ 提交（docs: spec 一笔，feat: 实现一笔）
