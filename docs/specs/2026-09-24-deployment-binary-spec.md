# mihomo-tui v0.5.0「部署与分发优化」Level 2 Concise Spec

- **日期**：2026-09-24
- **目标版本**：v0.5.0
- **上游依据**：`docs/ROADMAP.md` §v0.5.0、`docs/DEVELOPMENT.md`、`package.json`、`bin/mihomo-tui`、`.github/workflows/ci.yml`
- **状态**：草稿（待评审）
- **修订**：2026-09-27 增补 §6「Shell 代理开关集成」（`proxy on/off/status/init`），Checkpoint、测试、风险与验证方案同步扩充
- **修订 2**：2026-09-27 将「npm registry 发布」从非目标移入范围——scoped 包 `@morndream/mihomo-tui`（裸名已被抢注）、package.json 发布化改造与 release.yml publish job（§7.3、§9）

---

## 1. 背景与目标

当前 `mihomo-tui` 仅通过 `npm install -g` + `bin/mihomo-tui` 胶水脚本分发，运行依赖：

- Node.js ≥ 22
- `dist/`（`tsc` 产物）+ 所有 `node_modules`

这对没有 Node.js 环境的服务器、嵌入式 Linux、镜像最小化容器并不友好。

**术语说明**：

| 术语 | 中文全称 | 通俗解释 |
| --- | --- | --- |
| 运行时编译打包（runtime-embedded bundling） | 把「JavaScript 运行时 + 业务代码」打成单个原生可执行文件 | 用户拿到的不是 `.js` 文件，而是一个可以直接 `./mihomo-tui` 跑起来的 ELF/PE/Mach-O 文件，不依赖系统是否装过 Node.js |
| `bun build --compile` | Bun 官方提供的单二进制打包命令 | 把 JS 字节码嵌进 Bun 运行时，输出单个 .exe/ELF |
| `deno compile` | Deno 官方提供的单二进制打包命令 | 类似 Bun，但用 Deno 的沙箱运行时 |
| artifact | CI 构建产物 | GitHub Actions 每次跑出来的下载文件 |
| checksum | 校验和（本 spec 用 SHA256） | 用于验证下载文件没坏/没被篡改 |
| smoke test | 冒烟测试 | 只验证程序能启动、能 `--help`，不深测业务逻辑 |
| emit-eval 模式 | CLI 把 shell 代码打印到 stdout、由父 shell `eval` 执行 | 子进程无法修改父 shell 的环境变量，「开关」动作只能由 CLI 算好、shell 侧执行 |

**本次 v0.5.0 目标**：

1. 决策 Bun vs Deno 打包方案
2. 产出五平台单二进制：Linux x86_64 / aarch64、macOS x86_64 / arm64、Windows x86_64
3. 提供 `scripts/build-binary.mjs` 本地打包入口
4. 新增 GitHub Actions `release.yml`，push `v*` tag 时自动出产物并挂到 GitHub Release
5. 保持现有 `tsc` + `bin/mihomo-tui` Node 分发路径不变（**双轨分发**）
6. 内置 shell 代理开关 `proxy on / off / status / init`：把作者 bashrc 私有的 `proxy-on` / `proxy-off` / `proxy-tui` 收纳为安装即用的正式能力（详见 §6）
7. npm registry 正式发布（scoped 包 `@morndream/mihomo-tui`），与 GitHub Release 二进制构成双发布通道；`npm install -g @morndream/mihomo-tui@latest` 安装即用（详见 §7.3）

---

## 2. 范围与非目标

### 2.1 范围内

- `scripts/build-binary.mjs` 本地构建脚本（`--target` / `--out-dir` 参数）
- CI 工作流 `.github/workflows/release.yml`
- 版本号统一从 `package.json` 读取（现有 `src/cli.tsx` 已如此）
- 产物 SHA256 checksums (`checksums.txt`)
- **Shell 代理开关**：`proxy on|off|status` 子命令（emit-eval 模式，详见 §6）与 `proxy init` shell 集成输出（`proxy`、`proxy on/off/status` 及 `proxy-on/proxy-off/proxy-tui` 兼容别名）
- **npm 发布化改造**：`package.json` 移除 `private`、新增 `files` 白名单与 `prepublishOnly` 门禁、定稿 scoped 包名 `@morndream/mihomo-tui`（详见 §7.3）
- **release.yml 增加 publish job**：与二进制产物同 tag 触发，`NPM_TOKEN`（granular）+ `--access public`
- **git 直装过渡**：`prepare` 构建脚本，使 `npm install -g github:MrChen-hero/mihomo-tui#main` 在 registry 发布前即可用
- 安装说明（README 增附录，含 shell 集成一行安装；不单独写安装脚本——本版本不提供 `install.sh`）
- 冒烟测试：CI 中跑 `./<binary> --help` 和 `./<binary> status --json`（无 mihomo 环境，期望友好错误退出码 3）

### 2.2 非目标（Not Goals）

