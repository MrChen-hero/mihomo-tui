# v0.4.0 配置管理增强（规则管理 / 本地节点 / 代理链）设计文档

**日期：** 2026-09-24
**目标版本：** v0.4.0
**状态：** 草稿（Level 2，待评审）
**前置版本：** v0.2.0（订阅事务）、v0.3.0（订阅增强，规划中）
**参考：** `references/mihari`（规则页 `internal/tui/pages/rules`、规则 CLI `internal/cli/rules.go`）

---

## 1. 背景与目标

### 1.1 背景

当前 mihomo-tui 只管理**订阅来源**（proxy-providers）与**运行时选路**（代理组切换、延迟测试）。三块能力缺失：

1. **规则不可见**：`config.yaml` 里的 `rules` 与 `rule-providers` 只能用编辑器改，TUI 看不到当前生效规则、无法临时禁用单条、无法测试「这个域名会走哪条规则」。
2. **无法手写节点**：用户想加一个自建 SS/Trojan/VMess/VLESS 节点，只能手改 `config.yaml`，没有表单、没有校验、没有热更新。
3. **代理链（relay）只能手写**：多跳中转需要在 `proxy-groups` 里写 `type: relay`，没有可视化编辑与连通性测试。

### 1.2 术语说明

| 术语 | 含义 | 为什么重要 |
|------|------|-----------|
| **规则（rule）** | mihomo 按顺序匹配的一条分流语句，形如 `DOMAIN-SUFFIX,google.com,代理组` | 决定流量走哪个出口 |
| **rule-provider** | 按 URL 动态拉取的规则集，内核周期性更新 | 让规则集可远程维护而不改 config |
| **本地节点（local proxy）** | 用户手写的单个代理节点（SS/Trojan/VMess/VLESS），不来自订阅 | 补充订阅之外的自建节点 |
| **代理链（relay）** | `proxy-groups` 中 `type: relay` 的组，流量按顺序经过多个节点 | 实现落地中转、多跳隐私 |
| **运行时修改** | 通过 External Controller API 改内核内存状态，不写磁盘 | 可随时撤销、不影响 config 文件 |
| **持久化修改** | 写入 `config.yaml` 并 reload，重启后仍生效 | 需要事务保护（备份/校验/回滚） |

### 1.3 目标

1. **规则页**：TUI 新增「规则」标签页，展示当前生效规则与 rule-providers；支持按类型/关键字过滤、临时禁用单条（运行时）、rule-provider 更新、域名/IP 规则测试。
2. **本地节点**：独立文件 `~/.config/mihomo-tui/local-proxies.yaml` 存储手写节点，作为独立 proxy-provider 挂载；TUI 表单增删改，改完热更新。
3. **代理链**：在节点页或独立子视图编辑 relay 组，提供常见场景模板，修改后走 reload（非热更新）。

**成功标准：**

- TUI「规则」页能列出当前全部规则，输入域名后显示命中的规则与出口组。
- 通过表单添加一个 SS 节点后，不重启内核即可在代理组里选到它。
- 用模板创建一个「落地中转」relay 组，reload 后流量按预期经过两跳。

---

## 2. 范围与非目标

### 2.1 范围内

- API 客户端新增：`rules()`、`ruleProviders()`、`updateRuleProvider(name)`、规则测试（若内核支持 `/rules/test` 或等价接口，否则本地匹配）。
- TUI 新增「规则」标签页（`src/views/Rules.tsx`）。
- 本地节点存储 `local-proxies.yaml` + 作为 `type: file` 的 proxy-provider 挂载。
- 本地节点表单（协议选择 → 参数 → 校验）与导入/导出。
- relay 组编辑器（列表式，不做拖拽）+ 两个场景模板。
- CLI：`rules ls`、`rules test <host>`、`rule-provider ls/update`、`local-proxy add/ls/rm`、`relay ls/add`。

### 2.2 非目标

- **不实现代理协议本身**：只生成 mihomo 能识别的节点 YAML，不自己握手。
- **不做拖拽式代理链编辑器**：TUI 里拖拽成本高，用列表 + 上下移动代替。
- **不持久化「临时禁用规则」**：运行时禁用只在本次内核生命周期内有效，重启即恢复（持久化留作后续，需走写 config 事务）。
- **不做规则的可视化 diff / 语法高亮编辑器**：规则编辑以「禁用/启用 + 追加」为主，不提供全文编辑器。
- **不支持 Reality / Hysteria2 / TUIC 等新协议的完整表单**：v0.4.0 只覆盖 SS / Trojan / VMess / VLESS 四个主流协议，其余协议允许以「原始 YAML 片段」方式导入。

