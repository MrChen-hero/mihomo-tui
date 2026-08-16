# mihomo-tui

mihomo 代理内核的 **CLI + TUI** 管理工具。切节点、更新订阅、看实时日志、管连接，全部通过本机
`127.0.0.1:19090` 的 REST API 完成。

**运行时代码绝不写 `config.yaml`。** 配置改造只由 `scripts/migrate-config.mjs` 在显式
`--apply` 时执行，且强制备份 + `mihomo -t` 校验，校验失败拒绝写入。

## 安装

```bash
cd ~/projects/mihomo-tui
npm install
npm run build
```

`~/.bashrc` 中已有 `proxy_tui` 函数，新开终端即可用；当前终端执行 `source ~/.bashrc` 生效。

首次运行会自动生成 `~/.config/mihomo-tui/config.json`：

```json
{
  "api": "http://127.0.0.1:19090",
  "secret": "",
  "mihomoDir": "/4t/usr/chenjw/.config/mihomo",
  "testUrl": "https://www.gstatic.com/generate_204",
  "testTimeout": 5000,
  "delayThresholds": { "good": 300, "fair": 800 }
}
```

`testUrl` 用 `gstatic.com` 而非 `cp.cloudflare.com` —— 后者经本机节点实测全部失败。

## 用法

### TUI

```bash
proxy_tui            # 无参数进入 TUI
```

四个标签页，数字键 `1`–`4` 切换，`Tab` 循环，`q` 或 `Ctrl+C` 退出。

**[1] 节点** —— 左栏代理组，右栏该组节点。默认只列**含真实节点的组**，
按延迟升序排列，可用节点浮在顶部。

| 键 | 作用 |
|---|---|
| `↑↓` / `jk` | 移动光标 |
| `←→` / `hl` | 左右切栏 |
| `Enter` | 选用节点（对 url-test 组会「钉选」） |
| `u` | 解除钉选，恢复自动选路 |
| `t` | 测速：焦点在左栏测整组，在右栏测单个节点 |
| `s` | 切换排序（延迟升序 / 配置顺序） |
| `v` | 只看可用（滤掉超时与未测试） |
| `a` | 显示/隐藏聚合组（成员全是其他组的组，如 AI、Google） |
| `m` | 切换模式（规则 → 全局 → 直连 → 规则） |
| `r` | 刷新 |

节点状态五分显示，**「未测试」与「不可用」严格区分** —— `lazy: true` 的组在被使用前
所有节点的 `history` 都是空的，不能把没测过当成挂了：

| 状态 | 显示 |
|---|---|
| 正常（< 300ms） | 绿色延迟值 |
| 一般（300–800ms） | 黄色延迟值 |
| 缓慢（> 800ms） | 红色延迟值 |
| 未测试 | 灰色 `---` |
| 超时/错误 | 红色 `超时` |

**[2] 订阅** —— `u` 更新当前项，`U` 更新全部，`c` 健康检查，`Enter` 展开节点列表。
更新失败会把完整错误显示在红框里（订阅域名失效、经代理被 403 都是常态）。

**[3] 日志** —— `l` 循环切级别，`/` 输入关键字过滤，`Space` 暂停/恢复，`c` 清屏。
环形缓冲上限 1000 行。

**[4] 连接** —— `d` 关闭选中，`D` 关闭全部（需按 `y` 二次确认），`s` 切换排序。

底部状态栏常驻，显示内核版本、当前模式、实时速率、累计流量、内存、控制口连接状态。

**模式说明：**
- **规则** —— 根据配置文件中的规则分流（默认）
- **全局** —— 所有流量都走代理
- **直连** —— 所有流量都直连，不走代理

### CLI

每条命令输出一行或一张表，均支持 `--json` 供 `jq` 消费。

```bash
proxy_tui status                        # 内核版本、模式、端口、provider 概览
proxy_tui proxy ls                      # 列出所有代理组及当前选中
proxy_tui proxy ls 香港                  # 列出该组节点、延迟、状态
proxy_tui proxy use <组> <节点>          # 切换节点
proxy_tui proxy unfix <组>              # 解除 url-test/fallback 组的钉选
proxy_tui proxy test 香港                # 整组延迟测试
proxy_tui provider ls                   # 订阅列表（节点数/流量/到期/更新时间）
proxy_tui provider update [名称]        # 更新订阅，省略名称则全部
proxy_tui provider check <名称>         # 触发健康检查
proxy_tui logs -f                       # 实时日志跟随，Ctrl+C 退出
proxy_tui logs -n 20 -g 'error'         # 抓 20 条含 error 的日志后退出
proxy_tui conn ls                       # 当前连接，-s traffic/time/host，-n 限条数
proxy_tui conn close <id|--all>         # 关闭连接（id 支持 8 位前缀）
proxy_tui reload                        # 热重载配置（内核不重启）
```

