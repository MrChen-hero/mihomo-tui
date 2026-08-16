# mihomo-tui 设计规格说明书

> 版本：v1.0　｜　日期：2026-08-16　｜　状态：待评审
> 目标读者：本项目开发者（含新会话接手的 AI 助手）

## 1. 背景与痛点

当前服务器（`/4t/usr/chenjw`）以 `systemd --user` 方式运行 mihomo 内核，通过 `~/.bashrc` 中的 `proxy_on` / `proxy_off` / `proxy_status` / `proxy_use` 四个函数操作。实测确认的痛点如下：

| 编号 | 痛点 | 实测证据 |
|---|---|---|
| P1 | **每份订阅都是整份 YAML**，机场下发的头部（`mixed-port: 7890`、`allow-lan: true`、`external-controller: 9090`）必须每次手工改回 | `profiles/bokemon.yaml.orig` 与 `profiles/bokemon.yaml` 的 diff 显示 11 行头部被手工重写，另加 `geox-url` 与节点删减 |
| P2 | **订阅一更新，手工修改全部丢失**，必须重做 | 同上，`.orig` 文件即为证 |
| P3 | **多订阅互斥**，只能整份切换，无法混用不同机场的节点 | `proxy_use` 实现为 `cp profiles/X.yaml config.yaml` |
| P4 | **切换订阅会重启内核**，掐断所有正在跑的连接 | `~/.bashrc:230` 为 `systemctl --user restart mihomo` |
| P5 | **看不到节点存活与延迟**，只能手写 `curl` 调 REST API | 现有维护文档 `~/docs/mihomo-deployment-and-maintenance.md` 第 11 章全是手写 `curl` 示例 |
| P6 | **看不到订阅流量与到期时间** | 当前 `proxy-providers` 一个都没配，未使用内核的订阅元信息解析能力 |

本项目通过「配置架构改造 + CLI/TUI 操作层」一次性解决 P1–P6。

## 2. 目标与范围

### 2.1 目标

1. 把 `config.yaml` 改造为**骨架 + N 个 provider（代理集合）**结构，使订阅更新不再覆盖任何自定义配置。
2. 提供 **CLI**（命令行子命令，可脚本化）与 **TUI**（Terminal User Interface，终端图形界面）两套操作入口，覆盖切节点、更新订阅、看日志、管连接。
3. 与现有 `proxy_*` 命令面无缝搭配，新增 `proxy_tui`，**不改变** `proxy_on` / `proxy_off` / `proxy_status` 的既有语义。

### 2.2 非目标（明确不做）

- 不做 TUN 模式或透明代理管理。
- 不做订阅转换/聚合服务（Sub-Store 那一类），provider 的合并交给内核。
- 不做配置文件的可视化编辑器。
- 不代管 systemd 服务生命周期（`start`/`stop`/`enable` 仍用 `systemctl --user`）。
- **不暴露任何新的监听端口**，全部操作走本机 `127.0.0.1:19090`。

### 2.3 术语说明

| 术语 | 中文全称与通俗解释 |
|---|---|
| mihomo | 代理内核（原 Clash.Meta），实际负责转发流量的后台程序 |
| TUI | Terminal User Interface，终端图形界面 —— 在纯文字终端里画出可用方向键操作的界面 |
| CLI | Command Line Interface，命令行界面 —— 敲一条命令得一个结果，适合写进脚本 |
| provider（代理集合） | mihomo 的 `proxy-providers`，把一个订阅当作「节点来源」挂载进配置，内核负责拉取与定时更新 |
| proxy-group（代理组） | 一组节点的集合，带选择策略（手动选 `select` / 自动测速 `url-test` / 故障转移 `fallback`） |
| External Controller | mihomo 的 REST API（表述性状态转移应用程序接口）控制口，本机为 `127.0.0.1:19090` |
| health-check（健康检查） | 内核定期向测速地址发请求，判断节点是否存活及其延迟 |
| Ink | 用 React 语法编写终端界面的框架 |
| Subscription-Userinfo | 机场订阅响应里的一个 HTTP 头，携带已用流量、总流量、到期时间 |

## 3. 环境事实（已实测确认）

编写代码前请以此为准，勿凭记忆假设。

### 3.1 运行环境

| 项目 | 值 |
|---|---|
| 主机 / 系统 | Linux 7.0.0-28-generic，Ubuntu 24.04 系 |
| 当前用户 | `chenjw`（uid 1001，属 `sudo`、`docker` 组） |
| 家目录 | `/4t/usr/chenjw`（**非** `/home/chenjw`） |
| 会话类型 | `Type=tty`、`Remote=yes`、`DISPLAY` 为空 —— **无图形界面**，只能用 TUI/CLI |
| 磁盘 | `/4t` 剩余 2.6T |
| Node.js | v24.14.0（路径 `/4t/usr/chenjw/.nvm/versions/node/v24.14.0/bin`），npm 11.9.0 |
| 全局 `WebSocket` / `fetch` | **均为原生内置**，无需 `ws` 或 `undici` 依赖 |