---

## 3. 总体设计

### 3.1 三条能力的写入边界（关键）

| 能力 | 写入目标 | 是否写 config.yaml | 生效方式 |
|------|---------|-------------------|---------|
| 规则查看 / 过滤 / 测试 | 无 | 否 | 只读 API |
| 临时禁用单条规则 | 内核内存 | 否 | API（若内核不支持则本版降级为「只读 + 标记」） |
| rule-provider 更新 | 内核拉取 | 否 | `PUT /providers/rules/{name}` |
| 本地节点增删改 | `local-proxies.yaml` + 内核热更新 | 否（只写独立文件） | `PUT /providers/proxies/{name}` |
| 代理链（relay）编辑 | `config.yaml` 的 `proxy-groups` | **是** | reload（走现有 `ConfigManager` 事务） |

**设计原则：** 能不写 `config.yaml` 的一律不写。只有 relay（内核无热更新接口）才走写盘事务。

### 3.2 模块划分

```
src/
├── api/
│   ├── client.ts            # + rules() / ruleProviders() / updateRuleProvider()
│   └── types.ts             # + Rule / RuleProvider 类型
├── rules/
│   ├── matcher.ts           # 本地规则匹配（域名/IP → 命中规则），纯函数
│   └── model.ts             # 规则列表的过滤/排序/禁用状态
├── localproxy/
│   ├── schema.ts            # 四协议字段校验（SS/Trojan/VMess/VLESS）
│   ├── store.ts             # local-proxies.yaml 读写（原子写）
│   └── provider.ts          # 把本地节点挂载为 file 型 proxy-provider
├── relay/
│   └── editor.ts            # relay 组的增删改 + 模板，产出 proxy-groups 片段
├── views/
│   ├── Rules.tsx            # 新增规则页
│   └── LocalProxies.tsx     # 新增本地节点子页（或并入节点页）
└── commands/
    ├── rules.ts             # rules ls / rules test
    ├── localproxy.ts        # local-proxy add/ls/rm
    └── relay.ts             # relay ls/add
```

### 3.3 与现有骨架的衔接

`skeleton.ts` 生成 config 时：

- `rule-providers` 已通过 `pickRecord(oldConfig, 'rule-providers')` 保留，本版不改该逻辑。
- 新增：若 `local-proxies.yaml` 存在且非空，骨架额外注入一个 `proxy-providers.local`（`type: file`, `path: ~/.config/mihomo-tui/local-proxies.yaml`），并把它加入各 proxy-group 的候选。
- relay 组由 `relay/editor.ts` 产出，骨架在 `proxy-groups` 合并时保留用户定义的 relay 组（按名字识别，不覆盖）。

---

## 4. 规则管理

### 4.1 数据来源

- 生效规则：`GET /rules` → `{ rules: [{ type, payload, proxy, size }] }`。
- rule-providers：`GET /providers/rules` → 与 proxy-providers 结构类似（name / vehicleType / behavior / ruleCount / updatedAt）。
- 更新：`PUT /providers/rules/{name}`。

> 需在实施前用真实 mihomo 核对这三个接口的字段（本仓库 `src/api` 目前没有 rules 相关调用）。若内核不返回「禁用」状态，则「临时禁用」降级为**只读 + 本地标记**（见 §4.4）。

### 4.2 TUI 规则页

```
规则 · 234 条   rule-providers · 3
 ─ 过滤: [type: DOMAIN-SUFFIX] [关键字: google] ─────
▌ DOMAIN-SUFFIX  google.com     代理组·媒体
  DOMAIN-KEYWORD googlevideo    代理组·媒体
  GEOIP          CN             直连
  MATCH          —              兜底分流
 ─ rule-providers ─
  reject-list   http   1204 条   2h 前   [u 更新]
```

- 过滤：类型（可循环切换）、关键字（`/` 进入搜索）。
- `Enter`：展开规则详情（payload、命中后出口、来源 provider）。
- `t`：规则测试，输入域名/IP，高亮命中行并显示最终出口组。
- `u`：在 rule-provider 行上触发更新。

### 4.3 规则测试

优先走内核接口（若存在 `GET /rules/test?target=` 之类）。**若不存在**，用 `rules/matcher.ts` 在本地按 mihomo 规则语义做前缀匹配：

