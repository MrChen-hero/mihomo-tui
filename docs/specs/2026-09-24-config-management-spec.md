# v0.4.0 配置管理：规则管理

**日期：** 2026-09-24

**状态：** 已实施，2026-09-25 验收

**前置：** v0.3.0 订阅增强

**范围修订：** 用户已确认先交付规则管理，代理链暂缓；规则测试采用保守本地匹配。

## 1. 背景与内核核验

项目通过 External Controller（内核控制接口）管理运行时状态，本版补齐生效规则和规则集的查看、测试、更新与临时禁用。

本机 GET /version 为 v1.19.24；GET /rules 返回 Domain、DomainSuffix、RuleSet、Match 等类型及 index、extra.disabled；GET /providers/rules 返回规则集资料。

对应版本的官方源码：

- [规则路由](https://github.com/MetaCubeX/mihomo/blob/v1.19.24/hub/route/rules.go)：GET /rules 与 PATCH /rules/disable；没有服务端规则测试接口。嵌入模式不提供 PATCH。
- [代理组解析](https://github.com/MetaCubeX/mihomo/blob/v1.19.24/adapter/outboundgroup/parser.go)：type: relay 已被移除，要求改用 dialer-proxy。

因此本版不实现 relay 创建、编辑、删除或 CLI，也不把 relay 建链作为成功标准。现有代理链代码作为未接入的草稿保留。后续 dialer-proxy 需要另订节点来源、配置生成与订阅更新兼容设计。

## 2. 成功标准与边界

- TUI 规则页能独立展示规则和规则集；某一接口失败不遮蔽另一部分。
- 规则可筛选、查看详情、本地测试；不确定时明确提示需内核判定，不输出确定出口。
- 支持的内核可临时禁用/启用规则，操作后回读确认；旧内核仅允许本地标记。
- CLI 四条命令均支持 JSON 与既有退出码；实际入口可编译运行。
- 规则管理不写 config.yaml，不修改 subscriptions.json，不重启服务。
- 不做规则追加、全文编辑、持久化禁用、地理数据库下载、DNS 查询或规则集内容解析。

术语：rule 是按顺序匹配的分流规则；rule-provider 是内核维护的规则集；CIDR 是 IP 网段记法；保守匹配是在缺少必要数据时停止判断。

## 3. 接口和模型

保留内核原始规则字段：type、payload、proxy，以及可选 index、size、extra.disabled。仅在展示与比较时统一类型名称，例如 DomainSuffix → DOMAIN-SUFFIX；不改写 JSON 原始类型。

- rules()：GET /rules。
- ruleProviders()：GET /providers/rules。
- updateRuleProvider(name)：PUT /providers/rules/{encodedName}。
- setRuleDisabled(index, disabled)：PATCH /rules/disable，请求示例 {"12":true}。
- PATCH 的 index 使用内核零基索引，绝不使用筛选后的行号。界面与测试结果 index 为完整列表中的一基序号。

runtime 模块负责能力判断与写后确认。操作前重新读取并对比规则序列（index/type/payload/proxy）和所选规则的禁用状态，变化则刷新并要求重试。PATCH 后回读；目标状态和序列均符合预期才报告成功。

接口无条件写入能力，预检与 PATCH 之间仍可能有外部 reload。提交断连、回读失败或序列变化时提示“结果未确认”，不自动重试。401/403/网络失败不当作功能缺失；404/405 或缺少 index/disabled 字段降级只读。

## 4. 保守规则测试

共用纯函数输出 hit / miss / unsupported；TUI 与 CLI 共享模型。

- 支持 DOMAIN、DOMAIN-SUFFIX、DOMAIN-KEYWORD、IP-CIDR、IP-CIDR6、MATCH，按内核顺序判断。
- 跳过 extra.disabled 明确为 true 的规则。
- GEOIP、GEOSITE、RULE-SET、进程及未知规则立即返回 unsupported。
- 域名遇到 IP 网段规则时需 DNS 数据，返回 unsupported；不假定其不匹配。
- 无效 CIDR 返回 unsupported；无效输入目标报参数错误。
- 域名大小写不敏感，处理末尾点和国际化域名；IP 使用严格 IPv4/IPv6 校验，不接受 URL、端口、路径或 zone ID。
- 命中只说明目标代理组/内置出口，不声称确定最终节点或实际流量路径。

## 5. TUI

六个标签顺序：节点、订阅、规则、日志、连接、设置。

| 键位 | 行为 |
|---|---|
| ↑↓ / jk | 选择规则或规则集，跳过分区标题 |
| l | 循环类型筛选 |
| / | 关键字筛选 payload 或目标组，空值清除 |
| Enter | 详情：类型、payload、目标、禁用状态；RuleSet 才展示来源规则集 |
| t | 输入域名/IP 测试；清除筛选以定位命中或受阻规则 |
| u | 更新选中规则集并刷新 |
| d | 临时禁用/启用，防止重复提交 |
| m | 禁用不可用时本地标记，不改变内核或本地测试结果 |
| r | 刷新 |
| ESC | 先退详情/输入层，再沿用应用退出确认 |

规则页 m 不触发全局模式切换。本地标记仅保留当前会话，规则序列变化即清除。禁用在重载或内核重启后可能恢复。

窄屏按显示宽度截断列表，完整字段在详情查看；规则集展示数量与更新时间。接口错误、待加载、空列表分别显示。unsupported 使用提示色，不作为成功命中。

## 6. CLI

~~~bash
proxy_tui rules ls [--type <T>] [--json]
proxy_tui rules test <host> [--json]
proxy_tui rule-provider ls [--json]
proxy_tui rule-provider update <name> [--json]
~~~

--type 同时接受 DomainSuffix 与 DOMAIN-SUFFIX 等名称。筛选后的文本输出保持完整列表序号；JSON 保留原始规则对象及内核 index。

测试 JSON：target / outcome / rule / index；miss 时后两者为 null。unsupported 中的 rule 是阻止继续判断的规则，其 proxy 不是已确认的出口。更新成功 JSON：{"ok":true,"name":"..."}。JSON 标准输出不混入状态文案，错误写 stderr。

退出码：0 成功（含已完成分析但 unsupported/miss），1 业务失败，2 参数错，3 内核不可达。不增加禁用 CLI。

## 7. 配置兼容

无新配置文件或订阅 Schema（数据结构）迁移。已有旧 relay 配置只在骨架重建时按名保留所有字段，该逻辑归属 config，不依赖代理链编辑器。对新内核不兼容的旧配置，继续由现有事务的 mihomo -t 校验拒绝，不能静默删除。

## 8. 实施检查点

1. 修复入口编译；保留工作区草稿并明确暂缓功能。
2. 对齐 API 字段、类型转换、禁用请求与回读确认。
3. 修正保守匹配及边界测试。
4. 完成规则页交互、独立加载和 ESC。
5. 完成 CLI JSON/退出码及子进程入口测试。
6. 全量验证、隔离内核验收、文档与版本同步。

## 9. 验证

- API 假内核：真实响应字段、PATCH 载荷、URL 编码、错误分类。
- 匹配单测：域名边界、IPv4/IPv6 网段、别名、禁用规则、未知规则顺序、DNS 依赖和非法输入；匹配模块覆盖率至少 90%。
- 界面测试：筛选/详情/测试/更新/禁用/降级标记、局部失败、窄屏、分层 ESC 和 m 不穿透。
- CLI 子进程：四条命令、JSON、文本序号、0/1/2/3 退出码，临时 HOME 与假内核隔离真实配置。
- 配置回归：骨架保留旧组及未知字段，规则管理路径不写 config.yaml。
- npm run typecheck、npm test、npm run build、npm run coverage 全部通过。
- 真实内核只读检查；运行时禁用/恢复、规则集更新在独立临时配置的隔离内核中验证。