- **GUI 安装器**：不做 MSI / DMG / Debian 包 / RPM
- **auto-update**：二进制不会自更新，升级 = 用户手动下载新版本
- **代码签名 / notarize**：macOS Gatekeeper 提示由用户自行处理（`xattr -d com.apple.quarantine`）
- **NPM registry 发布**：原列为非目标，修订 2 已移入范围（见 §7.3）——仅 codex 式 platform-packages 仍属非目标
- **跨架构交叉编译产物的大量调优**（如精简 Bun runtime）：允许单文件 60–100 MB
- **替用户管理 mihomo 内核**：仍假设外部启动 mihomo
- **改写用户 rc 文件**：安装 = 用户自行追加一行 `eval "$(mihomo-tui proxy init)"`，工具绝不静默写 `~/.bashrc`
- **单工具专属代理**（git/npm/apt 的 config 级代理）：env-only 边界，不做
- **npm platform-packages**（codex 式 `optionalDependencies` 平台二进制壳）：本版 npm 包为纯 JS（`dist/` 直跑），不做；待单二进制落地后按 §17 开放问题 4 评估
- **fish / PowerShell 集成**：`init` 预留 `--shell` 参数，首版仅 POSIX sh（bash/zsh 同一输出）

---

## 3. 方案对比与决策

### 3.1 候选方案对比表

| 方案 | 跨平台 cross-compile | Ink 7 / React 19 兼容 | 产物大小 | Node API 兼容 | 维护活跃度 | 总评 |
| --- | --- | --- | --- | --- | --- | --- |
| **Bun `bun build --compile`** | ✅ 官方支持 `--target=bun-linux-x64` 等 5 平台 | ⚠️ 历史有问题，2024Q4 起大幅改善（**已实测通过，见 §4.1**） | ~55–80 MB（实测 80MB） | ✅ 高度兼容 Node API | 🟢 高（周更） | **推荐** |
| **`deno compile`** | ✅ 5 平台 | ⚠️ Ink JSX + `--unstable-*` 多个 flag 才跑得动；`npm:ink` 需 node specifiers 全开（**需验证**） | ~90–120 MB | ⚠️ 通过 `npm:` specifier，部分 Node API 仍 stub | 🟢 高 | 备选 |
| **`pkg` (Vercel)** | ❌ 不支持 Node 22 | — | — | — | 🔴 已停止维护 | 排除 |
| **`nexe`** | ⚠️ 需自备 Node 源码编译 | 社区稀缺用例 | ~40 MB | ✅ | 🔴 低 | 排除 |
| **esbuild-only + 运行时依赖** | 没有 embedded 运行时 | 不能去 Node 依赖 | — | — | — | 不符合目标 |

### 3.2 决策

**主推 Bun，Deno 兜底，pkg/nexe 排除**。

**理由**：
1. `bun build --compile` 支持所有 5 个目标平台的 **纯交叉打包**（在 Linux x86_64 runner 上一次性产出 mac/win/arm 全部产物），大幅简化 CI；Deno 需要在每个原生平台单独跑。
2. Bun 对 Node API（`fs`、`path`、`child_process`、`readline`、`process.stdout.isTTY`、`Buffer`）的兼容覆盖比 Deno.npm: 更稳，本项目重度依赖 TTY/Raw mode 与 `spawnSync`。
3. 产物体积 Bun 优于 Deno 约 25–40%。
4. Bun 是目前 Ink 社区（含官方 examples）事实上的首选运行时。

**兜底策略**：若 CI 验证排查出 Bun 某个 blocker（如 Ink 7 在 Bun 上的 raw mode rendering bug 未修复），允许切到 `deno compile`，对应 CI 把 matrix 改成按目标 OS 原生构建。**两条代码路径在 `scripts/build-binary.mjs` 内以策略函数并存，不为二者写两套 CI**。

---

## 4. 兼容性评估矩阵

> 「已知问题」指社区/官方 issue 已被公开记录；「需验证点」是本项目 CI 必须先跑通的实测项。

| 依赖 | Bun（现状判断 2026-09） | Deno | 风险级别 |
| --- | --- | --- | --- |
| `react@19.2` | ✅ 纯 JS，无 Node API 依赖 | ✅ | 低 |
| `ink@7` | ⚠️ Raw mode + `process.stdout.columns/rows` 历史上有差异，2024Q4 起 Bun 1.1+ 已相对稳定；**需验证**：`alternateScreen` 行为、Ctrl+C 信号路径 | ⚠️ 通过 `npm:ink` 能跑但需 `--unstable-raw-mode` 等 flag，且 JSX/ESM 解析需配套 deno.json 配置；**需验证** | **中-高** |
| `@inkjs/ui@2` | 依赖 ink，理论上同 ink | 同 ink | 中 |
| `commander@15` | ✅ 纯 JS，无 Node 专属 API | ✅ | 低 |
| `yaml@2.9` | ✅ 纯 JS | ✅ | 低 |
| `vitest`（仅 dev） | 不进入运行时产物，无影响 | 同 | N/A |
| **Node 内置 `child_process.spawnSync`**（`bin/mihomo-tui` 用） | ✅ Bun 完整实现 | ✅ | 低 |
| **`process.stdout.isTTY`、`readline.emitKeypressEvents`** | ⚠️ 历史 issue 密集，**需验证** | ⚠️ | **高** |
| **WebSocket 客户端**（`runLogs` 使用） | ✅ Bun 原生 | ✅ Deno 原生 | 低 |
| **`fetch`（API 调用层）** | ✅ | ✅ | 低 |
| **`import.meta.url` + `readFileSync(package.json)`** | ⚠️ `--compile` 后 `import.meta.url` 指向虚拟路径，**需改造**：版本号改为构建期编译进常量（见 §5） | 同 | **中** |