### 3.2 mihomo 现状

| 项目 | 值 |
|---|---|
| 二进制 | `/4t/usr/chenjw/bin/mihomo`，Mihomo Meta **v1.19.24**，`with_gvisor` |
| 服务 | `systemd --user` 单元 `mihomo.service`，`enabled` + `active`，`Linger=yes` |
| 配置目录 | `/4t/usr/chenjw/.config/mihomo` |
| 混合代理口 | `127.0.0.1:17890`（`mixed-port`，HTTP 与 SOCKS 共用） |
| 控制口 | `127.0.0.1:19090`（`external-controller`），**当前无 `secret`** |
| 现有 profile | `profiles/` 下 `yuetoto` / `liangxin` / `bokemon` / `empty`，当前活动为 `yuetoto` |
| 现有 config.yaml | 64KB，与 `profiles/yuetoto.yaml` 完全一致 |

### 3.3 REST API 实测结果

以下全部为本机实际探测所得，**非文档推断**。

只读接口（均返回 HTTP 200）：

```txt
/version  /configs  /proxies  /providers/proxies  /providers/rules
/rules    /connections  /memory  /traffic
```

`/version` 实际返回：

```json
{"meta":true,"version":"v1.19.24"}
```

**WebSocket 推送已确认可用** —— `/traffic`、`/logs?level=info`、`/connections` 三个端点在带 Upgrade 头请求时均返回 `HTTP/1.1 101 Switching Protocols`。`/traffic` 实际推送帧：

```json
{"up":0,"down":0,"upTotal":1953919,"downTotal":8544846}
```

**热重载已确认可用**（这是本项目能避免 P4 的关键）：

```txt
PUT /configs?force=false  →  HTTP 204
进程 PID 2853 保持不变，连接不中断
```

单节点对象形状（`GET /proxies/DIRECT`）：

```json
{"alive":true,"dialer-proxy":"","extra":{},"history":[],
 "id":"1f199813-...","name":"DIRECT","provider-name":"",
 "type":"Direct","udp":true,...}
```

关键写接口：

| 接口 | 方法 | 作用 | 备注 |
|---|---|---|---|
| `/proxies/{group}` | PUT | 切换代理组当前选中节点 | body `{"name":"节点名"}`，路径中文需 URL 编码 |
| `/proxies/{name}/delay` | GET | 单节点延迟测试 | 参数 `timeout`、`url` |
| `/group/{group}/delay` | GET | 整组延迟测试 | 返回 `{节点名: 延迟}` 映射 |
| `/providers/proxies/{name}` | PUT | **更新指定订阅** | 返回 204 |
| `/providers/proxies/{name}/healthcheck` | GET | 触发该 provider 健康检查 | |
| `/configs?force=false` | PUT | 热重载配置文件 | body `{"path":"...","payload":""}` |
| `/connections` | DELETE | 关闭全部连接 | |
| `/connections/{id}` | DELETE | 关闭单条连接 | |

### 3.5 补充实测（检查点 2 期间新增）

以下为本项目 API 层开发时新测到的行为，与 3.3 节同为一手数据：

| 场景 | 实际返回 | 设计含义 |
|---|---|---|
| `PUT /proxies/{group}`，组为 `url-test`/`fallback` | `204`，但写入的是 `fixed` 字段而非 `now` | 该组被「钉」在指定节点；需 `DELETE /proxies/{group}` 才能解除，恢复自动测速 |
| `PUT /proxies/{group}`，节点不在组内 | `400 {"message":"Selector update error: proxy not exist"}` | 业务错误，非程序崩溃 |
| `GET /proxies/{不存在}` | `404 {"message":"Resource not found"}` | 归入 HTTP 错误（调用方名字写错） |
| `GET /proxies/{失效节点}/delay` | `503 {"message":"An error occurred in the delay test"}` | 业务错误 = 节点不可用；**注意状态码是 5xx 不是 4xx** |
| `GET /group/{group}/delay` | `200`，失效节点**不出现**在结果映射里 | 不能用「键缺失」等同「未测试」，需与 `history` 结合判断 |
| `GET /connections` 无连接时 | `connections: null`（不是 `[]`） | 类型须允许 `null` |
| `GET /memory` | 空响应体 | 内存取值改用 `/connections` 的 `memory` 字段或 WebSocket `/memory` |
| 代理组的 `extra` 字段 | 按测速地址分组的 `{alive, history}` | 同一节点在不同 `testUrl` 下有独立测速记录 |

**错误分类规则**（`client.ts` 已按此实现）：`401`/`404` → `HttpStatusError`；其余带 `message` 的非 2xx → `ApiBusinessError`（含 400 与 503）；网络层失败或超时 → `KernelUnreachableError`（退出码 3）。

### 3.6 WebSocket 关闭行为（检查点 3 期间发现，影响所有用到流的代码）

**mihomo v1.19.24 从不回应客户端的 WebSocket close 帧。** 用裸 socket 发送 opcode `0x8` 后，服务端继续推送数据帧（`0x1`）与 ping（`0xb`），至少 35 秒内不回 close、不断 TCP。

