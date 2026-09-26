# mihomo-tui

[![Version](https://img.shields.io/badge/version-0.4.0-blue)](CHANGELOG.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/MrChen-hero/mihomo-tui/actions/workflows/ci.yml/badge.svg)](https://github.com/MrChen-hero/mihomo-tui/actions/workflows/ci.yml)

[mihomo](https://wiki.metacubex.one/)（Clash.Meta）内核的 **CLI + TUI** 管理工具。
切节点、更新订阅、看实时日志、管连接，全部通过本机 External Controller 的
REST API 完成 —— **运行时代码绝不写 `config.yaml`**。

```txt
┌─ mihomo-tui ────────────────────────────────────┐
│ [1]节点 [2]订阅 [3]规则 [4]日志 [5]连接 [6]设置    │
├─────────────────────────────────────────────────┤
│ PROXY       → AUTO                              │
│ AUTO        → [A]日本1          166ms           │
│ 日本        → [B]高速02          213ms           │
│ 机场-alpha  → 新加坡2         ---（未测试）     │
└─────────────────────────────────────────────────┘
```

## 目录

- [特性](#特性)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [TUI 使用](#tui-使用)
- [CLI 使用](#cli-使用)
- [配置](#配置)
- [配置架构：骨架 + Provider](#配置架构骨架--provider)
- [迁移脚本](#迁移脚本)
- [常见问题与已知限制](#常见问题与已知限制)
- [开发](#开发)
- [路线图](#路线图)
- [贡献](#贡献)
- [许可证](#许可证)

## 特性

- **双入口**：TUI 适合日常操作，CLI 适合脚本化与管道场景（全命令支持 `--json`）
- **节点管理**：双栏选择代理组与节点，延迟五状态显示（正常 / 一般 / 缓慢 / 未测试 / 超时），
  严格区分「未测试」与「不可用」；单节点与整组并发测速；url-test 组钉选与解除
- **订阅管理**：在 TUI 内直接增删改订阅（自动备份、校验、原子写入、失败回滚、
  自动重启内核），查看节点数 / 流量 / 到期时间，一键更新单个或全部订阅，
  健康检查，更新失败完整展示错误（订阅域名失效、被 403 都是常态）
- **规则管理**：查看生效规则与 rule-providers，按类型/关键字筛选，保守测试域名/IP，支持运行时禁用；不支持禁用的内核降级为本地标记。
- **实时监控**：WebSocket 日志流（级别切换、关键字过滤、环形缓冲 1000 行）、
  连接流（排序、关闭）、底部状态栏常驻显示内核版本 / 模式 / 速率 / 流量 / 内存
- **模式切换**：规则 / 全局 / 直连循环切换，热重载配置无需重启内核
- **安全边界**：写 `config.yaml` 的代码路径只有一条，且被封装在
  `ConfigManager` 里强制走「备份 → `mihomo -t` 校验 → 原子写 → 写后复验 →
  失败自动回滚」流程；配置备份保留 7 天；订阅 URL 的 token 在所有展示与
  日志中一律脱敏

### 它解决什么问题

传统「整份订阅覆盖 config.yaml」的用法有几个痛点，本项目通过
「骨架 + proxy-providers 配置架构 + API 操作层」一并解决：

| 痛点 | 解决方式 |
|---|---|
| 订阅一更新，手工修改的端口 / DNS / 规则全部丢失 | 订阅只作为 provider 数据源，骨架配置永不触碰 |
| 多份订阅互斥，无法混用不同机场的节点 | 多 provider 同时挂载，节点可混在同一个组里 |
| 切换订阅要重启内核，掐断所有连接 | 更新订阅走 API（`PUT /providers/proxies/{name}`），内核不重启 |
| 看不到节点存活与延迟 | 健康检查数据直接展示，支持手动测速 |
| 看不到订阅流量与到期时间 | 自动解析 `Subscription-Userinfo` 响应头 |

## 环境要求

- **Node.js ≥ 22**（依赖内置的 `fetch` 与全局 `WebSocket`，不依赖 ws / undici / axios）
- 一个正在运行的 mihomo 内核，且配置了 `external-controller`（本工具默认连接
  `http://127.0.0.1:19090`，可在配置文件中修改）
- 可选：Linux + systemd（`--user` 服务），仅影响迁移脚本的部分检查项

## 安装

从源码安装：

```bash
git clone https://github.com/MrChen-hero/mihomo-tui.git
cd mihomo-tui
npm install
npm run build
```

建议在 `~/.bashrc` 中加一个入口函数（路径按实际克隆位置调整）：

```bash
proxy_tui() {
    local bin="$HOME/mihomo-tui/bin/mihomo-tui"
    if [ ! -x "$bin" ]; then
        echo "mihomo-tui not found or not executable: $bin" >&2
        return 1
    fi
    "$bin" "$@"
}
```

新开终端（或 `source ~/.bashrc`）后即可使用 `proxy_tui` 命令。

## 快速开始

```bash
proxy_tui status    # 先确认能连上内核：打印版本、模式、端口、provider 概览
proxy_tui           # 无参数进入 TUI
```

## TUI 使用

六个标签页，数字键 `1`–`6` 直接切换，`Tab` 循环。`ESC` 逐层返回，在主界面弹退出确认；`Ctrl+C` 直接退出。

### [1] 节点

左栏代理组，右栏该组节点。默认只列**含真实节点的组**，按延迟升序排列，
可用节点浮在顶部。

| 键 | 作用 |
|---|---|
| `↑↓` / `jk` | 移动光标 |
| `←→` / `hl` | 左右切栏 |
| `Enter` | 选用节点（自动组会联动切换 PROXY 到对应区域组） |
| `u` | 恢复自动选路（PROXY → AUTO） |
| `t` | 测速：焦点在左栏测整组，在右栏测单个节点 |
| `T` | 整组测速 |
| `s` | 切换排序（延迟升序 / 配置顺序） |
| `v` | 只看可用（滤掉超时与未测试） |
| `m` | 切换模式（规则 → 全局 → 直连 → 规则） |
| `r` | 刷新 |

解除 url-test / fallback 组的钉选请使用 CLI：`proxy_tui proxy unfix <组名>`。

节点状态五分显示——`lazy: true` 的组在被使用前所有节点的 `history` 都是空的，
所以「未测试」与「不可用」严格区分：

| 状态 | 显示 |
|---|---|
| 正常（< 300ms） | 绿色延迟值 |
| 一般（300–800ms） | 黄色延迟值 |
| 缓慢（> 800ms） | 红色延迟值 |
| 未测试 | 灰色 `---` |
| 超时/错误 | 红色 `超时` |

### [2] 订阅

| 键 | 作用 |
|---|---|
| `a` | 新增订阅（名称 / URL / 节点名前缀，逐字段实时校验） |
| `d` | 删除当前订阅（红色确认框，列出将发生的全部变更） |
| `e` | 编辑当前订阅的节点名前缀（名称与 URL 不可改） |
| `u` | 更新当前订阅 |
| `U` | 更新全部订阅 |
| `c` | 健康检查 |
| `Enter` | 展开该订阅的节点列表 |
| `r` | 刷新 |

增删改是完整的事务流程：自动备份 `config.yaml` → 临时目录 `mihomo -t` 校验 →
原子写入 → 自动重启 `mihomo` 服务并确认状态；任何一步失败都会自动回滚
配置与订阅清单，并把 `systemctl status` 完整输出展示在错误框里。
配置备份保留 7 天（`config.yaml.bak.<时间戳>`）。

更新订阅失败会把完整错误显示在红框里（订阅域名失效、经代理被 403 都是常态）。

### [3] 规则

规则页支持 `l` 切换类型、`/` 关键字过滤、`Enter` 查看详情、`t` 测试域名/IP、`u` 更新规则集、`d` 临时禁用/启用、`r` 刷新。规则测试无法确定时会提示需内核判定。

禁用仅修改内核运行时状态，配置重载或内核重启后可能恢复。旧内核或缺少禁用字段时，使用 `m` 作会话内本地标记，**不影响实际分流和规则测试**；规则页的 `m` 不切换全局模式。

本地测试支持域名和 IP 网段。遇到 `GEOIP`、`RULE-SET`、进程规则或需要 DNS 查询的规则即停止并提示“需内核判定”；命中结果只表示规则目标，不代表最终节点或真实流量路径。禁用操作与外部配置重载可能竞争，显示“结果未确认”时请刷新检查，不会自动重试。

按 **`e` 打开配置规则编辑器**，编辑本机 `mihomoDir/config.yaml` 中的规则。配置草稿独立于当前生效规则，允许连续操作后统一保存；原规则页的 `d` 仍表示临时禁用。

| 编辑器按键 | 操作 |
|---|---|
| `↑↓` / `j/k` | 选择规则 |
| `a` / `e` / `d` | 新增 / 编辑 / 确认删除草稿规则 |
| `J/K` | 向后 / 向前移动一条，保持选中规则身份 |
| `/` | 按原文过滤；提交空字符串清除；过滤期间禁止新增和调序 |
| `Enter` | 查看完整原文、路径与保护原因；`↑↓` 滚动 |
| `Ctrl+S` | 确认后统一校验、保存并重载完整配置 |
| `ESC` | 取消当前弹窗；有草稿时确认放弃 |

常用表单覆盖域名、网段、端口、进程、`RULE-SET` 和 `MATCH`；候选字段按 `e` 选择。复杂表达式和额外参数使用单条原文，保留内部内容。`MATCH` 最多一条且须位于末尾，也允许删除它并明确提示“无显式 MATCH”。订阅直连规则按内容识别并保护；订阅清单缺失、为空、损坏或保护前缀不一致时禁止写入。

保存先在独立目录校验，创建唯一的 `config.yaml.bak.*` 备份，再原子替换、写后复验、按绝对路径重载和回读确认。保留原 YAML 节点及注释，但成功序列化可能调整排版。失败恢复使用保存前的原始字节和文件权限。**重载会重新建立规则状态，临时禁用、本地标记和旧测试结果会清除。** 校验期间可以取消；正式写入至重载/恢复结束期间，`ESC`、`Ctrl+C` 和切页不会终止事务。

重载已接受但回读失败时显示“已保存 · 待确认”，按 `r` 仅重新读取，不重复重载，也不允许叠加保存。恢复未完成时分别显示磁盘和内核状态及备份路径，保留草稿；处理状态后需重新打开编辑器。检测到其他程序修改配置或订阅清单时停止覆盖和自动恢复。

**支持边界：** 仅支持普通本地配置文件和回环控制器，保存确认要求该控制器确实读取显示的本机路径；SSH 隧道、容器路径映射不在支持范围。校验复制数据目录内相对路径的 provider 缓存及标准 geodata（地域数据库）；缺少依赖、绝对/逃逸路径、外部 UI、证书/私钥文件等未支持资源会阻止保存。`rules` 的锚点、别名、自定义标签和顶层合并来源不支持写入。复杂规则的附加参数由内核校验，回读不承诺逐项验证，也不保证远程规则集已下载或实际流量一定命中。避免其他程序同时编辑同一文件；进程强杀、断电及多进程严格事务不在保证范围。后续订阅/代理组配置流程仍可能调整规则引用。规则集本身仍只查看与更新，没有新增 CLI 写命令。

### [4] 日志

| 键 | 作用 |
|---|---|
| `l` | 循环切换级别（silent / error / warning / info / debug） |
| `/` | 输入关键字过滤 |
| `Space` | 暂停 / 恢复滚动 |
| `c` | 清屏 |

环形缓冲上限 1000 行，长时运行内存稳定。

### [5] 连接

| 键 | 作用 |
|---|---|
| `d` | 关闭选中连接 |
| `D` | 关闭全部（需按 `y` 二次确认） |
| `s` | 切换排序（流量 / 时间 / 主机） |

### [6] 设置

查看和编辑内核常用设置、下载源偏好与内核版本。

### 底部状态栏

所有标签页常驻，显示：内核版本、当前模式、实时速率、累计流量、内存、
控制口连接状态。内核连不上时转红显示断开状态。

## CLI 使用

每条命令输出一行或一张表，均支持 `--json` 供 `jq` 消费。

```bash
proxy_tui status                        # 内核版本、模式、端口、provider 概览
proxy_tui proxy ls                      # 列出所有代理组及当前选中
proxy_tui proxy ls 香港                  # 列出该组节点、延迟、状态
proxy_tui proxy use <组> <节点>          # 切换节点（url-test 组会钉选并提示）
proxy_tui proxy unfix <组>              # 解除 url-test/fallback 组的钉选
proxy_tui proxy test 香港 -u <url> -t 5000   # 整组延迟测试，可自定义测速地址与超时
proxy_tui provider ls                   # 订阅列表（节点数/流量/到期/更新时间）
proxy_tui provider update [名称]        # 更新订阅，省略名称则全部
proxy_tui provider check <名称>         # 触发健康检查
proxy_tui rules ls --type DOMAIN-SUFFIX --json  # 规则类型同时接受 DomainSuffix
proxy_tui rules test example.com --json        # hit / miss / unsupported
proxy_tui rule-provider ls --json              # 规则集列表
proxy_tui rule-provider update <名称> --json    # 更新规则集
proxy_tui logs -f                       # 实时日志跟随，Ctrl+C 退出
proxy_tui logs -n 20 -g 'error'         # 抓 20 条含 error 的日志后退出
proxy_tui conn ls -s traffic -n 50      # 连接列表，按流量排序
proxy_tui conn close <id|--all>         # 关闭连接（id 支持 8 位前缀）
proxy_tui reload                        # 热重载配置（内核不重启）
```

组名含中文与 emoji 时正常传入即可，程序全程 `encodeURIComponent`：

```bash
proxy_tui proxy ls '🇭🇰 香港聚合'
```

**退出码约定**：`0` 成功，`1` 通用错误，`2` 参数错误，`3` 内核不可达。

## 配置

程序自身配置位于 `~/.config/mihomo-tui/config.json`，首次运行自动生成：

```json
{
  "api": "http://127.0.0.1:19090",
  "secret": "",
  "mihomoDir": "~/.config/mihomo",
  "testUrl": "https://www.gstatic.com/generate_204",
  "testTimeout": 5000,
  "delayThresholds": { "good": 300, "fair": 800 }
}
```

| 字段 | 说明 |
|---|---|
| `api` | mihomo External Controller 地址 |
| `secret` | 控制口密钥，与 `external-controller` 的 `secret` 一致 |
| `testUrl` | 延迟测试地址（默认 `gstatic.com`，实测比 `cp.cloudflare.com` 兼容性好） |
| `testTimeout` | 单节点测速超时（毫秒） |
| `delayThresholds` | 好 / 一般 / 缓慢三档延迟阈值 |

命令行可用 `--api <url>` 与 `--secret <token>` 临时覆盖。

## 配置架构：骨架 + Provider

推荐的 mihomo 配置为「骨架 + provider」两层结构，订阅更新不再覆盖任何自定义配置：

```txt
config.yaml（骨架，只维护一次）
├── 通用设置 / sniffer / dns / rules / rule-providers
├── proxy-providers:          ← 订阅作为节点来源
│   ├── alpha → ./providers/alpha.yaml
│   ├── beta  → ./providers/beta.yaml
└── proxy-groups:
    ├── PROXY / AUTO / FALLBACK
    ├── 区域组：香港 台湾 日本 韩国 新加坡 美国 …
    ├── 机场组：机场-alpha / 机场-beta
    └── 用途组：AI Google YouTube Telegram 流媒体 …
```

> **关键约束**：provider 的 `path` **必须是相对路径** —— mihomo 对此有路径安全
> 校验，配置文件之外的绝对路径会被拒绝启动。

## 迁移脚本

`scripts/migrate-config.mjs` 负责把现有整份订阅配置一次性改造为上述架构。
它是一次性迁移入口；日常订阅与设置变更通过内置配置事务完成。迁移脚本的安全机制如下：

```bash
node scripts/migrate-config.mjs --dry-run --diff   # 预览骨架与差异，不落盘
node scripts/migrate-config.mjs --apply            # 备份 + 校验 + 写入
node scripts/migrate-config.mjs --apply --no-dns   # 写入但不改 dns 段
```

- 订阅链接放在 `~/.config/mihomo-tui/subscriptions.json`（权限 600，含 token）：

```json
{
  "subscriptions": [
    { "name": "alpha", "prefix": "[A] ", "url": "https://example.com/sub?token=..." }
  ]
}
```

- `name` 只能用字母数字与 `-_`（要作文件名）；`prefix` 会通过
  `additional-prefix` 注入到节点名前，用于标记来源。
- 安全保证：`--dry-run` 也会跑 `mihomo -t` 校验；`--apply` 先备份再写，
  写入后再校验一次，失败自动从备份回滚；重复运行结果一致（幂等）。
- 脚本会自动处理若干实测踩到的坑：DNS 上游可达性、`respect-rules` 与
  `proxy-server-nameserver` 的成对约束、订阅域名 DIRECT 规则防拉取死锁、
  过滤机场下发的「剩余流量 / 套餐到期」等伪装节点。

## 常见问题与已知限制

**Q：延迟测试全部超时？**
先确认测速地址本身可达：`curl -I https://www.gstatic.com/generate_204`。
部分内网环境对特定测速域名不通，可在 `config.json` 中更换 `testUrl`。

**Q：TUI 显示「内核不可达」？**
确认 mihomo 正在运行且 `external-controller` 地址正确：

```bash
curl http://127.0.0.1:19090/version
systemctl --user status mihomo   # 按你的实际部署方式
```

**Q：AI 服务商（Claude / ChatGPT）不可用？**
多数机场出口 IP 被 AI 服务商封锁（403 或地区不可用页），这是节点 IP 问题，
改配置无法解决，需要带 AI 解锁的节点。

**Q：为什么日志命令有时不会立即退出？**
mihomo 内核不回应 WebSocket close 帧，客户端关闭握手永不完成，因此所有用到
流的命令都显式退出；非 `--follow` 的 `logs` 有 `--idle` 空闲超时（默认 5 秒）兜底。

**Q：TUI 里的修改重启内核后会丢吗？**
会。运行时操作（切节点、切模式）都是内存中变更。需要持久化的变更请编辑
`config.yaml` 后执行 `proxy_tui reload`；订阅的增删改则直接持久化
（通过内置的备份 → 校验 → 原子写 → 回滚事务）。

**Q：添加订阅时提示「订阅名称已存在」？**
订阅名称会用作 provider 名与缓存文件名，全局唯一且只允许字母数字与 `-_`
（1–32 位）。换一个名字，或先删除旧订阅。

**Q：新增 / 删除订阅会导致代理断流吗？**
会重启 mihomo 服务一次（秒级断流）。随后的订阅更新（`u` / `U`）走 API，
不重启、不断流。

**Q：订阅 URL 里的 token 会泄露吗？**
token 只保存在本机两个文件里（`subscriptions.json` 与内核 `config.yaml`），
所有 TUI/CLI 展示、日志、错误信息都经过 `redactUrl` 脱敏；
测试套件里禁止出现真实 token，并有全局防护禁止测试写入生产配置目录。

## 开发

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # vitest 单元 + 集成测试
npm run coverage         # 覆盖率报告
npm run build            # 编译到 dist/
npm run dev -- status    # tsx 直跑源码
```

测试覆盖 `src/config/` 全模块（语句 94%+）、REST 客户端（本地假内核）、
WebSocket 状态机（FakeWebSocket + fake timers）、TUI 对话框（无头渲染 +
按键注入）与订阅事务的逐阶段回滚；测试物理禁止写入真实的
`~/.config/mihomo{,-tui}` 目录（`vitest.setup.ts` 全局防护）。

`bin/mihomo-tui` 优先用 `dist/cli.js`，未编译时回退 tsx 直跑源码。

```txt
src/
├── api/          # REST 客户端 + WebSocket 流封装
├── commands/     # CLI 子命令
├── config/       # 订阅清单、骨架生成、ConfigManager（唯一写配置的模块）、
│                 # ServiceManager、订阅事务编排（subscriptionService）
├── rules/        # 规则类型转换、保守匹配与运行时禁用确认
├── views/        # TUI 六个标签页 + 订阅表单校验
├── components/   # DelayBadge / ScrollList / StatusBar / 三个对话框
├── hooks/        # useProxies / useProviders / useStream
├── App.tsx       # TUI 根组件
├── cli.tsx       # CLI/TUI 路由
└── config.ts     # mihomo-tui 自身配置读取
```

更多设计与一手实测数据：

规则管理的隔离内核验收：先 `npm run build`，再运行 `node scripts/smoke-rules.mjs /absolute/path/to/mihomo`。该脚本使用临时配置和随机回环端口验证禁用/恢复及规则集更新，不读取或重载现有服务配置。

规则编辑的隔离验收使用 `node scripts/smoke-rule-editing.mjs /absolute/path/to/mihomo`，要求 v1.19.24；覆盖增改移删、所有常用类型及复杂原文保留、无效配置阻断、重载响应丢失后的原字节恢复。检查过程仅操作脚本自己的临时配置目录和内核进程。

| 文档 | 内容 |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | 完整设计规格：痛点分析、API 实测、架构决策、踩坑记录 |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 开发文档：架构分层、核心实现、扩展指南、FAQ |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | 路线图与技术债：待实现功能、竞品对比、非目标清单 |
| [`docs/specs/2026-08-17-subscription-management-design.md`](docs/specs/2026-08-17-subscription-management-design.md) | 订阅生命周期管理（v0.2.0）设计稿 |
| [`docs/specs/2026-09-22-tui-standardize-polish-spec.md`](docs/specs/2026-09-22-tui-standardize-polish-spec.md) | TUI 标准化美化（v0.2.1）设计稿 |
| [`docs/specs/2026-09-24-config-management-spec.md`](docs/specs/2026-09-24-config-management-spec.md) | v0.4.0 规则管理规范与代理链范围修订 |

## 路线图

- [x] v0.1.0 —— CLI + TUI + 配置迁移脚本
- [x] v0.2.0 —— TUI 内订阅生命周期管理（新增 / 删除 / 编辑）+ 自动化测试体系
- [x] v0.2.1 —— TUI 标准化美化：响应式布局、设计系统统一、内核版本管理
- [x] v0.3.0 —— 订阅增强：分组、重命名、远程/本地类型、更新间隔、内联 YAML 编辑（前缀按订阅名自动派生）
- [x] v0.4.0 —— 规则管理：规则页、规则集更新、保守规则测试、运行时禁用/降级标记
- [ ] 后续 —— dialer-proxy 代理链设计；本机 mihomo v1.19.24 已移除 `type: relay`
- [ ] v0.5.0 —— 单二进制打包（Bun/Deno）

详细规划与技术债请参阅 [docs/ROADMAP.md](docs/ROADMAP.md)

## 贡献

欢迎提交 Issue 与 Pull Request！请先阅读
[CONTRIBUTING.md](CONTRIBUTING.md)，特别注意两条设计红线：
运行时代码不写 `config.yaml`，不新增监听端口。

## 许可证

[MIT](LICENSE)
