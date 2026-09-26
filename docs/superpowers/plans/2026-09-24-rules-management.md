# v0.4.0 规则管理实施计划

用户已确认：本版交付规则管理；本地匹配采用保守策略；代理链暂缓。

技术栈：Node.js 22+、TypeScript、React/Ink、Commander、Vitest。
架构：API 保留内核字段，rules 模块统一类型转换、匹配与禁用确认，TUI/CLI 共用模型。

- [x] 修订 spec，修复 CLI 编译入口；保留代理链草稿但不接入生产入口。
- [x] 对齐真实规则字段和 PATCH /rules/disable；补齐错误分类与确认测试。
- [x] 保守匹配域名/IPv4/IPv6；未知、GEOIP、RULE-SET、DNS 依赖返回 unsupported。
- [x] 完成规则页筛选、详情、测试、更新、禁用降级、独立加载、窄屏和 ESC。
- [x] 四条 CLI 命令支持 JSON、真实入口测试及 0/1/2/3 退出码。
- [x] 类型检查、全量测试、构建、匹配覆盖率至少 90%；隔离验证运行时修改。
- [x] 同步 README、ROADMAP、CHANGELOG 和版本；核对原目录哈希后同步变更。

基线：37 个测试文件、435 项测试通过；CLI 第 137 行语法错误导致 typecheck 失败。
证据：本机 GET /version 为 v1.19.24；对应官方 parser.go 已移除 relay；rules.go 提供禁用接口。
运行时操作不写 config.yaml，不修改 subscriptions.json；没有规则追加、全文编辑或禁用 CLI。
PATCH 无条件写入契约，存在与外部 reload 的竞争窗口；回读失败或序列改变时报告结果未确认，不自动重试。

## 验收记录（2026-09-25）

- `npm run typecheck`、`npm run build`、`npm run coverage` 通过；41 个测试文件、518 项测试。
- `src/rules` 语句覆盖率 99.04%、分支覆盖率 97.95%，匹配模块配置了 90% 的覆盖率门槛。
- 隔离内核验收：`node scripts/smoke-rules.mjs /4t/usr/chenjw/bin/mihomo` 返回 ok=true，版本 v1.19.24。
- 隔离验证包含读取、保守匹配、禁用/启用回读、规则集更新及 config.yaml 逐字节不变。
- 现有内核仅只读检查：237 条规则、39 个规则集，Domain 类型本地匹配命中；未修改现有服务配置或运行状态。
- 现有未接入的代理链草稿保持原样；本版不提供代理链入口。

同步完成：30 个新增/修改文件（含被 Git 忽略的本地锁文件），原目录无并发修改冲突，未创建提交。匹配器语句、分支和函数覆盖率均为 100%。
