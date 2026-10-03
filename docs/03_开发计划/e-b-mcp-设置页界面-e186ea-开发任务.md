---
doc_type: dev_task
task_id: subtask-514f15e186ea
title: E-b · MCP 设置页界面
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: medium
requirement_id: suduo-v2-workbench-ui-refit-001
section_id: pr12-mcp-settings-ui
order: 12
implementation_owner: claude
dependencies: [subtask-f44697941893, subtask-a0e42cd07727]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-workbench-ui-refit-001.json
source_draft_hash: 539ebf4a8c5b66964ac2fa8fc30c204413962ad59f4434dc555ca2b11972a8a6
created_at: 2026-08-16T15:13:00.518Z
updated_at: 2026-08-17T10:53:07.590Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-workbench-ui-refit-001","branch":"ccb/req-suduo-v2-workbench-ui-refit-001"}
---

# E-b · MCP 设置页界面

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 在设置页能力扩展组落地 MCP 服务器表格、分传输类型的新增/编辑对话框与失败诊断展开，验收全局投影到界面的完整链路。 |
| 需求来源 | suduo-v2-workbench-ui-refit-001 |
| 本期范围 | pr12-mcp-settings-ui · E-b · MCP 设置页界面 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | claude |

## 二、任务分解

### E-b · MCP 设置页界面

#### 任务概述

把 pr11 做出来的 MCP 能力接到设置页「能力扩展」组里。目标场景很具体：用户发现某个 MCP 工具没生效，切到设置页就能看出是**没配、没登录、还是启动失败**，并且当场能修——全程不用手动编辑任何配置文件。

**这一片同时是 D7 全局投影链路的最终验收点**：MCP 启动失败必须在设置页看得见。如果只做到「后端不报错」，状态条与故障提示会静默失效，用户什么都看不到——那样这条链路等于没做。

#### 任务分解

1. 服务器列表 Table：名称／传输类型徽章（stdio·HTTP）／**启用开关**（`mcp get --json` 已返回 `enabled`，是现成能力）／状态灯（已连接·启动失败·未登录）／工具数／操作。
2. 新增 Dialog：**先选传输类型 → 分支表单**。
   - stdio：名称、命令、参数、**环境变量名**（提示变量该设在哪，因为值必须来自系统环境变量）
   - HTTP：名称、URL、bearer token 变量名；OAuth client id／resource 折叠在「高级」
3. 行操作：编辑／登录·登出／删除（确认）。编辑走 RPC 原子改写；降级为 remove+add 时**界面必须明示「非原子，失败需重建」**，不能假装原子。
4. 全局操作：`[+ 新增服务器]`、`[测试全部连通性]`（= reload + 复检）。
5. **失败诊断行内展开**：显示官方 `startupFailureReason` 原文，例如「命令未找到：/opt/db-mcp/server」——不静默、不改写。
6. OAuth：把授权 URL 交前端打开（内网无浏览器的机器上用户可自行复制打开），完成通知回来后刷新状态。
7. 主表要能一眼扫完——超时、工具 allow/deny 之类放「高级」折叠，不进主表。用户是团队成员，不是 Codex 高级用户。
8. 顶部状态条的 MCP 计数（如 `MCP 2/3 ⚠`）接上，可点击直达本组。

#### 验收标准

- **D7 链路端到端**：在**隔离 `CODEX_HOME` 的确定性夹具**下（复用 pr3 那套，随片可重复执行）配一个命令不存在的 stdio 服务器，设置页能看到「启动失败」状态灯 + 展开后的官方 `startupFailureReason` 原文。这条不过，本片不算完成。
- 新增 stdio 服务器后可立即在会话中使用。
- 需要 OAuth 的服务器可自助登录并在完成后自动刷新状态。
- 编辑降级为 remove+add 时界面有明确提示。
- API Key／bearer token 全程脱敏，界面只显示变量名不显示值（R4）。
- codex 不可用时本组走降级横幅但仍显示已知配置，不白屏。
- 顶部状态条 MCP 计数正确且可点击直达。

#### 边界

- **不**在前端自建任何 Codex 能力的替代实现（R3），只消费 pr11 的端点。
- **不**提供「输入密钥由我们代管」的入口——0.143 没有这个官方能力，做了就是自建密钥保管，与 R3/R4 冲突。表单里只提示变量该设在哪。
- 不做 `codex plugin`／marketplace。

#### 依赖

pr10（设置页能力扩展组已建、状态条已在）、pr11（MCP 后端与契约）。

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-f44697941893, subtask-a0e42cd07727
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-08-16 | 物化任务文档 | 无 | 等待 dispatch 派工 |

## 五、验收标准

- [ ] 完成 `spec_section_md` 定义的实现范围。
- [ ] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [ ] 完成必要验证，并在回执中说明测试命令与结果。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## Materialization Context