后果：Node 内置（undici）的 `WebSocket.close()` 依赖对端回应才能完成握手，因此 `readyState` 永久停在 `2 (CLOSING)`，`close` 事件不触发，底层 TCP 句柄不释放，**事件循环永不为空、进程不会自然退出**。

已确认对 `/traffic`、`/logs` 以及生产与测试两个实例均成立。

应对（已实现）：

- `Stream.close()` 只保证「不再回调、不再重连」，不承诺句柄释放；
- 用过流的 CLI 命令必须显式退出，统一走 `output.ts` 的 `exitAfterFlush()`；
- 非 `--follow` 的 `logs` 增加 `--idle`（默认 5 秒）空闲超时，避免内核闲置时命令永久挂住；
- TUI 在 `unmount` 之后同样必须显式 `process.exit`，不能依赖事件循环自然排空。

### 3.7 三份联调订阅实测（检查点 3）

| 订阅 | 直连 | 经代理 | 节点数（过滤后） | Subscription-Userinfo |
|---|---|---|---|---|
| yuetoto（悦通） | 200 | 200 | 48 | 剩余 1.95 TB，`expire=` 空 |
| liangxin（良心） | 200 | **403** | 61 | 剩余 987 GB，`expire=` 空 |
| jkun（宝可梦） | 200 | 200 | 107 | 剩余 208 GB，`expire=` 空 |

要点：

1. **liangxin 经代理访问返回 403**，必须直连拉取。设计含义：provider 更新失败可能只是「拉取路径不对」而非订阅失效，错误文本必须完整展示，不能简化为「更新失败」。
2. **三家 `Expire` 全为 0**（HTTP 头里 `expire=` 为空值），内核日志刷 `get subscription-userinfo: failed to parse value ''` 警告。`provider ls` 的 EXPIRE 列因此显示「长期有效」，这是真实情况而非 bug。
3. **伪装节点**：三家都把「剩余流量 / 套餐到期」塞进 `proxies`；jkun 额外有「建议：感到卡顿请切换到专线节点」「放丢失官网:https://...」。6.3 节的 `exclude-filter` 需补充 `建议|丢失|订阅|邀请|客服|网址` 关键字，实测过滤后 112 → 107 个节点。
4. **五状态全部覆盖到真实数据**：216 节点的 AUTO 组分布为 `good=106 / fair=74 / slow=11 / dead=25`，验证了「未测试」与「不可用」必须区分的设计。

### 3.8 本机 DNS 环境实测（检查点 4，**决定了迁移脚本必须重写 dns 上游**）

开启 `dns.enable` 不是改一行 `false → true` 那么简单 —— 照搬旧配置的上游会让内核彻底失去解析能力。逐项实测结果：

| 上游形式 | 目标 | 结果 |
|---|---|---|
| UDP 53 | `223.5.5.5` / `8.8.8.8` / `1.1.1.1` / `114.114.114.114` | ❌ 全部不通 |
| DoT 853 | `223.5.5.5` / `119.29.29.29` | ❌ 不通 |
| UDP 53 | 网关 `192.168.200.1` | ✅ 可用 |
| DoH 443（IP 字面量） | `1.12.12.12` / `120.53.53.53` | ✅ 可用（wire-format 返回 200） |
| DoH 443（域名） | `doh.pub` / `dns.alidns.com` | ⚠️ 需先解析域名，依赖 bootstrap |
| DoH 443（境外） | `1.1.1.1` / `8.8.8.8` 直连 | ❌ 不通；经代理 ✅ 200 |

**旧配置的致命链条**：`nameserver: doh.pub` 要先解析 `doh.pub` → 用 `default-nameserver: tls://223.5.5.5`（853 端口）→ 本机不通 → bootstrap 失败 → 所有解析失败。**这就是 `dns.enable` 一直只能是 `false` 的真正原因**，并非有人忘了打开。

因此迁移脚本写入的上游是（`DNS_UPSTREAM` 常量）：

```yaml
default-nameserver: ['192.168.200.1']            # bootstrap 只能填纯 IP，且必须真正可达
nameserver: ['https://1.12.12.12/dns-query', 'https://120.53.53.53/dns-query']  # IP 字面量，无需 bootstrap
proxy-server-nameserver: [同上]                   # respect-rules: true 要求此项非空，否则 mihomo -t 拒绝
respect-rules: true
```

另有两处踩坑：

1. **`respect-rules: true` 且 `proxy-server-nameserver` 为空时，`mihomo -t` 直接报错**：`if "respect-rules" is turned on, "proxy-server-nameserver" cannot be empty`。二者必须成对出现。
2. **订阅域名必须有 DIRECT 规则**。内核拉取订阅时也走自身 rules，若落到 `MATCH` 指向的代理组，而该组节点来自尚未拉取成功的 provider，就形成**死锁**（provider 空 → 组空 → 拉不动 → provider 永远空）。迁移脚本因此在 rules 顶部自动插入 `DOMAIN,<订阅域名>,DIRECT`。