**关键需验证点列表**（写入 Execution Checkpoints 1）：

- V1：Ink `render(..., { alternateScreen: true })` 在 Bun 单二进制下能正常进入/退出备用屏幕
- V2：Ctrl+C 触发 `waitUntilExit` resolve 与 `exitAfterFlush` 流程
- V3：`WebSocket` 连接 mihomo 日志流不卡死
- V4：`fetch` 在二进制内无成对的 TLS / DNS 限制
- V5：`readFileSync(new URL('../package.json', import.meta.url))` 在编译产物里不可用 → **必须改造为 build-time 常量注入**

### 4.1 Spike 实测结论（2026-09-27，bun 1.4.2，内核 v1.19.24 实测环境）

**结论：Bun 路径可行，V1–V5 全部通过，产物 80MB（符合 60–100MB 预期）。** 版本锁定 `bun@1.4.2`。

| 验证点 | 结果 | 证据 |
| --- | --- | --- |
| V1 alternateScreen | ✅ | pty 驱动编译产物：`1049h` 进入 / `1049l` 恢复，TUI 渲染正常 |
| V2 Ctrl+C 退出路径 | ✅ | Ctrl+C 与 ESC→Enter 两路径均 `exit=0` 干净退出（注意：bun 进程收尾与 pty EIO 间有毫秒级竞态，CI 的 waitpid 需轮询收割，非用户可见问题） |
| V3 WebSocket | ✅ | `logs` 流对真内核 5 秒稳定存活无崩溃 |
| V4 fetch | ✅ | `status --json` 对真内核 GET /configs 正常返回 |
| V5 版本注入 | ✅ | `--define globalThis.__MIHOMO_TUI_VERSION__` 生效，`--version` 输出与 package.json 一致；虚拟路径读盘被兜底链优雅处理 |

**构建期发现（三条，均已解决）**：

1. **ink 的 DEV 分支引用 `react-devtools-core`**（npm 生产安装不含此包）。`--external` 无效（编译产物运行时解析失败）；`--define process.env.DEV` 也无效（动态 import 仍进模块图）。**解法：构建期在 node_modules 写入空实现 stub 包让裸 specifier 解析落地**（编译产物永不进 DEV 模式；stub 由 Checkpoint 4 的 `scripts/build-binary.mjs` 幂等生成，npm ci 自动清除）。
2. **`--target bun` 必须显式指定**：缺省按 browser 目标解析，连 `require('module')` 都拒绝。
3. **代码库大小写碰撞**：`src/components/textEditor.ts`（逻辑）与 `TextEditor.tsx`（视图）仅大小写之差，bun 的解析器会把两者错配（tsc/tsx 无此问题）；这同时也是 macOS 大小写不敏感文件系统上的 checkout 隐患。已将逻辑文件改名 `textEditorModel.ts`。

---

## 5. 版本号注入改造（前置必做）

`src/cli.tsx` 当前从 `../package.json` 运行时读版本。`--compile` 产物中无法访问源码树，必须改为：

```ts
// src/version.ts （新增）
declare global { var __MIHOMO_TUI_VERSION__: string | undefined }
export const VERSION: string =
  globalThis.__MIHOMO_TUI_VERSION__ ?? '0.0.0-dev'
```

- 本地 `tsc` 路径：由 `bin/mihomo-tui` 在加载 `dist/cli.js` 前注入 `globalThis.__MIHOMO_TUI_VERSION__ = pkg.version`
- 二进制构建路径：`bun build --define globalThis.__MIHOMO_TUI_VERSION__='\"'\"${VERSION}\"'\"'`

`src/cli.tsx` 改为 `import { VERSION } from './version.js'`，不再 `readFileSync(package.json)`。

---

## 6. Shell 代理开关集成（proxy on / off / status / init）

### 6.1 背景与本质约束

作者自用的 `proxy-tui` / `proxy-on` / `proxy-off` 定义在私有 bashrc 中，开源用户拿不到。本版将其收纳为正式能力，但有一个不可绕过的约束：

> **CLI 子进程无法修改父 shell 的环境变量。** 所以 `proxy on` 不能一条命令直接生效，必须走 emit-eval 模式：CLI 完成全部判断（内核可达性、端口发现、变量集合计算），把一段 shell 代码打印到 stdout，由父 shell `eval` 执行。

**stdout 纯净契约**：`on`/`off` 成功时 stdout 只能是 shell 代码，诊断与提示一律走 stderr；失败时 stdout 必须为空（`eval "$(…)"` 退化为安全空操作）并返回非零退出码。

