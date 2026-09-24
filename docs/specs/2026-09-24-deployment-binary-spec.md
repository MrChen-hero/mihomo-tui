# mihomo-tui v0.5.0「部署与分发优化」Level 2 Concise Spec

- **日期**：2026-09-24
- **目标版本**：v0.5.0
- **上游依据**：`docs/ROADMAP.md` §v0.5.0、`docs/DEVELOPMENT.md`、`package.json`、`bin/mihomo-tui`、`.github/workflows/ci.yml`
- **状态**：草稿（待评审）

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

**本次 v0.5.0 目标**：

1. 决策 Bun vs Deno 打包方案
2. 产出五平台单二进制：Linux x86_64 / aarch64、macOS x86_64 / arm64、Windows x86_64
3. 提供 `scripts/build-binary.mjs` 本地打包入口
4. 新增 GitHub Actions `release.yml`，push `v*` tag 时自动出产物并挂到 GitHub Release
5. 保持现有 `tsc` + `bin/mihomo-tui` Node 分发路径不变（**双轨分发**）

---

## 2. 范围与非目标

### 2.1 范围内

- `scripts/build-binary.mjs` 本地构建脚本（`--target` / `--out-dir` 参数）
- CI 工作流 `.github/workflows/release.yml`
- 版本号统一从 `package.json` 读取（现有 `src/cli.tsx` 已如此）
- 产物 SHA256 checksums (`checksums.txt`)
- 安装说明（README 增附录，不单独写安装脚本——本版本不提供 `install.sh`）
- 冒烟测试：CI 中跑 `./<binary> --help` 和 `./<binary> status --json`（无 mihomo 环境，期望友好错误退出码 3）

### 2.2 非目标（Not Goals）

- **GUI 安装器**：不做 MSI / DMG / Debian 包 / RPM
- **auto-update**：二进制不会自更新，升级 = 用户手动下载新版本
- **代码签名 / notarize**：macOS Gatekeeper 提示由用户自行处理（`xattr -d com.apple.quarantine`）
- **NPM registry 发布**：`package.json` 目前 `"private": true`，本版本不改
- **跨架构交叉编译产物的大量调优**（如精简 Bun runtime）：允许单文件 60–100 MB
- **替用户管理 mihomo 内核**：仍假设外部启动 mihomo

---

## 3. 方案对比与决策

### 3.1 候选方案对比表

| 方案 | 跨平台 cross-compile | Ink 7 / React 19 兼容 | 产物大小 | Node API 兼容 | 维护活跃度 | 总评 |
| --- | --- | --- | --- | --- | --- | --- |
| **Bun `bun build --compile`** | ✅ 官方支持 `--target=bun-linux-x64` 等 5 平台 | ⚠️ 历史有问题，2024Q4 起大幅改善（**需验证**） | ~55–80 MB | ✅ 高度兼容 Node API | 🟢 高（周更） | **推荐** |
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
| **`import.meta.url` + `readFileSync(package.json)`** | ⚠️ `--compile` 后 `import.meta.url` 指向虚拟路径，**需改造**：版本号改为构建期编译进常量（见 §6） | 同 | **中** |

**关键需验证点列表**（写入 Execution Checkpoints 1）：

- V1：Ink `render(..., { alternateScreen: true })` 在 Bun 单二进制下能正常进入/退出备用屏幕
- V2：Ctrl+C 触发 `waitUntilExit` resolve 与 `exitAfterFlush` 流程
- V3：`WebSocket` 连接 mihomo 日志流不卡死
- V4：`fetch` 在二进制内无成对的 TLS / DNS 限制
- V5：`readFileSync(new URL('../package.json', import.meta.url))` 在编译产物里不可用 → **必须改造为 build-time 常量注入**

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

## 6. 总体架构

### 6.1 构建流水线

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

### 6.2 `scripts/build-binary.mjs` 接口

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

---

## 7. 构建产物布局

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