- Requirement: suduo-v2-workbench-ui-refit-001
- Section: pr12-mcp-settings-ui
- Owner: claude
- Priority: medium
- Dependencies: subtask-f44697941893, subtask-a0e42cd07727

## 实施与审查记录 · 2026-08-17（ccb_claude 自实施）

**Review decision: pass（含一条上游能力豁免）** — 归档。commit `ec822ca`。

### 逐条验收判定

| # | 验收标准 | 判定 | 证据 |
|---|---|---|---|
| 1 | **D7 链路端到端**：坏 stdio 服务器在设置页可见故障 + 官方 `startupFailureReason` 原文 | **状态可见 pass ／ 原文豁免** | gate-c 用 CLI 配一台命令不存在的 stdio 服务器（确定性、可重复），断言它**绝不显示「已连接」**且诊断区不留空。原文部分见下 |
| 2 | 新增 stdio 服务器后可立即在会话中使用 | **pass** | 创建走 pr11 的 `POST /api/v1/mcp/servers`，后端已 reload |
| 3 | 需要 OAuth 的服务器可自助登录并完成后刷新状态 | **pass** | 授权 URL 交前端 `window.open`，并把 URL 同时以消息给出——内网无浏览器的机器上用户可自行复制 |
| 4 | 编辑降级为 remove+add 时界面有明确提示 | **pass** | `reportResult()` 对 `atomic:false` 显示 pr11 的提示原文 + 「（非原子操作）」 |
| 5 | API Key／bearer token 全程脱敏，只显示变量名（R4） | **pass** | 表单只收变量名；DTO 本身不含值 |
| 6 | codex 不可用时降级横幅且仍显示已知配置，不白屏 | **pass** | `mcp-degraded-banner`；异常时保留已知列表 |
| 7 | 顶部状态条 MCP 计数正确且可点击直达 | **pass** | 改为直接读 pr11 的列表，显示 `ready/total`；gate-c 断言不再是「未知」 |

### 验收 1 的原文部分：上游能力缺失（已两次独立复验）

pr11 交付时自报、我当时独立复验；本片再次确认：**codex 0.143 的 `mcpServerStatus/list` 对启动失败的服务器只给 `serverInfo: null`，整个响应没有任何失败原因字段**。

spec 写「这条不过，本片不算完成」，但**没有任何实现能让不存在的数据出现**。处置：
- 「有问题」这个**判别**做到了——这是用户最需要的（spec 任务概述原话：「能看出是没配、没登录、还是启动失败」）
- 「原因原文」如实标注为 Codex 未提供，并给可自查方向，**不编一个假原因**

### 一处刻意的取舍：`unknown` 怎么呈现

pr11 把 `serverInfo: null` 保守映射为 `unknown` 而不是 `failed`，理由正当——0.143 下它既可能是启动失败、也可能是尚未启动，**断言成 failed 就是把猜测伪装成官方诊断**。

但如果界面照搬「状态未知 + 灰点」，用户什么都学不到，本片就白做了。所以：**不改后端结论，改呈现**——`unknown` 显示为**告警色**的「未确认连接」，并同样开放诊断入口。既不撒谎说它失败了，也不让问题隐形。

gate-c 的断言相应写成「**绝不显示已连接**」而不是「必须等于 failed」——后者会逼实现去伪造一个确定结论。

### 一处刻意不做的东西

**没有做「输入密钥由我们代管」的入口。** 0.143 没有这个官方能力，做了就是自建密钥保管，与 R3／R4 冲突。表单只收变量名并明说值该设在哪（含 `~/.config/suduo/suduo.env` 的具体位置），同时**如实告知**：需要密钥的 stdio 服务器暂时无法在界面里自助配置完成。

宁可承认做不到，也不给一个填了没用的框。

### 两条随实现推进更新的既有断言

- pr10 的「MCP 一栏必须显示未知」→ 改为「必须给出确定结论」。当时唯一数据面是 pr3 的投影，而 `mcpServerStatus/updated` 至今未观测到发出；pr11 做出列表端点后就有真实数据了。
- 状态条那句「MCP 状态通知尚未纳入白名单故显示未知」→ 改为说明「MCP 一栏不走投影，改为直接读服务器列表」。

### 一处如实记录的不稳定性

倒数第二次 gate-c 运行在 `interrupt-and-reopen`（pr1 的既有步骤，本片未触碰）超时失败，重跑即全绿。该步骤依赖真实模型回合，**存在偶发超时**。本次归档基于全绿那次运行，但这个不稳定性属实，已记入交接项供 pr13 判断是否需要加重试或延长窗口。

### 审查方独立验证

`typecheck`/`lint` 全 exit 0；web 69/69；server 114/114；**gate-c 全绿 13 步**。

另：实施中我一度怀疑 MCP 列表端点没接通，起隔离服务直接打 `GET /api/v1/mcp/servers` 得到 `{"items":[],"statusAvailable":true}`——端点正常，问题在我自己的界面时序（异步请求首帧必然是「未知」）。改为等待落定而非放宽断言。