- 支持：`DOMAIN` / `DOMAIN-SUFFIX` / `DOMAIN-KEYWORD` / `IP-CIDR` / `GEOIP` / `MATCH`。
- 不支持：`PROCESS-NAME`、`RULE-SET`（依赖内核运行时数据）——这类规则测试时标注「需内核判定」，不给误导性结果。
- 纯函数，输入 `(rules, target)` 输出命中规则索引，单测覆盖。

### 4.4 临时禁用（降级策略）

mihomo 的 External Controller **不一定**提供单条规则禁用接口。实施时按以下顺序确认：

1. 若内核支持（如 `PATCH /rules/{index}` 或等价），走 API，纯运行时。
2. 若不支持，本版**不做禁用**，只在 UI 上提供「标记/隐藏」本地状态（不传给内核），并在 spec 实施记录里注明。**不**为了禁用去写 config.yaml。

---

## 5. 本地节点

### 5.1 存储

`~/.config/mihomo-tui/local-proxies.yaml`：

```yaml
proxies:
  - name: my-ss
    type: ss
    server: 1.2.3.4
    port: 8388
    cipher: aes-256-gcm
    password: "***"
  - name: my-trojan
    type: trojan
    server: example.com
    port: 443
    password: "***"
    sni: example.com
```

- 原子写（`.tmp` + `rename`），与 `subscriptions.ts` 同一模式。
- 文件权限 `0600`（含密码）。
- 不进 git、不进订阅历史。

### 5.2 挂载方式

骨架注入：

```yaml
proxy-providers:
  local:
    type: file
    path: ~/.config/mihomo-tui/local-proxies.yaml
    health-check: { enable: true, url: ..., interval: 300, lazy: true }
```

节点修改后调用 `PUT /providers/proxies/local` 触发内核重新读取该文件，**无需重启**。

### 5.3 表单与校验（`localproxy/schema.ts`）

| 协议 | 必填字段 | 校验要点 |
|------|---------|---------|
| ss | server, port, cipher, password | cipher 白名单（aes-256-gcm / chacha20-ietf-poly1305 等） |
| trojan | server, port, password | 可选 sni / skip-cert-verify |
| vmess | server, port, uuid, alterId, cipher | uuid 格式、alterId 整数 |
| vless | server, port, uuid | 可选 flow / tls |

- 校验失败不落盘，表单内红字提示。
- 「原始 YAML」兜底：允许粘贴一段 `proxies:` 片段，解析后逐条过校验，非法条目行级汇报。

### 5.4 导入 / 导出

- 导出：`local-proxy export > nodes.yaml`（明文，提示含密码）。
- 导入：`local-proxy import nodes.yaml`，与现有节点按 name 去重，冲突时询问覆盖。

---

## 6. 代理链（relay）

### 6.1 为什么必须写 config

mihomo 的 relay 组定义在 `proxy-groups`，External Controller 没有「新增代理组」的热更新接口，只能改已有组的选中节点。所以 relay 的增删必须改 `config.yaml` 并 reload。

### 6.2 编辑模型

`relay/editor.ts` 产出 proxy-group 片段：

```yaml
- name: 落地中转
  type: relay
  proxies: [机场A-节点1, 自建落地]
```

- 列表式编辑：添加节点、上下移动、删除。
- 校验：节点名必须存在于当前代理列表；relay 至少 2 个节点；不允许环（relay 引用另一个包含自己的 relay）。

### 6.3 场景模板

| 模板 | 结构 | 说明 |
|------|------|------|
| 落地中转 | `[入口节点, 落地节点]` | 最常见两跳 |
| 多跳隐私 | `[入口, 中转, 出口]` | 三跳 |

模板只是预填，用户可再调整。

### 6.4 写入事务

复用 `ConfigManager.applyConfig`：备份 → `mihomo -t` 校验 → 原子写 → 复检 → 失败回滚 → reload。relay 编辑**不**重启 systemd 服务（与订阅变更不同，relay 只改 proxy-groups，reload 即可生效）。若 reload 失败，回滚 config 并再次 reload。

---

## 7. CLI 设计

```
proxy_tui rules ls [--type <T>] [--json]
proxy_tui rules test <host> [--json]
proxy_tui rule-provider ls [--json]
proxy_tui rule-provider update <name>
proxy_tui local-proxy ls [--json]
proxy_tui local-proxy add     # 交互式表单（或 --from yaml）
proxy_tui local-proxy rm <name>
proxy_tui local-proxy import <file> / export
proxy_tui relay ls [--json]
proxy_tui relay add --template <落地中转|多跳隐私> --name <组名>
```

全部支持 `--json`，退出码沿用现有约定（0 成功 / 1 业务失败 / 2 参数错 / 3 内核不可达）。

