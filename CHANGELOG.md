# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.0] - 2026-09-13

### 新增

- **TUI 内订阅生命周期管理**（`docs/specs/2026-08-17-subscription-management-design.md`）：
  - `a` 新增订阅：名称 / URL / 节点名前缀，逐字段实时校验
  - `d` 删除订阅：红色确认框列出全部变更，执行后清理 provider 缓存文件
  - `e` 编辑节点名前缀（名称与 URL 不可改）
  - 全程进度对话框展示每一步；失败自动回滚并把 `systemctl status`
    完整输出放进错误框
- **订阅事务层 `src/config/`**：订阅清单原子写、骨架生成（自迁移脚本迁移）、
  `ConfigManager`（备份 → 临时目录 `mihomo -t` 校验 → 原子写 → 写后复验 →
  回滚）、`ServiceManager`（systemd 用户服务操作）、订阅增删改编排
  （清单 + 配置 + 服务三者同进同退）；配置备份保留 7 天
- **自动化测试体系**：vitest，176 个用例覆盖 REST 客户端（本地假内核）、
  WebSocket 状态机、订阅清单/骨架/管理器、订阅事务逐阶段回滚、TUI 对话框
  （无头渲染 + 按键注入）；`src/config/` 语句覆盖率 94%+；CI 增加 test 步骤
- **只读验收入口** `scripts/generate-config.mjs`：对真实配置执行
  「读订阅 → 生成骨架 → `mihomo -t` 校验」，不写任何文件
- **真实内核冒烟脚本** `scripts/smoke-subscription.mjs`：前置快照后用测试
  订阅走完整增删链路，失败自动恢复（手动执行）

### 变更

- `redactUrl` 从 `commands/output.ts` 迁至 `config/subscriptions.ts`
  （原导出保留）；订阅 URL 的 token 在所有错误信息中不再出现
- 安全边界表述更新：写 `config.yaml` 的代码路径收敛为唯一的 `ConfigManager`，
  强制备份/校验/原子写/回滚流程

### 安全

- 测试套件全局禁止写入真实的 `~/.config/mihomo{,-tui}` 目录
  （`vitest.setup.ts` 防护网）

## [0.1.0] - 2026-08-17

### 新增

- **CLI 子命令**：`status`、`proxy ls/use/unfix/test`、`provider ls/update/check`、
  `logs`、`conn ls/close`、`reload`，全部支持 `--json` 输出
- **TUI 四标签页**：节点（双栏选择、延迟五状态、整组/单节点测速、可用过滤）、
  订阅（更新 / 健康检查 / 展开节点）、日志（级别切换、关键字过滤、暂停）、
  连接（排序、关闭单条 / 全部）
- **节点延迟测试**：单节点与整组并发测速，结果流式回填
- **模式切换**：规则 / 全局 / 直连循环切换
- **配置热重载**：`reload` 触发内核重读配置，进程不重启
- **配置迁移脚本**：`scripts/migrate-config.mjs`，将整份订阅配置改造为
  「骨架 + proxy-providers」架构，默认 dry-run，`--apply` 时备份 + `mihomo -t`
  校验 + 失败自动回滚

### 安全

- 运行时只通过 REST API 操作内核，代码中不存在写 `config.yaml` 的路径
- 迁移脚本为唯一配置写入入口，且必须显式 `--apply`

### 性能

- 日志流 1000 行环形缓冲，长时运行内存稳定
- 日志 / 连接流仅在对应标签页可见时渲染
- Spinner 心跳仅在有活动任务时启动

[Unreleased]: https://github.com/MrChen-hero/mihomo-tui/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MrChen-hero/mihomo-tui/releases/tag/v0.1.0
