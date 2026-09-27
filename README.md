# mihomo-tui

[mihomo](https://wiki.metacubex.one/)（Clash.Meta）内核的 CLI + TUI 管理工具：
切节点、管订阅、编辑规则、看实时日志与连接，全部通过本机 External Controller 的
REST API 完成，运行时不覆盖你手写的 `config.yaml`。适合在本机长期跑 mihomo、
希望订阅更新不冲掉自定义配置的用户。

- **项目状态**：v0.5.0-rc.0 已发布（[GitHub Releases](https://github.com/MrChen-hero/mihomo-tui/releases) 与 [npm](https://www.npmjs.com/package/@morndream/mihomo-tui)），处于发布候选阶段
- **CI**：[![CI](https://github.com/MrChen-hero/mihomo-tui/actions/workflows/ci.yml/badge.svg)](https://github.com/MrChen-hero/mihomo-tui/actions/workflows/ci.yml)
- **许可证**：[MIT](LICENSE)
- **技术栈**：TypeScript 5.9（strict）、React 19 + Ink 7（终端 UI）、commander 15、vitest 5、Node.js ≥ 22、Bun 1.4（单二进制交叉编译）

## 页面预览

以下截图均由本地假内核返回虚构数据生成，不含任何真实节点或订阅信息。

| 预览 | 说明 |
| --- | --- |
| ![节点页：左侧代理组列表，右侧节点延迟五档显示](docs/assets/tui-proxies.png) | **节点页**——左栏代理组、右栏节点，延迟按阈值分档，严格区分「未测试」（`---`）与「超时」 |
| ![订阅页：订阅列表含节点数、流量进度条与到期时间](docs/assets/tui-subscriptions.png) | **订阅页**——节点数 / 已用流量 / 到期时间 / 更新时间，支持增删改与一键更新 |
| ![规则页：生效规则列表与规则集](docs/assets/tui-rules.png) | **规则页**——生效规则与 rule-providers，支持类型筛选、关键词过滤与保守命中测试 |

## 核心功能

- **双入口**：TUI 覆盖日常操作；CLI 面向脚本与管道，全命令支持 `--json` 供 `jq` 消费。
- **节点管理**：切换代理组与节点、单节点与整组延迟测试、按延迟或配置顺序排序、只看可用节点；url-test / fallback 组的钉选解除由 CLI 提供。
- **订阅管理**：在 TUI 内直接新增、删除、编辑订阅，查看节点数 / 流量 / 到期时间，单个或全部更新，健康检查；订阅更新走 API，内核不重启、连接不断。
- **规则管理**：查看生效规则与规则集，按类型 / 关键字筛选，保守测试域名与 IP 命中，运行时临时禁用（配置重载后可能恢复）；内置规则编辑器可直接修改本地 `config.yaml` 的规则段（保留原 YAML 注释，保存前独立校验 + 备份）。
- **实时监控**：WebSocket 日志流（级别切换、关键字过滤）、连接流（排序、关闭单个或全部）、底部状态栏常驻显示内核版本 / 模式 / 速率 / 累计流量 / 内存。
- **模式切换**：规则 / 全局 / 直连一键循环，配置热重载不重启内核。

### 它解决什么问题

传统「整份订阅覆盖 `config.yaml`」的用法有几个痛点，本项目用
「骨架配置 + proxy-providers + API 操作层」一并解决：

| 痛点 | 解决方式 |
| --- | --- |
| 订阅一更新，手工改的端口 / DNS / 规则全部丢失 | 订阅只作为 provider 数据源，骨架配置永不触碰 |
| 多份订阅互斥，无法混用不同机场的节点 | 多 provider 同时挂载，节点可混在同一个组里 |
| 切换或更新订阅要重启内核，掐断所有连接 | 更新订阅走 API（`PUT /providers/proxies/{name}`），内核不重启 |
| 看不到订阅流量与到期时间 | 自动解析 `Subscription-Userinfo` 响应头 |

### 配置架构：骨架 + Provider

推荐的 mihomo 配置为两层结构，订阅更新不再覆盖任何自定义内容：

```txt
config.yaml（骨架，只维护一次）
├── 通用设置 / sniffer / dns / rules / rule-providers
├── proxy-providers:          ← 订阅作为节点来源
│   ├── alpha → ./providers/alpha.yaml
│   └── beta  → ./providers/beta.yaml
└── proxy-groups:
    ├── PROXY / AUTO / FALLBACK
    ├── 区域组：香港 / 台湾 / 日本 / 美国 …
    └── 用途组：AI / 流媒体 …
```

> **关键约束**：provider 的 `path` 必须是相对路径——mihomo 对此有路径安全校验，
> 配置文件之外的绝对路径会被拒绝启动。

## 数据、隐私与安全

- **数据全部在本机**，没有后端、账号体系、云同步或遥测。程序涉及的位置：

  | 位置 | 内容 |
  | --- | --- |
  | `~/.config/mihomo-tui/config.json` | 程序自身配置（内核 API 地址、测速参数等），首次运行自动生成 |
  | `~/.config/mihomo-tui/subscriptions.json` | 订阅清单，权限 `600`，**含订阅 token** |
  | mihomo 目录（默认 `~/.config/mihomo`） | `config.yaml`、provider 缓存与 `config.yaml.bak.*` 备份（保留 7 天） |

- **联网行为**仅限四类：连接本机 External Controller（REST + WebSocket）；拉取你配置的订阅 URL 与规则集 URL；设置页查询内核新版本时访问 `api.github.com` 并从 [MetaCubeX/mihomo Releases](https://github.com/MetaCubeX/mihomo/releases) 下载（可选走 `gh-proxy.com` 镜像，偏好可在设置页调整）；延迟测试访问你配置的测速地址（默认 `https://www.gstatic.com/generate_204`）。
- **订阅 token 保护**：token 只落在本机上述两个文件；所有 TUI / CLI 展示、日志与错误信息统一经 `redactUrl` 脱敏为 `<REDACTED>`。
- **写配置的安全机制**：所有写 `config.yaml` 的路径（订阅事务、规则编辑器、迁移脚本）强制走「备份 → 独立目录 `mihomo -t` 校验 → 原子写入 → 写后复验 → 失败自动回滚」；测试套件全局禁止写入真实配置目录。
- **二进制校验**：每个 Release 附 `checksums.txt`（SHA256），下载后建议执行 `sha256sum -c checksums.txt`；macOS 首次运行如被 Gatekeeper 拦截，执行 `xattr -d com.apple.quarantine mihomo-tui-*`。

## 本地运行

环境要求：**Node.js ≥ 22**（依赖内置 `fetch` 与全局 `WebSocket`，不引入 ws / undici / axios）；
一个正在运行且配置了 `external-controller` 的 mihomo 内核。

```bash
git clone https://github.com/MrChen-hero/mihomo-tui.git
cd mihomo-tui
npm install          # 仓库不提交 lockfile，故不用 npm ci
```

| 命令 | 作用 |
| --- | --- |
| `npm run dev -- status` | tsx 直跑源码，免编译 |
| `npm run typecheck` | `tsc --noEmit` 类型检查 |
| `npm test` | vitest 全量测试 |
| `npm run coverage` | 覆盖率报告 |
| `npm run build` | 编译到 `dist/` |
| `npm run bundle` | 本平台单二进制（`bundle:all` 为五平台全集，需 bun） |

## 安装与分发

**方式一：npm 全局安装（需 Node.js ≥ 22）**

```bash
npm install -g @morndream/mihomo-tui@latest
```

**方式二：单二进制（免 Node.js）**

从 [GitHub Releases](https://github.com/MrChen-hero/mihomo-tui/releases) 下载对应平台产物，并用同目录 `checksums.txt` 校验：

| 平台 | 产物 |
| --- | --- |
| Linux x64 / arm64 | `mihomo-tui-*-linux-x64` / `mihomo-tui-*-linux-arm64` |
| macOS x64（Intel）/ arm64（Apple Silicon） | `mihomo-tui-*-darwin-x64` / `mihomo-tui-*-darwin-arm64` |
| Windows x64 | `mihomo-tui-*-windows-x64.exe` |

```bash
sha256sum -c checksums.txt
chmod +x mihomo-tui-*-linux-x64
```

**方式三：源码安装**

```bash
git clone https://github.com/MrChen-hero/mihomo-tui.git
cd mihomo-tui && npm install && npm run build
```

之后即可执行 `mihomo-tui`（npm 与源码方式）或直接运行下载的二进制。

**发布机制**：推送 `v*` tag 触发 [.github/workflows/release.yml](.github/workflows/release.yml)，
自动完成五平台交叉编译、三平台冒烟、GitHub Release 附加产物与 npm 发布；`-rc` 后缀的
tag 自动标记为预发布并发布到 npm 的 `next` dist-tag。项目未提供 Docker 或云平台部署配置。

## 第一次使用

1. **确认内核可达**：`mihomo-tui status` 打印内核版本、模式、端口与 provider 概览。
   连不上时检查 mihomo 是否在运行、`external-controller` 地址是否正确（默认
   `http://127.0.0.1:19090`，含 secret 时用 `--secret` 或写进 `config.json`）。
2. **检查程序配置**：`~/.config/mihomo-tui/config.json` 首次运行自动生成，字段含义：

   | 字段 | 说明 |
   | --- | --- |
   | `api` | mihomo External Controller 地址 |
   | `secret` | 控制口密钥，与 `external-controller` 的 `secret` 一致 |
   | `mihomoDir` | mihomo 配置目录（订阅事务与规则编辑器写 `config.yaml` 的位置） |
   | `testUrl` / `testTimeout` | 延迟测试地址与超时（毫秒） |
   | `delayThresholds` | 正常 / 一般 / 缓慢三档延迟阈值 |

3. **接入订阅**：进入 TUI（直接运行 `mihomo-tui`），在 **订阅页** 按 `a` 新增订阅
   （名称 / URL / 节点名前缀）。已有「整份订阅」旧配置的用户可改用迁移脚本一次性改造为
   骨架 + Provider 架构：`node scripts/migrate-config.mjs --dry-run --diff` 预览（不落盘），
   确认后 `--apply` 写入（自动备份、校验、失败回滚、幂等）。
4. **日常操作**：数字键 `1`–`6` 切页，`Tab` 循环，`ESC` 逐层返回；节点页 `Enter` 选用
   节点、`t` 测速；订阅页 `u` 更新当前订阅、`U` 全部更新；`M` 切换规则 / 全局 / 直连。
   配合 shell 集成可以管理系统代理环境变量：

   ```bash
   echo 'eval "$(mihomo-tui proxy init)"' >> ~/.bashrc && source ~/.bashrc
   proxy on        # 本 shell 开启系统代理（自动发现内核混合端口）
   proxy off       # 关闭
   proxy status    # 查看内核端口与本 shell 代理状态
   ```

   原理：`proxy on` 由 CLI 输出 shell 代码、父 shell `eval` 执行（子进程改不了父 shell
   的环境变量）；不装集成也可直接 `eval "$(mihomo-tui proxy on)"`。
5. **备份**：配置变更自动生成 `config.yaml.bak.<时间戳>`（保留 7 天）；迁移到新设备时，
   拷贝 `~/.config/mihomo-tui/`（程序配置 + 订阅清单）与 mihomo 目录（`config.yaml`
   及 providers 缓存）即可完整复原。
6. **需要注意的操作**：新增 / 删除订阅会重启一次 mihomo 服务（秒级断流，更新不断流）；
   删除订阅、关闭全部连接、保存规则编辑均有确认框或撤销机制，其中规则编辑保存期间
   不可中断（事务保护）；运行时改动（切节点、切模式）重启内核后丢失，需持久化的变更
   写入 `config.yaml` 后执行 `mihomo-tui reload`。

### CLI 速查

```bash
mihomo-tui status                        # 内核版本、模式、端口、provider 概览
mihomo-tui proxy ls [组名]               # 代理组与节点、延迟、状态
mihomo-tui proxy use <组> <节点>         # 切换节点（url-test 组会钉选并提示）
mihomo-tui proxy unfix <组>              # 解除 url-test/fallback 组的钉选
mihomo-tui proxy test 香港 -t 5000       # 整组延迟测试，可自定义测速地址与超时
mihomo-tui provider ls                   # 订阅列表（节点数/流量/到期/更新时间）
mihomo-tui provider update [名称]        # 更新订阅，省略名称则全部
mihomo-tui rules ls --type DOMAIN-SUFFIX --json
mihomo-tui rules test example.com --json # hit / miss / unsupported
mihomo-tui rule-provider ls --json
mihomo-tui logs -f                       # 实时日志跟随，Ctrl+C 退出
mihomo-tui conn ls -s traffic -n 50      # 连接列表，按流量排序
mihomo-tui conn close <id|--all>         # 关闭连接（id 支持 8 位前缀）
mihomo-tui reload                        # 热重载配置（内核不重启）
```

组名含中文与 emoji 直接传入即可（内部 `encodeURIComponent`），如
`mihomo-tui proxy ls '香港聚合'`。退出码约定：`0` 成功、`1` 通用错误、`2` 参数错误、
`3` 内核不可达。

## 项目结构

```txt
src/
├── api/          # REST 客户端 + WebSocket 流封装
├── commands/     # CLI 子命令（status / proxy / provider / rules / conn / logs …）
├── config/       # 订阅清单、配置事务（ConfigManager 唯一写配置入口）、规则编辑服务
├── rules/        # 规则类型转换、保守匹配与运行时禁用确认
├── kernel/       # 内核版本查询、下载与安装（含镜像源）
├── views/        # TUI 六个标签页
├── components/   # 对话框、列表、延迟徽章、状态栏等复用组件
├── hooks/        # useProxies / useProviders / useStream
├── ui/           # 主题（唯一取色处）、布局、按键捕获与退出保护
├── App.tsx       # TUI 根组件
├── cli.tsx       # CLI / TUI 路由
└── version.ts    # 版本号来源链（编译期注入 → 环境变量 → package.json）
bin/mihomo-tui    # 可执行胶水：优先 dist/cli.js，未编译时回退 tsx
scripts/          # 迁移、冒烟与打包脚本
docs/             # 设计规格、路线图与开发文档
```

## 开发、测试与贡献

提交前请执行：

```bash
npm run typecheck
npm test
npm run build
```

- **需要补测试的变更**：`src/config/` 下的写路径（订阅事务、规则编辑）、CLI 输出契约
  （stdout 纯净性、退出码、`--json` 结构）与新 TUI 交互（无头渲染 + 按键注入）。
  测试一律使用假内核与 `HOME` 重定向，绝不触碰真实 `~/.config/mihomo{,-tui}`。
- **不应提交**：真实订阅数据与 token、`config.yaml.bak.*` 备份、`coverage/`、`dist/`、
  `dist-bin/`——`.gitignore` 已覆盖，请勿绕过。
- **设计红线**（详见 [CONTRIBUTING.md](CONTRIBUTING.md)）：运行时代码不写 `config.yaml`
  （写入能力仅限配置事务与迁移脚本）、不新增监听端口、任何输出不得泄露订阅 token。
- **安全问题**：暂无 SECURITY.md，请提交 Issue 并在标题注明 `security`，描述中不要
  附真实 token 或订阅地址。

## 边界与说明

- Windows 仅提供 x64 二进制；macOS 同时提供 x64 与 arm64；Linux 提供 x64 与 arm64。
- Node.js 全局 `WebSocket` 在 v22.4 起脱离实验状态，更早的小版本（22.0–22.3）未验证。
- systemd 相关检查仅适用于 Linux `--user` 服务；其他部署方式不影响核心功能。
- 不支持 SSH 隧道、容器路径映射等非本机回环场景；规则编辑保存要求控制器确实读取
  所显示的本机路径。
- TUI 内运行时操作（切节点、切模式、临时禁用规则）重启内核后不保留，需持久化的变更走
  订阅事务、规则编辑器或 `config.yaml` + `mihomo-tui reload`。
- 规则编辑器不支持写入锚点、别名与顶层合并来源；订阅直连规则受保护，清单异常时禁止写入。
- 保守规则测试遇到 `GEOIP`、`RULE-SET`、进程规则或需 DNS 判定的规则会明确提示
  「需内核判定」；命中结果只表示规则目标，不代表最终节点或真实流量路径。
- mihomo 内核不回应 WebSocket close 帧，用过日志 / 连接流的命令路径都显式退出，
  非跟随模式的 `logs` 有空闲超时兜底。
- 延迟测试全部超时通常是测速地址本身不可达，可在 `config.json` 更换 `testUrl`；
  AI 服务商不可用多为节点 IP 被封锁，属节点问题而非配置问题。

## 许可证

[MIT](LICENSE)