---

## 8. 错误处理

| 场景 | 行为 |
|------|------|
| 内核无 `/rules` 接口 | 规则页显示「内核不支持」，不崩溃 |
| 规则测试遇到 RULE-SET | 标注「需内核判定」，不返回误导结果 |
| 本地节点校验失败 | 不落盘，表单内提示 |
| `local-proxies.yaml` 损坏 | 拒绝加载并提示，不覆盖原文件 |
| relay 节点名不存在 / 成环 | 校验阶段拒绝，不写 config |
| relay reload 失败 | 回滚 config + 再次 reload |
| 本地节点热更新失败 | 文件已写入但内核未加载，提示手动 reload |

---

## 9. 与 references/ 的借鉴关系

| 参考 | 借鉴点 |
|------|-------|
| mihari `internal/tui/pages/rules/model.go` | 规则页的「过滤 + 类型/目标双维度 + provider 分区」布局；本项目用 Ink 重实现，不照搬 bubbletea |
| mihari `internal/cli/rules.go` | `rules list` 的只读 CLI 形态与 `--json` 输出，本项目对齐其「只读优先」原则 |
| mihari `internal/core/config.go` | 配置生成时保留用户自定义 proxy-groups 的思路，对应本项目 relay 组「按名保留、不覆盖」 |
| 本项目 `subscriptionService.ts` | relay 写 config 的事务直接复用其「备份/校验/回滚」契约，不另起一套 |

---

## 10. Execution Checkpoints

| # | Checkpoint | 交付物 | 验证 |
|---|-----------|-------|------|
| 1 | API 客户端补齐 rules / rule-providers | `client.ts` + 类型 + 单测（mock fetch） | 对真实 mihomo 调通 `GET /rules` |
| 2 | 规则匹配纯函数 | `rules/matcher.ts` + 单测 | DOMAIN/IP-CIDR/MATCH 命中正确，RULE-SET 返回「需内核判定」 |
| 3 | 规则页 TUI | `views/Rules.tsx` | 过滤、测试、provider 更新可用 |
| 4 | 本地节点存储 + 校验 | `localproxy/schema.ts` + `store.ts` + 单测 | 四协议校验、原子写、0600 权限、损坏文件不覆盖 |
| 5 | 本地节点挂载 + 热更新 | 骨架注入 + `PUT /providers/proxies/local` | 添加节点后不重启即可在组里选到 |
| 6 | relay 编辑 + 模板 + 写盘事务 | `relay/editor.ts` + 复用 ConfigManager | 成环/节点不存在被拒；reload 失败回滚 |
| 7 | CLI 全套 + README | `commands/*.ts` | 各命令 `--json` 与退出码符合约定 |

---

## 11. 验证方案

- **单测**：`matcher.ts`、`schema.ts`、`store.ts`、`editor.ts` 覆盖率 ≥ 90%；重点测校验拒绝路径与成环检测。
- **API mock**：rules / rule-providers 用 mock fetch，不依赖真实内核。
- **手测**：
  1. 规则页过滤 + 域名测试命中预期规则。
  2. 表单加一个 SS 节点，`proxy_tui proxy ls` 能看到，不重启内核。
  3. 用「落地中转」模板建 relay，reload 后 `proxy_tui proxy ls` 出现该组。
  4. 故意写一个成环 relay，确认被拒绝且 config 未被改动。

---

## 12. 兼容性与迁移

- 不改 `subscriptions.json` 结构。
- `local-proxies.yaml` 不存在时骨架不注入 `local` provider，行为与现在完全一致。
- relay 组按名字保留：已有手写 relay 组不会被骨架覆盖。
- 旧 config 无 `rule-providers` 时规则页只显示静态 rules。

---

## 13. 开放问题

1. **规则临时禁用的内核支持**：需实测 mihomo External Controller 是否有单条规则禁用接口；没有则本版降级为只读（§4.4）。
2. **规则测试接口**：内核是否提供服务端匹配接口，决定 `matcher.ts` 是主力还是兜底。
3. **本地节点密码存储**：v0.4.0 明文存 `local-proxies.yaml`（0600）。是否后续加密，留待单独立项。
4. **relay 与订阅节点的联动**：订阅更新后节点名变化可能导致 relay 引用失效，是否在订阅事务里校验 relay 引用完整性。
5. **新协议表单**：Reality / Hysteria2 等是否在 v0.4.x 补齐，还是长期走「原始 YAML」兜底。

---

**规范完。待评审 → 进入实施。**