### 3.4 已知故障（本项目不负责修复，但 TUI 需能呈现）

1. **DNS 段整体失效**：`config.yaml:28` 为 `dns.enable: false`，但其下 17 行 `nameserver-policy`（把 `claude.ai`、`openai.com` 等指向 `1.1.1.1`）全是死配置。后果是走代理仍无法访问 Google：日志 `dial Google (match RuleSet/google) --> www.gstatic.com:443 error: dns resolve failed`。
2. **当前订阅大面积失效**：50 个节点仅 5 个 `alive`。`srv-k9mx.yuetong.online`、`edge-di.yuetong.online` **DNS 已无法解析**；`v4.yuetoto.net:443` 端口通但握手 `connection reset by peer` / `EOF`。逐节点实测可用者：日本1 = 1138ms、韩国1 = 213ms、泰国1 = 567ms、英国1 = 353ms、德国1 = 1493ms。

**设计含义**：TUI 的节点列表必须能清晰区分「未测试」「测试中」「超时」「错误」「正常（含延迟值）」五种状态，不能把「未测试」和「不可用」混为一谈 —— 因为 `lazy: true` 的组在未被使用前所有节点的 `history` 都是空的。

## 4. 架构决策

### 4.1 决策一：配置改造为 proxy-providers 架构

**这是本项目的地基**，不做这一步，TUI 只能重复 `proxy_use` 的整份覆盖逻辑，P1–P4 一个都解决不了。

新的 `config.yaml` 拆成两层：

```txt
config.yaml（骨架 —— 你只维护一次，订阅更新永不触碰）
├── 通用设置：mixed-port / external-controller / sniffer / dns / rules
├── proxy-providers:          ← 订阅作为「节点来源」挂载
│   ├── yuetoto:  {type: http, url: ..., interval: 3600}
│   └── liangxin: {type: http, url: ..., interval: 3600}
└── proxy-groups:             ← 按需组合，与订阅解耦
    ├── PROXY  (select)
    ├── AUTO   (url-test, include-all-providers: true)
    ├── 日本   (url-test, filter: '(?i)(日本|jp|japan)')
    └── 机场-悦 / 机场-良心  (select, use: [对应 provider])
```

**已 PoC 验证通过**（独立实例，端口 27890/29090，未干扰生产服务）：

```txt
providers: liangxin(File)=46 nodes   yuetoto(File)=48 nodes
groups:    AUTO(URLTest)=94   日本(URLTest)=17
           机场-悦=48   机场-良心=46
节点名:    [L] 🇯🇵日本高速01|CTCU|0.5x   （additional-prefix 自动注入来源标记）
延迟测试:  tested=94  alive=23   （两个机场的节点混在同一组内同时可用）
```

由此得到的收益与痛点对应关系：

| 收益 | 解决 |
|---|---|
| 订阅更新只覆盖 provider 缓存，骨架配置完全不动 | P1、P2 |
| 多机场节点可同时加载、混在一个组里用 | P3 |
| `PUT /providers/proxies/{name}` 更新订阅，无需重启内核 | P4 |
| `health-check` 提供存活与延迟数据供 TUI 展示 | P5 |
| `type: http` 的 provider 自动解析 `Subscription-Userinfo` | P6 |

**关键约束（PoC 中踩到的坑）**：mihomo 对 `type: file` 的 provider 有路径安全校验，配置文件外的绝对路径会被拒绝：

```txt
level=fatal msg="Parse config error: parse proxy provider yuetoto error:
path is not subpath of home directory or SAFE_PATHS: /4t/usr/.../yuetoto.yaml
allowed paths: [/tmp/mihomo-poc]"
```

**因此 provider 的 `path` 必须使用相对路径**（如 `./providers/yuetoto.yaml`），相对于 `-d` 指定的工作目录。

### 4.2 决策二：TUI 只调 REST API，绝不写 config.yaml

这是本项目最重要的安全边界。

- TUI 与 CLI 的**所有**运行时操作（切节点、更新订阅、测延迟、断连接）都通过 `127.0.0.1:19090` 完成。
- 程序**不具备**写 `config.yaml` 的代码路径。骨架配置由人工维护（或由本项目提供的一次性迁移脚本生成，需人工确认后执行）。
- 好处：即使程序有 bug，最坏后果是某个代理组选错节点，一条命令即可改回；绝不可能损坏你手工调优的 64KB 配置。

对比被否决的方案：若 TUI 复刻 `proxy_use` 的 `cp` + 覆盖逻辑，则程序必须持有配置文件写权限，一旦逻辑出错会直接毁掉 sniffer 白名单、DNS 策略、rule-providers 全套配置。

### 4.3 决策三：技术栈 Node 24 + Ink 7 + React 19