**二进制名决策**：保持 `mihomo-tui`，不缩写成 `mihomo`——与内核二进制同名必然冲突（本工具还要下载、校验并调用 `mihomo -t`）。「短」的诉求由 `proxy init` 输出的 shell 函数承担：日常只敲 `proxy on`。

### 6.2 CLI 命令设计

并入既有 `proxy` 命令组（`ls/use/unfix/test` 不动）；帮助文本明确区分 `on/off`（系统代理环境变量）与 `use`（内核选节点）：

| 命令 | 行为 | 退出码 |
| --- | --- | --- |
| `mihomo-tui proxy on` | 校验内核可达 → stdout 输出 `export` 代码段；内核不可达时 stdout 为空、stderr 给指引 | 0 / 3 |
| `mihomo-tui proxy off` | stdout 输出 `unset` 代码段；**不访问内核**，离线永远成功 | 0 |
| `mihomo-tui proxy status [--json]` | 内核状态、混合端口及其来源、当前 shell 是否已开启（探针变量）与端口一致性 | 0 |
| `mihomo-tui proxy init` | 输出 shell 集成函数定义（POSIX sh，bash/zsh 通吃；`--shell` 预留） | 0 |

`on` 的选项：`--port <n>` 显式覆盖端口、`--lan` 在 `no_proxy` 追加私有网段、`--all` 追加 `all_proxy`、`--start` 内核离线时先经 `ServiceManager` 拉起 systemd user 服务（默认关闭）。

TTY 行为：stdout 连接终端时照常输出代码，并在 stderr 提示「请 eval 执行，或先装集成：`eval "$(mihomo-tui proxy init)"`」；stdout 为管道时不打印提示（脚本场景保持纯净）。

### 6.3 `proxy init` 输出与安装

```sh
# mihomo-tui shell integration（proxy init 输出）
proxy() {
  case "${1:-tui}" in
    on)     shift; eval "$(command mihomo-tui proxy on)";;
    off)    shift; eval "$(command mihomo-tui proxy off)";;
    status) shift; command mihomo-tui proxy status "$@";;
    tui)    shift; command mihomo-tui "$@";;
    *)      command mihomo-tui "$@";;
  esac
}
proxy-on()  { proxy on "$@"; }
proxy-off() { proxy off "$@"; }
proxy-tui() { proxy tui "$@"; }
```

安装即用 = README 快速开始的一行（对 npm 与二进制分发是同一条路，无需探测安装路径）：

```sh
echo 'eval "$(mihomo-tui proxy init)"' >> ~/.bashrc
```

### 6.4 `on` 的输出与端口发现

```
export http_proxy='http://127.0.0.1:<port>'
export https_proxy='http://127.0.0.1:<port>'
export no_proxy='localhost,127.0.0.1,::1'
export MIHOMO_PROXY_ENV='<port>'
```

- **端口发现链**：`--port` 覆盖 → `GET /configs` 的 `mixed-port`（运行时真相）→ 只读读取 config.yaml 的 `mixed-port`（兜底）→ 双双失败报错退出，**绝不硬编码 7890**。
- **`MIHOMO_PROXY_ENV` 探针变量**：`status` 靠它识别「本 shell 已开启」并检测端口漂移（内核换端口后提示重新 `proxy-on`）；重复 eval 幂等，不叠加脏变量。
- **`no_proxy` 默认最小集**：CIDR 写法在旧版 curl/wget 中不被识别，故私有网段由 `--lan` 显式追加；`all_proxy` 默认不设（部分工具按 socks 语义解释产生歧义），由 `--all` 选配。
- 变量集合为共享常量：**`off` unset 的全集 = `on` set 的全集（含 `all_proxy` 与探针）**，改一处两处同步，且不触碰集合之外的用户变量。

### 6.5 实现落点

- 新文件 `src/commands/proxyEnv.ts`：emit 模板、端口发现、变量清单常量、`init` 文本（纯函数可测），在 `src/cli.tsx` 的 `proxy` 组注册
- 端口读取复用现有只读路径（API 客户端 / 配置读取），不新开写盘路径

---

## 7. 总体架构

### 7.1 构建流水线

```
┌─────────────┐   ┌─────────┐   ┌──────────────────────┐   ┌──────────────────┐
│ package.json│──▶│  tsc    │──▶│ scripts/             │──▶│ dist-bin/<os>-   │
│ version     │   │ dist/   │   │ build-binary.mjs     │   │ <arch>/mihomo-tui│
└─────────────┘   └─────────┘   │  (调用 bun build     │   └──────────────────┘
                                │   --compile)         │
                                └──────────────────────┘
```

**说明**：
1. 先用 `tsc` 产出 `dist/`（独立、照常发 npm 用）
2. `scripts/build-binary.mjs` 以 `src/cli.tsx` 为 entry（而非 `dist/cli.js`），让 Bun 自己处理 TSX＋bundle，避免 tsc 与 bundler 二次转换引入的不一致。**deno 兜底路径同样直吃 `src/cli.tsx`**。
3. `--define globalThis.__MIHOMO_TUI_VERSION__="<version>"` 注入版本号
4. 产物命名为 `mihomo-tui-<version>-<os>-<arch>[.exe]`