组名含中文与 emoji 时正常传入即可，程序全程 `encodeURIComponent`：

```bash
proxy_tui proxy ls '悦 · 🇭🇰 香港聚合'
```

**退出码**：`0` 成功，`1` 通用错误，`2` 参数错误，`3` 内核不可达。

## 配置架构

`config.yaml` 为「骨架 + provider」两层结构，订阅更新不再覆盖任何自定义配置：

```txt
config.yaml（骨架，只维护一次）
├── 通用设置 / sniffer / dns / rules / rule-providers
├── proxy-providers:          ← 订阅作为节点来源
│   ├── yuetoto  → ./providers/yuetoto.yaml
│   ├── liangxin → ./providers/liangxin.yaml
│   └── jkun     → ./providers/jkun.yaml
└── proxy-groups:
    ├── PROXY / AUTO / FALLBACK
    ├── 区域组：香港 台湾 日本 韩国 新加坡 美国 英国 德国 荷兰 其他地区
    ├── 机场组：机场-yuetoto / 机场-liangxin / 机场-jkun
    └── 用途组：AI Google YouTube TikTok Telegram 社交媒体 流媒体 游戏平台 兜底分流
```

provider 的 `path` **必须是相对路径** —— mihomo 对此有路径安全校验，配置文件外的绝对路径会被拒绝。

### 迁移脚本

订阅链接放在 `~/.config/mihomo-tui/subscriptions.json`（权限 600，含 token）：

```json
{
  "subscriptions": [
    { "name": "yuetoto", "prefix": "[Y] ", "url": "https://..." }
  ]
}
```

`name` 只能用字母数字与 `-_`（要作文件名）。`prefix` 会通过 `additional-prefix` 注入到
节点名前，用于标记来源。

```bash
node scripts/migrate-config.mjs --dry-run --diff   # 预览骨架与差异，不落盘
node scripts/migrate-config.mjs --apply            # 备份 + 校验 + 写入
node scripts/migrate-config.mjs --apply --no-dns   # 写入但不改 dns 段
```

安全保证：`--dry-run` 也会跑 `mihomo -t`；`--apply` 先备份再写，写入后再校验一次，
失败自动从备份回滚；重复运行结果一致（幂等）。

## 已知环境限制

本机实测结论，与工具本身无关但影响使用预期：

1. **DNS 上游只有特定几个可用。** UDP 53 到公共 DNS（223.5.5.5 / 8.8.8.8 / 1.1.1.1）
   和 DoT 853 全部不通；可用的是网关 `192.168.200.1:53` 与 IP 字面量的 DoH
   （`https://1.12.12.12/dns-query`）。旧配置用 `nameserver: doh.pub` +
   `default-nameserver: tls://223.5.5.5`，bootstrap 必然失败 —— 这是 `dns.enable`
   长期只能设为 `false` 的真正原因。迁移脚本已改用可达的上游。
2. **AI 服务商封锁机场出口 IP。** `claude.ai` 会 302 跳转到
   `claude.com/app-unavailable-in-region`，`api.anthropic.com`、`chatgpt.com`、
   `api.openai.com` 返回 403。测过 14 个不同地区出口，无一例外。这是节点 IP 问题，
   改配置无法解决，需要带 AI 解锁的节点。`gemini.google.com` 正常。
3. **`mihomo` 不回应 WebSocket close 帧。** 客户端 `close()` 握手永不完成，
   底层句柄不释放。因此所有用到流的命令都显式 `process.exit`，非 `--follow` 的
   `logs` 有 `--idle` 空闲超时（默认 5 秒）兜底。

## 开发

```bash
npm run typecheck    # tsc --noEmit
npm run build        # 编译到 dist/
npm run dev -- status  # tsx 直跑源码
```

`bin/mihomo-tui` 优先用 `dist/cli.js`，未编译时回退 tsx 直跑源码。

**联调约束**：不要重启或停止生产的 `mihomo.service`。需要测试破坏性行为时起独立实例
（自定义 `-d` 目录 + 未占用端口，如 27890/29090），用完清理。

技术栈：Node 24（内置 `fetch` 与 `WebSocket`，不依赖 ws/undici/axios）+ Ink 7 +
React 19 + commander 15，TypeScript 锁 5.x。

详细设计与实测数据见 `SPEC.md`。