| 依赖 | 版本 | 用途 | 备注 |
|---|---|---|---|
| `ink` | ^7.1.1 | TUI 渲染框架 | 要求 `node >= 22`（本机 v24.14.0 满足） |
| `react` | ^19.2.8 | Ink 的 peer 依赖 | `ink@7` 要求 `>=19.2.0` |
| `@types/react` | ^19.2.0 | 类型定义 | ink 声明为 optional peer |
| `@inkjs/ui` | ^2.0.0 | 现成组件（Select、Spinner、ProgressBar） | peer `ink >= 5` |
| `commander` | ^15.0.0 | CLI 参数解析 | |
| `yaml` | ^2.9.0 | 只用于**读取**配置做展示 | 不用于写 |
| `typescript` | ^5.x | 类型检查 | 注意：npm 上 `typescript@latest` 已是 7.0.2，**请显式锁 5.x**，Ink 生态尚未普遍适配 7 |
| `tsx` | ^4.23.12 | 开发期直接跑 TS | |

**明确不需要的依赖**：`ws`、`undici`、`axios`、`node-fetch` —— Node 24 已内置全局 `WebSocket` 与 `fetch`（已实测 `typeof WebSocket === 'function'`）。

选择理由：无需额外工具链（Go 需先装约 200MB，本机 `go` 命令不存在），React 语法便于把「代理组列表」「节点列表」「日志流」拆成独立组件，`@inkjs/ui` 提供开箱可用的选择器与加载动画。

### 4.4 决策四：与 proxy_* 命令面的搭配方式

在 `~/.bashrc` 新增 `proxy_tui` 函数，**`proxy_on` / `proxy_off` / `proxy_status` 三者语义完全不变**。

理由：现有维护文档明确记录了「`proxy_on` / `proxy_off` 只看成 shell 级开关，不要把它当服务开关」这条原则。若让 `proxy_on` 自动拉起 TUI，则非交互脚本中调用 `proxy_on` 会被阻塞。

```bash
# ~/.bashrc 新增（不动现有三个函数）
proxy_tui() {
    local bin="$HOME/projects/mihomo-tui/bin/mihomo-tui"
    if [ ! -x "$bin" ]; then
        echo "mihomo-tui not found or not executable: $bin" >&2
        return 1
    fi
    "$bin" "$@"
}
```

`proxy_use` 的处置：架构改造后它已无意义（不再有整份切换的概念）。**保留但改造为兼容提示**，输出「已迁移到 provider 架构，请使用 `proxy_tui`」并列出当前 provider 列表，避免肌肉记忆失效时的困惑。旧的 `profiles/*.yaml` 全部保留不删，作为回滚素材。

预期使用流程：

```txt
$ proxy_on                 # 只设环境变量（行为不变）
shell proxy: ON (http://127.0.0.1:17890)

$ proxy_tui                # 无参数 → 进入 TUI
┌─ mihomo-tui ────────────────────────────────────┐
│ [1]节点 [2]订阅 [3]日志 [4]连接      ↑↓选择 q退出 │
├─────────────────────────────────────────────────┤
│ PROXY       → AUTO                              │
│ AUTO        → [Y]日本1          166ms           │
│ 日本        → [L]日本高速02      213ms           │
│ 机场-悦     → [Y]新加坡2         ---（未测试）   │
└─────────────────────────────────────────────────┘

$ proxy_tui proxy ls       # 带参数 → 走 CLI，可管道可脚本
$ proxy_status             # 行为不变
$ proxy_off                # 行为不变
```

## 5. 组件设计

### 5.1 目录结构

```txt
/4t/usr/chenjw/projects/mihomo-tui/
├── SPEC.md                  # 本文档
├── README.md                # 使用说明
├── package.json
├── tsconfig.json
├── bin/
│   └── mihomo-tui           # 可执行入口（shebang 指向 node）
├── src/
│   ├── cli.tsx              # commander 入口：无子命令则渲染 TUI
│   ├── config.ts            # 读取 ~/.config/mihomo-tui/config.json
│   ├── api/
│   │   ├── client.ts        # REST 封装（fetch）
│   │   ├── stream.ts        # WebSocket 封装（logs/traffic/connections）
│   │   └── types.ts         # API 响应类型
│   ├── commands/            # CLI 子命令实现
│   │   ├── proxy.ts
│   │   ├── provider.ts
│   │   ├── conn.ts
│   │   └── status.ts
│   ├── App.tsx              # Ink 根组件：标签页容器 + 全局快捷键
│   ├── views/
│   │   ├── Proxies.tsx      # 代理组 / 节点选择
│   │   ├── Providers.tsx    # 订阅管理
│   │   ├── Logs.tsx         # 实时日志
│   │   └── Conns.tsx        # 连接管理
│   ├── components/
│   │   ├── StatusBar.tsx    # 底部状态栏（内核版本/流量/内存）
│   │   ├── DelayBadge.tsx   # 延迟着色标签
│   │   └── ErrorToast.tsx   # 错误提示
│   └── hooks/
│       ├── useProxies.ts
│       ├── useProviders.ts
│       └── useStream.ts
├── scripts/
│   └── migrate-config.mjs   # 一次性迁移脚本：生成 provider 骨架
└── templates/
    └── config.skeleton.yaml # 骨架配置模板
```

### 5.2 配置文件

程序自身配置放 `~/.config/mihomo-tui/config.json`，首次运行时自动生成：

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

