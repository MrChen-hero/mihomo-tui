# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中

- TUI 内订阅生命周期管理（新增 / 删除 / 编辑订阅），设计稿见
  [`docs/specs/2026-08-17-subscription-management-design.md`](docs/specs/2026-08-17-subscription-management-design.md)
- 自动化测试（单元测试 + 集成测试）

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