### 7.2 `scripts/build-binary.mjs` 接口

```
node scripts/build-binary.mjs \
  --target linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64 | windows-x64 | all \
  --out-dir dist-bin \
  [--runtime bun|deno]            # 默认 bun
```

**输入**：
- `--target`：5 个枚举之一，或 `all` 串行构建全部
- `--out-dir`：默认 `dist-bin`
- `--runtime`：默认 `bun`；`deno` 为兜底切换项
- 环境变量 `MIHOMO_TUI_VERSION`（可选）：覆盖版本号，默认从 `package.json` 读

**输出**：
- `<out-dir>/mihomo-tui-<version>-linux-x64`
- `<out-dir>/mihomo-tui-<version>-linux-arm64`
- `<out-dir>/mihomo-tui-<version>-darwin-x64`
- `<out-dir>/mihomo-tui-<version>-darwin-arm64`
- `<out-dir>/mihomo-tui-<version>-windows-x64.exe`
- `<out-dir>/checksums.txt`（sha256，格式参考 GNU coreutils：`SHA256 2 spaces filename`）

**错误处理**：任一目标失败即非零退出；`all` 模式失败的目标在末尾汇总打印。

### 7.3 npm 包发布化改造

```json
{
  "name": "@morndream/mihomo-tui",
  "files": ["dist", "bin", "README.md", "LICENSE", "CHANGELOG.md"],
  "prepublishOnly": "npm run typecheck && npm test && npm run build",
  "prepare": "npm run build"
}
```

- **包名定稿**：裸名 `mihomo-tui` 已于 2026-06 被第三方抢注（alias 包），scoped 名 `@morndream/mihomo-tui` 经 registry 实测未占用、与 npm 发布账号一致（2026-09-27 定稿；scope 跟随 npm 账号 `morndream`，与 GitHub 用户名无关）；`npm install -g @morndream/mihomo-tui@latest` 等价可用
- **`files` 白名单是必须项**：只发 `dist/` + `bin/` + 文档，`node_modules` 自动排除；tsx 属 devDependency 不随全局安装，bin 胶水的 tsx 回退在用户机不可达——**`dist/` 必须随包发布**，胶水脚本命中 dist 分支
- **`prepare` 与 `prepublishOnly` 分工**：`prepare` 服务 git 直装（`npm install -g github:MrChen-hero/mihomo-tui#main`，registry 发布前的过渡通道）；`prepublishOnly` 服务 registry 发布的三重门禁（typecheck + 全量测试 + build）。注意 `prepare` 在本地 `npm install` 时也会触发一次 build——可接受，CI 中 `npm install` 顺带产出 `dist/` 与后续步骤复用（仓库不提交 package-lock.json，`npm ci` 不可用）。
- **发布纪律**：git tag（`v*`）↔ `package.json` version ↔ CHANGELOG 三者一致才允许 publish；scoped 包首发必须 `npm publish --access public`
- **与 @openai/codex 模式的差别**：codex 的 npm 包是「安装器壳」——本体 Rust 二进制经 `optionalDependencies` 按平台分发；本项目 npm 包为纯 JS（`dist/` 直跑），无需该机制，待单二进制落地后按 §17 开放问题 4 评估

---

## 8. 构建产物布局

```
dist-bin/
├── mihomo-tui-0.5.0-linux-x64
├── mihomo-tui-0.5.0-linux-arm64
├── mihomo-tui-0.5.0-darwin-x64
├── mihomo-tui-0.5.0-darwin-arm64
├── mihomo-tui-0.5.0-windows-x64.exe
└── checksums.txt
```

`checksums.txt` 示例：

```
sha256  mihomo-tui-0.5.0-linux-x64
<hex>   mihomo-tui-0.5.0-linux-arm64
...
```

实际格式使用 `sha256sum` 默认输出（`<hex>  <filename>`，两空格分隔），便于用户 `sha256sum -c checksums.txt`。

**GitHub Release attach 资源清单**：
- 上述 5 个二进制
- `checksums.txt`
- 不带 `.tar.gz` 二次打包（单文件直传，符合 KISS）

---

## 9. CI 工作流设计

**最终实现以 `.github/workflows/release.yml` 为准**。相对本节早期草案的已落地差异：`npm install`（仓库不提交 lockfile，`npm ci` 不可用）；build job 首步有 tag↔package.json version 一致性守卫（workflow_dispatch 时跳过）；`workflow_dispatch` 仅演练 build 与 smoke-matrix，release/publish 两 job 仅在 `refs/tags/v*` 触发；`NPM_TOKEN` 未配置时 publish 步骤自动跳过（链路保持绿）；预发布版本（含 `-`）走 dist-tag `next`；含 `-rc` 的 tag 标记 GitHub prerelease；smoke-matrix 增加 `sha256sum -c` 校验；actions 版本对齐 2026-09 主流（checkout@v5 / setup-node@v7 / artifact@v5 / gh-release@v3）。