`testUrl` 默认用 `gstatic.com` 而非 `cp.cloudflare.com`：本机实测前者在部分节点上可通（日本1 = 1138ms），后者经代理返回 `code=000` 全部失败。

### 5.3 API 层

`src/api/client.ts` 要点：

- 统一注入 `Authorization: Bearer <secret>`（当 `secret` 非空）。
- 路径中的组名与节点名**必须** `encodeURIComponent` —— 现有配置里大量使用中文与 emoji 组名（如 `悦 · 🇭🇰 香港聚合`）。
- 所有请求带超时（默认 8s，延迟测试单独放宽到 `testTimeout + 2000`）。
- 区分三类失败：连接不上内核（服务未启动）、HTTP 错误状态、业务错误（如延迟测试返回 `{"message":"An error occurred in the delay test"}`）。**不可把业务错误当成节点不可用之外的崩溃处理**。

`src/api/stream.ts` 要点：

- 用原生 `WebSocket`，URL 形如 `ws://127.0.0.1:19090/logs?level=info`。
- `secret` 非空时通过 query 参数 `token` 传递（WebSocket 无法自定义头）。
- 断线自动重连，退避 1s → 2s → 4s，上限 30s。
- 日志视图需做**环形缓冲**，上限 1000 行，防止长时间运行内存膨胀。

## 6. 功能规格

### 6.1 CLI 子命令

设计原则：**每条命令输出一行或一张表，可被 `grep`/`jq` 消费**。所有命令支持 `--json` 输出原始 JSON。

```txt
proxy_tui                              # 无子命令 → 进入 TUI
proxy_tui status                       # 内核版本、模式、端口、provider 概览
proxy_tui proxy ls [组名]              # 列出代理组及当前选中；带组名则列该组节点
proxy_tui proxy use <组名> <节点名>     # 切换节点  → PUT /proxies/{group}
proxy_tui proxy unfix <组名>           # 解除 url-test/fallback 组的钉选 → DELETE /proxies/{group}
proxy_tui proxy test <组名>            # 整组延迟测试 → GET /group/{group}/delay
proxy_tui provider ls                  # 列出所有 provider（含流量/到期/更新时间）
proxy_tui provider update [名称]       # 更新订阅，省略名称则全部更新
proxy_tui provider check <名称>        # 触发健康检查
proxy_tui logs [-l level] [-f]         # 实时日志，-f 持续跟随，非 -f 用 --idle 控制空闲退出
proxy_tui conn ls                      # 当前连接列表，--sort traffic/time/host，-n 限制条数
proxy_tui conn close <id|--all>        # 关闭连接（id 支持 ls 显示的 8 位前缀）
proxy_tui reload                       # 热重载配置 → PUT /configs
```

`proxy unfix` 是 3.5 节实测结果带来的新增命令：对 `url-test`/`fallback` 组执行 `proxy use` 会写 `fixed` 把组钉死，必须有对应的解除入口。`proxy use` 在这种情况下会主动提示。

`proxy_tui provider ls` 的目标输出（区分 http 与 file 两种类型，对应 4.5 节）：

```txt
NAME       TYPE   NODES  ALIVE  USAGE            EXPIRE      UPDATED
yuetoto    http   48     5      1999.92 GB 剩余   长期有效     2h 前
liangxin   http   46     18     ---              2026-12-01  1d 前
bokemon    file   32     ---    ---              ---         手动
```

### 6.2 TUI 界面

四个标签页，数字键 `1`–`4` 直接切换，`Tab` 循环，`q` 或 `Ctrl+C` 退出。

**标签页 1：节点（Proxies）**

左右两栏布局。左栏为代理组列表（含当前选中节点名），右栏为选中组内的节点列表。

```txt
┌─ 代理组 ──────────────┬─ 节点：日本 ──────────────────────┐
│ > PROXY      AUTO     │ > [Y] 悦·🇯🇵日本1        1138ms   │
│   AUTO       [Y]日本1 │   [Y] 悦·🇯🇵日本2        错误     │
│   日本       [L]高速02│   [L] 🇯🇵日本高速01|CTCU  213ms ✓ │
│   机场-悦    新加坡2  │   [L] 🇯🇵日本高速02|CTCU  ---     │
│   机场-良心  ---      │   ...                             │
└───────────────────────┴───────────────────────────────────┘
 ↑↓ 移动  Enter 选用  t 测该组延迟  r 刷新  1-4 切页  q 退出
```

节点状态五分显示（对应 3.4 节的设计含义）：

| 状态 | 显示 | 判定依据 |
|---|---|---|
| 正常 | 绿色延迟值 + `✓` | `history` 末条 `delay > 0` 且低于 `good` 阈值 |
| 一般 | 黄色延迟值 | 延迟在 `good` 与 `fair` 之间 |
| 缓慢 | 红色延迟值 | 延迟高于 `fair` |
| 未测试 | 灰色 `---` | `history` 为空（`lazy: true` 组的常态） |
| 错误/超时 | 红色 `错误` / `超时` | 延迟测试返回 `message` 字段 |