## 8. CI 工作流设计

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
```

**要点**：
- **不引入额外编排工具**（无 nx/turbo），原生 `strategy.matrix` + `$default` runner 三平台冒烟
- Windows runner 上 bash shell 可用（GitHub 默认集成 git-bash）
- 不签名；release notes 由 `generate_release_notes` 自动生成 + 手动补充

---

## 9. 本地开发体验

### 9.1 新增 npm scripts

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

### 9.2 `bin/mihomo-tui` 关系

**保留不动**。双轨分发策略：

| 渠道 | 适用人群 | 入口 |
|---|---|---|
| Node ≥22 用户 | 已装 Node 的开发者 | `npm install` + `bin/mihomo-tui` |
| 无 Node 用户 | 服务器、容器、桌面终端用户 | GitHub Release 单二进制 |

两条路径共用 `src/cli.tsx`，行为一致。`bin/mihomo-tui` 新增仅一行版本注入逻辑（见 §5）。

### 9.3 文档

`README.md` 增加「安装方式」一节，分两个 Tab：Node 安装 / 二进制下载。

---

## 10. 测试策略

| 层级 | 工具 | 内容 |
|---|---|---|
| 单元 / 集成 | 现有 `vitest run`（CI 已跑） | 不变化 |
| 构建期 | `npm run typecheck` | 保证 TS 不回归 |
| **二进制冒烟（最小）** | CI step | 1. `--version` 输出与 package.json 一致 2. `--help` 退出码 0 3. `status --json` 在无 mihomo 环境下退出码 = `EXIT.kernel`（3），并输出友好错误 |
| **二进制 TUI 交互** | 手工 | 跑一次 TUI 进入/退出（mac/linux 各一次）— 不进 CI，列入发布 checklist |
| **产物校验** | CI step | `sha256sum -c checksums.txt` 自检通过 |

不引入 e2e 框架（避免超出 v0.5.0 范围）。

---

## 11. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Ink 7 在 Bun 单二进制下 raw-mode/alternateScreen bug | 中 | 高（TUI 不可用） | **Checkpoint 1 实测**；若阻塞切 `deno compile`；或保底方案：二进制模式下禁用 TUI（仅 CLI），文档明示 |
| `--compile` 产物 `import.meta.url` 不可用 | 高 | 中 | §5 版本号注入改造已解决 |
| Bun 版本迭代引入 regression | 中 | 中 | `oven-sh/setup-bun@v2` 锁定 `bun-version: 1.x.y`，写入 `release.yml` 与 `package.json` `engines.bun` |
| 单文件 ~70 MB 用户接受度 | 低 | 低 | 在 README 明示大小；提供 Node 分发作为轻量替代（≈5 MB） |
| 跨平台交叉编译对 macOS notarize 的需求 | 高 | 低 | 不签名，README 提供 `xattr -d com.apple.quarantine` 指引 |
| Windows 上 `--version` 输出 UTF-8 中文乱码 | 中 | 低 | 冒烟脚本设 ` LANG=C.UTF-8`；若仍乱码，README 加 `chcp 65001` 说明 |
| Deno 兜底路径维护成本 | 低 | 中 | **约定：Deno 路径仅在 Bun blocker 出现时启用；未启用时 `--runtime deno` 打印 `未启用` 报错**，不留半成品代码 |

---

## 12. 与 `references/` 的借鉴关系

- `references/mihari/scripts/release/release_policy.py`、`github_release_policy.py`：借鉴其「release tag 一致性校验」与「release notes 策略」的**思路**；本 spec 不引入 Python 工具链，仅以 GitHub Actions 原生能力覆盖
- `references/mihari/scripts/install/install.sh`：v0.5.0 不做安装脚本；v0.6.0 若要做 shell one-liner 安装，再回来参考
- **采用原则**：mihari 用 Rust + Python 工具链，本项目坚持 Node/Bun 单工具链，只取流程模式不取实现

---

## 13. Execution Checkpoints

1. **Bun 兼容性 Spike**：在 `feature/bun-compile` 分支写最小 repro，跑通 §4 的 V1–V5 需验证点；输出结论到 PR 描述
2. **版本号注入改造**：`src/version.ts` + `bin/mihomo-tui` + `src/cli.tsx` 迁移完成，`npm run build && node bin/mihomo-tui --version` 通过
3. **本地 `scripts/build-binary.mjs --target linux-x64` 通过**，产物可 `./` 直接启动并完成冒烟三件套
4. **`--target all` 通过**，5 平台产物 + `checksums.txt` 齐全；本地 `sha256sum -c` 自检通过
5. **CI `release.yml` 草稿合并到 main**（先 `workflow_dispatch` 触发灰度）
6. **打 `v0.5.0-rc.0` tag，验证 end-to-end release**：5 个产物 attach 成功、3 平台 smoke-matrix 全绿
7. **README 安装章节更新** + ROADMAP v0.5.0 勾选完成

---

## 14. 验证方案

| 编号 | 验证项 | 工具 | 通过标准 |
|---|---|---|---|
| R1 | 单测不回归 | `npm test` | 94%+ 覆盖率基线不降 |
| R2 | Node 分发路径不回归 | `npm run build && node bin/mihomo-tui --version` | 输出与 package.json version 一致 |
| R3 | 本地 linux-x64 二进制冒烟 | `./dist-bin/mihomo-tui-*-linux-x64 status --json` 在无 mihomo 环境 | 退出码 = 3，stderr 输出友好错误，无 stack trace |
| R4 | CI 全 matrix 绿 | Actions 页面 | build + smoke-matrix + release 三段全绿 |
| R5 | Release attach | GitHub Release 网页 | 5 个二进制 + checksums.txt 均可下载且 sha256 匹配 |
| R6 | macOS Apple Silicon 手测 | 运行 TUI 一次 | 能进入/退出 alternateScreen，Ctrl+C 正常 |
| R7 | Windows 手测 | powershell 跑 `--version` / `status --json` | 中文输出无乱码（或 README 已说明 workaround） |

---

## 15. 兼容性与迁移

- **Node ≥22 用户**：完全不受影响；`npm install -g mihomo-tui` + `bin/mihomo-tui` 链路保留。**无需迁移**。
- **`bin/mihomo-tui` 是否保留**：**保留**。理由：(1) 双轨承诺；(2) REPL 调试与二次开发仍走 Node 路径；(3) `tsx` 直跑 dev 工作流依赖它。仅在文件内新增一行 `globalThis.__MIHOMO_TUI_VERSION__` 注入（见 §5）。
- **配置目录** `~/.config/mihomo-tui/`：不变，二进制与 Node 版共享。
- **退出码 / `--json` 协议**：不变，自动化脚本无缝切换。
- **未来若放弃 Node 分发**：至少在 v1.0.0 之前不做；重大变更须走新 spec 评审。

---

## 16. 开放问题

1. **Bun 具体锁定版本**：在 Checkpoint 1 spike 时确定并写入 `release.yml`（候选 `1.1.x` 最新稳定）。是否同时在 `package.json.engines` 加 `bun` 字段需讨论。
2. **是否需要 `install.sh` 一键脚本**：当前判断**不需要**（YAGNI），留给 v0.6.0 视用户反馈再议。
3. **Windows ARM64 是否纳入**：Bun `--target=bun-windows-arm64` 仍标记 experimental；**本版本不纳入**，跟踪上游。
4. **是否将二进制同时发布为 npm 可选依赖**（`optionalDependencies` + `postinstall`）：社区做法（如 esbuild / swc），但实现复杂；**v0.5.0 不做**。
5. **Deno 兜底路径何时启用**：仅在 Bun 出现 v0.5.0 截止前不可修复的 blocker 时启用；启用后需要在 ROADMAP 增补一项「Deno 路径专项」。
6. **产物大小优化**：是否引入 `--minify` + `--sourcemap=none`、尝试 `--bytecode`（Bun 1.1.30+ 实验性）？建议**先 ship 再优化**。
7. **测速/GitHub Release 在中国镜像可访问性**：发布渠道是否镜像到 Gitee / 自建 alist？本 spec 不管；由后续运营决定。

---

**End of Spec.**