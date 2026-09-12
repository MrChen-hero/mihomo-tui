# 贡献指南

感谢关注 mihomo-tui！欢迎提交 Issue 与 Pull Request。

## 开发环境

```bash
git clone https://github.com/MrChen-hero/mihomo-tui.git
cd mihomo-tui
npm install
npm run build
```

要求：Node.js ≥ 22（依赖内置的 `fetch` 与 `WebSocket`，无需额外请求库）、
TypeScript 5.x（请勿升级到 7.x，Ink 生态尚未适配）。

本地开发可直接用 tsx 直跑源码：

```bash
npm run dev -- status
```

提交前请确保：

```bash
npm run typecheck   # tsc --noEmit 无错误
npm run build       # 编译通过
```

## 设计约束（改动前必读）

1. **运行时代码绝不写 `config.yaml`** —— 所有操作必须通过 mihomo 的 REST API
   完成；配置写入能力只允许存在于 `scripts/migrate-config.mjs`，且必须显式
   `--apply` 并强制备份 + 校验 + 回滚。
2. **不新增监听端口** —— 只连本机 external-controller。
3. **不打印敏感信息** —— 订阅 URL 中的 token 在任何输出中必须脱敏。
4. **WebSocket close 永不完成** —— mihomo 内核不回应 close 帧，用过流的
   命令路径必须显式退出，不能依赖事件循环自然排空。

详细背景与一手实测数据见 [`docs/SPEC.md`](docs/SPEC.md)。

## 提交规范

Commit message 使用以下前缀：

```
feat:     新功能
fix:      修复 Bug
docs:     文档变更
refactor: 重构（不改行为）
perf:     性能优化
test:     测试相关
chore:    构建 / 工具链变更
```

## 联调约束

不要重启或停止你本机生产环境的 mihomo 服务。需要测试破坏性行为时，请起独立
实例（自定义 `-d` 工作目录 + 未占用端口），用完清理。

## 报告问题

提交 Issue 时请附上：

- mihomo 内核版本（`mihomo -v`）
- Node.js 版本
- 复现步骤与完整错误输出（注意脱敏订阅 URL 与 token）