`t` 键触发整组测试期间，逐节点显示 Spinner，结果流式回填 —— 不可阻塞整个界面。

**标签页 2：订阅（Providers）**

列表展示所有 provider，字段同 CLI 的 `provider ls`。快捷键：`u` 更新当前项，`U` 更新全部，`c` 触发健康检查，`Enter` 展开查看该 provider 下的节点。

更新过程需显示进度与结果，失败时展示完整错误（当前订阅域名已失效，失败是常态，错误信息必须可见）。

**标签页 3：日志（Logs）**

WebSocket 实时日志流。`l` 键循环切换级别（`silent`/`error`/`warning`/`info`/`debug`），`/` 键输入关键字过滤，`Space` 暂停/恢复滚动，`c` 清屏。按级别着色。

**标签页 4：连接（Conns）**

实时连接列表，展示 主机 / 规则 / 代理链 / 上下行流量 / 持续时长。`d` 关闭选中连接，`D` 关闭全部（需二次确认），`s` 切换排序（按流量/时长）。

**底部状态栏**（常驻，所有标签页可见）

```txt
 mihomo v1.19.24 │ rule │ ↑1.9MB ↓8.5MB │ mem 62MB │ 19090 ● 已连接
```

数据来源：`/version` 一次性取，`/traffic` 与 `/memory` 走 WebSocket 持续更新。内核连不上时状态栏转红显示「● 断开」，并在界面中央提示 `systemctl --user status mihomo` 排查建议。

### 6.3 迁移脚本

`scripts/migrate-config.mjs` 负责把现有配置一次性改造为 provider 架构。**必须是幂等的、可预览的、不自动执行的**。

```txt
node scripts/migrate-config.mjs --dry-run    # 只打印将生成的骨架，不落盘
node scripts/migrate-config.mjs --apply      # 备份原配置后写入
```

行为要求：

1. 先备份 `config.yaml` 为 `config.yaml.bak.<时间戳>`。
2. 从现有 `config.yaml` 提取并保留：`sniffer`、`dns`、`rules`、`rule-providers`、通用端口设置。
3. provider 来源为 `~/.config/mihomo-tui/subscriptions.json`（权限 600，含 token），全部生成 `type: http` 条目，`path` 为**相对路径**（4.1 节的路径安全约束）。旧的 `profiles/*.yaml` 不再参与，可自行删除。
4. 生成区域分组（`filter` 正则按国旗 emoji 与中英文关键字匹配）与 `机场-*` 分组。区域正则已用真实 216 个节点名验证过归类结果，未归入任何区域的 67 个节点进 `其他地区` 组。**台湾组必须包含 `🇨🇳`** —— 实测三家订阅都把台湾节点标为 `🇨🇳`（如 `[L] 🇨🇳台湾专线01`），且没有任何真正的大陆节点。
5. 统一加 `exclude-filter: '(?i)(剩余|到期|官网|流量|套餐|重置|过期|群组|订阅|邀请|客服|网址|建议|丢失)'` 过滤机场的假节点。三份联调订阅实测（3.7 节）都存在这类条目：`剩余流量：1.95 TB`、`套餐到期：长期有效`、`建议：感到卡顿请切换到专线节点`、`放丢失官网:https://love.p6m6.com`。
6. 在 rules 顶部插入订阅域名的 `DIRECT` 规则，避免拉取订阅时形成死锁（3.8 节踩坑 2）。
7. 开启 `dns.enable` 时**必须同时替换 DNS 上游**为本机实测可达的地址（3.8 节），照搬旧值会导致 bootstrap 失败。`--no-dns` 可跳过整个 DNS 改动。
8. 写入前用 `~/bin/mihomo -t -d <临时目录> -f <file>` 校验，**校验失败则拒绝写入**；写入后再校验一次，失败则**从备份自动回滚**。

## 7. 错误处理

| 场景 | 处理方式 |
|---|---|
| 内核未启动（连接 19090 被拒） | CLI 打印一行错误并给出 `systemctl --user status mihomo`，退出码 3；TUI 显示断开态并允许重试，不崩溃 |
| HTTP 401 | 提示 `secret` 配置错误，指向 `~/.config/mihomo-tui/config.json` |
| 延迟测试返回 `{"message": "..."}` | 视为该节点不可用，标红显示，**不视为程序错误** |
| WebSocket 断开 | 指数退避重连，状态栏显示重连中；重试期间保留已有数据 |
| provider 更新失败 | 展示完整错误文本（含 DNS 解析失败、连接重置等），保留旧节点数据 |
| 组名/节点名含特殊字符 | 全程 `encodeURIComponent`，禁止手工拼接字符串 |
| 终端过窄（< 80 列） | 降级为单栏布局，不做横向截断导致的乱码 |

**退出码约定**：`0` 成功，`1` 通用错误，`2` 参数错误，`3` 内核不可达。

## 8. 安全边界