新增 `.github/workflows/release.yml`（**不动 `ci.yml`**）：

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest    # Bun 单 runner 交叉出全部 5 平台
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - uses: actions/setup-node@v4
        with: { node-version: 22 }

      - run: npm ci
      - run: npm run typecheck
      - run: npm test

      - name: Build all binaries
        run: node scripts/build-binary.mjs --target all --out-dir dist-bin

      - name: Smoke linux-x64
        run: |
          ./dist-bin/mihomo-tui-*-linux-x64 --version
          ./dist-bin/mihomo-tui-*-linux-x64 --help
          set +e
          ./dist-bin/mihomo-tui-*-linux-x64 status --json
          test $? -eq 3   # 无 mihomo 内核时应走 EXIT.kernel=3

      - uses: actions/upload-artifact@v4
        with:
          name: dist-bin
          path: dist-bin/

  smoke-matrix:
    needs: build
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: macos-latest,   bin: darwin-arm64 }
          - { os: macos-13,       bin: darwin-x64 }
          - { os: windows-latest, bin: windows-x64.exe }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/download-artifact@v4
        with: { name: dist-bin }
      - name: Smoke
        shell: bash
        run: |
          chmod +x dist-bin/mihomo-tui-* || true
          dist-bin/mihomo-tui-*${{ matrix.bin.suffix }} --version

  release:
    needs: [build, smoke-matrix]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with: { name: dist-bin, path: dist-bin }
      - uses: softprops/action-gh-release@v2
        with:
          files: dist-bin/*
          generate_release_notes: true

  publish:
    needs: [build, smoke-matrix]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, registry-url: 'https://registry.npmjs.org' }
      - run: npm ci
      - run: npm run typecheck && npm test
      - run: npm run build
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**要点**：
- **不引入额外编排工具**（无 nx/turbo），原生 `strategy.matrix` + `$default` runner 三平台冒烟
- Windows runner 上 bash shell 可用（GitHub 默认集成 git-bash）
- 不签名；release notes 由 `generate_release_notes` 自动生成 + 手动补充
- **npm publish 与二进制产物同 tag 触发**（`release` 与 `publish` 并行，均依赖 build + smoke-matrix）；scoped 包必须 `--access public`；`NPM_TOKEN` 用 granular token（仅本包 publish 权限）

---

## 10. 本地开发体验

### 10.1 新增 npm scripts

```json
{
  "scripts": {
    "bundle": "node scripts/build-binary.mjs --target linux-x64",
    "bundle:all": "node scripts/build-binary.mjs --target all",
    "bundle:darwin": "node scripts/build-binary.mjs --target darwin-arm64",
    "bundle:windows": "node scripts/build-binary.mjs --target windows-x64"
  }
}
```

### 10.2 `bin/mihomo-tui` 关系

**保留不动**。双轨分发策略：

| 渠道 | 适用人群 | 入口 |
|---|---|---|
| Node ≥22 用户 | 已装 Node 的开发者 | `npm install` + `bin/mihomo-tui` |
| 无 Node 用户 | 服务器、容器、桌面终端用户 | GitHub Release 单二进制 |

两条路径共用 `src/cli.tsx`，行为一致。`bin/mihomo-tui` 新增仅一行版本注入逻辑（见 §5）。

### 10.3 文档

`README.md` 增加「安装方式」一节，分两个 Tab：Node 安装 / 二进制下载；快速开始包含 shell 集成一行（`eval "$(mihomo-tui proxy init)"`）与 `proxy on / off / status` 用法示例。

---

## 11. 测试策略

| 层级 | 工具 | 内容 |
|---|---|---|
| 单元 / 集成 | 现有 `vitest run`（CI 已跑） | 不变化 |
| 构建期 | `npm run typecheck` | 保证 TS 不回归 |
| **Shell 集成（emit-eval）** | vitest + 真实 bash 子进程 | on/off 输出行集合精确断言；内核离线时 stdout 为空且退出码 3；`init` 输出过 `bash -n`；eval 回环后 `$http_proxy` 与探针变量正确；端口发现链（API → config.yaml → 报错） |
| **npm 包内容** | `npm pack --dry-run` | 产物仅含 dist/bin/文档白名单；含 `dist/cli.js` 与 `bin/mihomo-tui`；不含 src/tests/node_modules |
| **二进制冒烟（最小）** | CI step | 1. `--version` 输出与 package.json 一致 2. `--help` 退出码 0 3. `status --json` 在无 mihomo 环境下退出码 = `EXIT.kernel`（3），并输出友好错误 |
| **二进制 TUI 交互** | 手工 | 跑一次 TUI 进入/退出（mac/linux 各一次）— 不进 CI，列入发布 checklist |
| **产物校验** | CI step | `sha256sum -c checksums.txt` 自检通过 |

不引入 e2e 框架（避免超出 v0.5.0 范围）。

---

## 12. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Ink 7 在 Bun 单二进制下 raw-mode/alternateScreen bug | 中 | 高（TUI 不可用） | **Checkpoint 1 已实测通过（2026-09-27，见 §4.1）**；残余风险为其余 4 平台交叉编译未实测；若后续阻塞切 `deno compile` |
| `--compile` 产物 `import.meta.url` 不可用 | 高 | 中 | §5 版本号注入改造已解决（§4.1 V5 实测通过） |
| Bun 版本迭代引入 regression | 中 | 中 | `oven-sh/setup-bun@v2` 锁定 `bun-version: 1.4.2` 写入 `release.yml`；不加 `package.json` `engines.bun`（bun 仅构建期使用） |
| 单文件 ~70 MB 用户接受度 | 低 | 低 | 在 README 明示大小；提供 Node 分发作为轻量替代（≈5 MB） |
| 跨平台交叉编译对 macOS notarize 的需求 | 高 | 低 | 不签名，README 提供 `xattr -d com.apple.quarantine` 指引 |
| Windows 上 `--version` 输出 UTF-8 中文乱码 | 中 | 低 | 冒烟脚本设 ` LANG=C.UTF-8`；若仍乱码，README 加 `chcp 65001` 说明 |
| Deno 兜底路径维护成本 | 低 | 中 | **约定：Deno 路径仅在 Bun blocker 出现时启用；未启用时 `--runtime deno` 打印 `未启用` 报错**，不留半成品代码 |
| 用户 rc 中已有同名 `proxy` / `proxy-on` 函数 | 低 | 低 | init 输出带来源注释；`proxy status` 报告生效端口与来源；README 说明集成行应追加在旧别名之后以覆盖 |
| 包名混淆：裸名 `mihomo-tui` 已被他人占用 | 中 | 中 | 全部文档统一 scoped 名 `@morndream/mihomo-tui`；package.json 的 homepage/repository/description 指回本仓库；README 发布章节明示裸名包与本工具无关 |
| 发布凭证泄露 | 低 | 高 | `NPM_TOKEN` 使用 granular token（仅本包 publish 权限），仅存 GitHub Secrets；泄露即吊销轮换 |

---

## 13. 与 `references/` 的借鉴关系

- `references/mihari/scripts/release/release_policy.py`、`github_release_policy.py`：借鉴其「release tag 一致性校验」与「release notes 策略」的**思路**；本 spec 不引入 Python 工具链，仅以 GitHub Actions 原生能力覆盖
- `references/mihari/scripts/install/install.sh`：v0.5.0 不做安装脚本；v0.6.0 若要做 shell one-liner 安装，再回来参考
- **采用原则**：mihari 用 Rust + Python 工具链，本项目坚持 Node/Bun 单工具链，只取流程模式不取实现

---

## 14. Execution Checkpoints

1. **Bun 兼容性 Spike**：在 `feature/bun-compile` 分支写最小 repro，跑通 §4 的 V1–V5 需验证点；输出结论到 PR 描述
2. **版本号注入改造**：`src/version.ts` + `bin/mihomo-tui` + `src/cli.tsx` 迁移完成，`npm run build && node bin/mihomo-tui --version` 通过
3. **Shell 代理开关集成**：`proxy on/off/status/init` 实现完成，emit-eval 回环、失败纯净性与端口发现链测试全绿——独立于 Bun 路径，可与其余 Checkpoint 并行先行
4. **本地 `scripts/build-binary.mjs --target linux-x64` 通过**，产物可 `./` 直接启动并完成冒烟三件套
5. **`--target all` 通过**，5 平台产物 + `checksums.txt` 齐全；本地 `sha256sum -c` 自检通过
6. **CI `release.yml` 草稿合并到 main**（先 `workflow_dispatch` 触发灰度）
7. **npm 发布通道**：package.json 发布化改造完成、`npm pack --dry-run` 内容校验通过、release.yml publish job 灰度；registry 首发用 `--access public`
8. **打 `v0.5.0-rc.0` tag，验证 end-to-end release**：5 个产物 attach 成功、3 平台 smoke-matrix 全绿、npm 包同步发布可安装
9. **README 安装章节更新（含 `proxy` 一行集成与 on/off 用法、`npm install -g @morndream/mihomo-tui` 安装说明）** + ROADMAP v0.5.0 勾选完成

---

## 15. 验证方案

| 编号 | 验证项 | 工具 | 通过标准 |
|---|---|---|---|
| R1 | 单测不回归 | `npm test` | 94%+ 覆盖率基线不降 |
| R2 | Node 分发路径不回归 | `npm run build && node bin/mihomo-tui --version` | 输出与 package.json version 一致 |
| R3 | 本地 linux-x64 二进制冒烟 | `./dist-bin/mihomo-tui-*-linux-x64 status --json` 在无 mihomo 环境 | 退出码 = 3，stderr 输出友好错误，无 stack trace |
| R4 | CI 全 matrix 绿 | Actions 页面 | build + smoke-matrix + release 三段全绿 |
| R5 | Release attach | GitHub Release 网页 | 5 个二进制 + checksums.txt 均可下载且 sha256 匹配 |
| R6 | macOS Apple Silicon 手测 | 运行 TUI 一次 | 能进入/退出 alternateScreen，Ctrl+C 正常 |
| R7 | Windows 手测 | powershell 跑 `--version` / `status --json` | 中文输出无乱码（或 README 已说明 workaround） |
| R8 | Shell 集成回环 | `bash -c 'eval "$(mihomo-tui proxy on)"; echo $http_proxy'` | 值与混合端口一致；`proxy off` 后为空；内核离线时 stdout 为空且退出码 3 |
| R9 | npm 安装回环 | `npm pack && npm install -g ./mihomo-tui-*.tgz`（或发布后装 registry 版） | `mihomo-tui --version` 与 package.json 一致；包内容过白名单校验；卸载无残留 |

---

## 16. 兼容性与迁移

- **Node ≥22 用户**：完全不受影响；`npm install -g mihomo-tui` + `bin/mihomo-tui` 链路保留。**无需迁移**。
- **`bin/mihomo-tui` 是否保留**：**保留**。理由：(1) 双轨承诺；(2) REPL 调试与二次开发仍走 Node 路径；(3) `tsx` 直跑 dev 工作流依赖它。仅在文件内新增一行 `globalThis.__MIHOMO_TUI_VERSION__` 注入（见 §5）。
- **配置目录** `~/.config/mihomo-tui/`：不变，二进制与 Node 版共享。
- **shell 环境**：`proxy on/off` 只操作固定变量清单（`http_proxy` / `https_proxy` / `no_proxy` / `all_proxy` / `MIHOMO_PROXY_ENV`），不触碰其余变量；已有同名 rc 函数的用户以追加顺序决定覆盖关系。
- **版本同步纪律**：git tag（`v*`）↔ `package.json` version ↔ CHANGELOG 三者一致才允许 publish；npm 包与单二进制出自同一 tag，共享同一版本号。
- **退出码 / `--json` 协议**：不变，自动化脚本无缝切换。
- **未来若放弃 Node 分发**：至少在 v1.0.0 之前不做；重大变更须走新 spec 评审。

---

## 17. 开放问题

1. ~~**Bun 具体锁定版本**~~ **已收敛（§4.1 spike）**：锁定 `bun@1.4.2` 写入 `release.yml`；不在 `package.json.engines` 加 `bun` 字段（bun 仅构建期使用，运行时零依赖）。
2. **是否需要 `install.sh` 一键脚本**：当前判断**不需要**（YAGNI），留给 v0.6.0 视用户反馈再议。
3. **Windows ARM64 是否纳入**：Bun `--target=bun-windows-arm64` 仍标记 experimental；**本版本不纳入**，跟踪上游。
4. **是否将二进制同时发布为 npm 可选依赖**（`optionalDependencies` + `postinstall`）：社区做法（如 esbuild / swc），但实现复杂；**v0.5.0 不做**。
5. **Deno 兜底路径何时启用**：仅在 Bun 出现 v0.5.0 截止前不可修复的 blocker 时启用；启用后需要在 ROADMAP 增补一项「Deno 路径专项」。
6. **产物大小优化**：是否引入 `--minify` + `--sourcemap=none`、尝试 `--bytecode`（Bun 1.1.30+ 实验性）？建议**先 ship 再优化**。
7. **测速/GitHub Release 在中国镜像可访问性**：发布渠道是否镜像到 Gitee / 自建 alist？本 spec 不管；由后续运营决定。
8. **fish / PowerShell 集成**何时补齐：`--shell` 参数已预留；视用户反馈在 v0.6.0 评估。

---

## 18. 技术债与阶段待办

实施过程中确认无法在本阶段闭环的事项记录于此，按阶段追加；闭环后勾选。

- [ ] **npm 发布前置（用户操作）**：注册 npm 账号并配置 GitHub Secrets `NPM_TOKEN`（granular token，仅 `@morndream/mihomo-tui` 的 publish 权限）；publish job 在 token 就绪前以跳过状态存在
- [ ] **端到端 release 验证（用户操作）**：push `v0.5.0-rc.0` tag 触发 release.yml 全链路（5 产物 attach、3 平台 smoke-matrix、npm 同步发布）
- [ ] **真机手测（R6/R7）**：macOS Apple Silicon 与 Windows 各跑一次 TUI 进出与 `--version` / `status --json`
- [ ] **版本发布节奏**：rc tag 前把 `package.json` version bump 为与 tag 一致（如 `v0.5.0-rc.0` ↔ `0.5.0-rc.0`，build job 守卫强制），CHANGELOG 建立对应版本节；正式 `v0.5.0` 时去掉 prerelease 标记
- [ ] **npm granular token 政策迁移（2027-01 前评估）**：npm 官方预告 2027-01 起 granular token 直接 publish 将移除（改为 stage-only 流程）；现有 token 2026-12-26 到期，重建时需按届时官方文档操作，release.yml publish job 已留前瞻注释
- [ ] **vitest `poolOptions` 弃用迁移**：vitest 5 运行时警告 `poolOptions` 将在未来大版本移除（迁移为顶层选项）；`vitest.config.ts` 的 `poolOptions.forks.singleFork` 需按官方迁移指南改写（当前仅警告、行为正常）

---

**End of Spec.**