1. **不新增监听端口**。所有操作走本机 `127.0.0.1:19090`，不做任何对外服务。
2. **不写 `config.yaml`**。运行时代码路径中不存在写配置文件的能力（迁移脚本是独立的、需显式 `--apply` 的一次性工具）。
3. **不改 `external-controller` 绑定地址**。若后续需要远程访问，正确做法是 SSH 端口转发（`ssh -L 19090:127.0.0.1:19090`），而非把控制口暴露到 `0.0.0.0` —— 当前**无 `secret`**，暴露即等于把代理配置的写权限交给整个网络。
4. **不打印敏感信息**。provider 的订阅 URL 含 `token`，在任何日志与界面展示中必须脱敏为 `https://xxx/...?token=<REDACTED>`。
5. **不代管 systemd**。服务的启停由用户用 `systemctl --user` 操作。

## 9. 执行检查点

- [x] 检查点 1：项目脚手架就绪 —— `package.json`（依赖版本按 4.3 节锁定）、`tsconfig.json`、`bin/mihomo-tui` 可执行入口；`proxy_tui status` 能连上 19090 并正确打印内核版本 `v1.19.24`
- [x] 检查点 2：API 层完成 —— `api/client.ts` 与 `api/stream.ts` 通过；中文/emoji 组名编码正确，WebSocket 能收到 `/traffic` 推送帧
- [x] 检查点 3：CLI 子命令全部可用 —— `proxy ls/use/test`、`provider ls/update/check`、`logs`、`conn ls/close`、`reload`，均支持 `--json`
- [x] 检查点 4：迁移脚本完成 —— `--dry-run` 输出正确骨架，`--apply` 带备份与 `mihomo -t` 校验；在现有两份 profile 上验证生成结果可通过校验
- [ ] 检查点 5：TUI 四个标签页可用 —— 节点五状态显示正确、订阅更新有进度与错误、日志可过滤、连接可关闭；状态栏实时数据正常
- [ ] 检查点 6：集成完成 —— `.bashrc` 新增 `proxy_tui` 并改造 `proxy_use` 提示；README 写好；完成第 10 节验证

## 10. 验证方式

**每个检查点后立即执行对应验证，不积压到最后。**

| 验证项 | 命令 / 方法 | 期望结果 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit` | 无错误 |
| 内核连通 | `proxy_tui status` | 输出 `v1.19.24`、`rule` 模式、`17890` 端口 |
| 中文组名编码 | `proxy_tui proxy ls '悦 · 🇯🇵 日本聚合'` | 正确列出该组节点，不报 404 |
| 切节点 | `proxy_tui proxy use <组> <节点>` 后 `proxy_tui proxy ls <组>` | 选中项已变更 |
| 延迟测试 | `proxy_tui proxy test '悦 · 🇯🇵 日本聚合'` | 返回延迟映射，可用节点有数值，失效节点标错误 |
| WebSocket | `proxy_tui logs -f` | 持续输出日志，Ctrl+C 干净退出 |
| 迁移脚本安全性 | `node scripts/migrate-config.mjs --dry-run` | 只打印不落盘；`git diff` 或文件 mtime 无变化 |
| 迁移结果有效性 | `~/bin/mihomo -t -d <临时目录> -f <生成的骨架>` | `configuration file ... test is successful` |
| 生产服务未受影响 | `systemctl --user is-active mihomo` | 全程保持 `active` |
| 长时运行内存 | TUI 开日志页放置 10 分钟 | 内存稳定，日志环形缓冲生效（≤1000 行） |

**开发期强制约束**：任何在本机的联调都不得重启或停止生产的 `mihomo.service`。需要测试破坏性行为时，按 PoC 的做法起独立实例（自定义 `-d` 目录 + 未占用端口，如 27890/29090），用完清理。

## 11. 关键参考

开发前必读：

1. **本文档**，特别是第 3 节（环境事实）与第 4 节（架构决策）。
2. `/4t/usr/chenjw/docs/mihomo-deployment-and-maintenance.md` —— 现有部署与维护文档。**注意其中路径写的是 `/8t/usr/chjw`，是从旧机器复制而来的过时内容，实际路径为 `/4t/usr/chenjw`**。第 11 章的 REST API 清单可作参考。
3. `/4t/usr/chenjw/.bashrc:154-231` —— 现有 `proxy_on` / `proxy_off` / `proxy_status` / `proxy_use` 四个函数的实现。
4. `/4t/usr/chenjw/.config/mihomo/config.yaml` —— 当前生效配置，迁移脚本的输入。
5. mihomo 官方文档 <https://wiki.metacubex.one/>，`proxy-providers` 与 API 章节。

## 12. 后续事项（本项目范围外）

1. **修复 `dns.enable: false`**：属中风险变更，影响全局解析行为，需单独评估后执行。
2. **更换失效订阅**：当前节点存活率仅 10%（50 个中 5 个），架构改造完成后仍需一份可用订阅才能恢复正常使用。
3. **可选的 Web 面板**：若后续希望在浏览器里操作，zashboard v3.19.0 是纯静态面板，配 `external-ui` 即可，通过 SSH 端口转发访问，与本项目不冲突。

