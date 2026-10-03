---
doc_type: dev_task
task_id: subtask-a0e42cd07727
title: E-a · MCP 服务器管理后端
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: medium
requirement_id: suduo-v2-workbench-ui-refit-001
section_id: pr11-mcp-backend
order: 11
implementation_owner: ccb_codex
dependencies: [subtask-39aa6a8addc5, subtask-0fbe7dd923c7, subtask-2d21da6ae36f]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-workbench-ui-refit-001.json
source_draft_hash: 539ebf4a8c5b66964ac2fa8fc30c204413962ad59f4434dc555ca2b11972a8a6
created_at: 2026-08-16T15:13:00.518Z
updated_at: 2026-08-17T10:00:23.232Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-workbench-ui-refit-001","branch":"ccb/req-suduo-v2-workbench-ui-refit-001"}
---

# E-a · MCP 服务器管理后端

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 新增 mcp-service 与 7 个端点，CLI 负责增删、RPC 负责状态与 OAuth，env 变量引用一律经 config/batchWrite 写 env_vars。 |
| 需求来源 | suduo-v2-workbench-ui-refit-001 |
| 本期范围 | pr11-mcp-backend · E-a · MCP 服务器管理后端 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### E-a · MCP 服务器管理后端

#### 任务概述

MCP 是全仓唯一零实现的能力（现在只在 `dev/UIKitPage.tsx` 里出现过字样）。本片把后端做出来。

接入方式按 D1：**不预设 CLI 优先或 RPC 优先，逐件事看官方给了哪个口子就用哪个**——两者都是同一个 `codex` 二进制的官方能力。

```
增删          → codex mcp add / remove          CLI
详情          → codex mcp get --json            CLI
状态/连通     → ListMcpServerStatus             RPC（只有 RPC 有）
OAuth 登录    → McpServerOauthLogin             RPC（只有 RPC 有）
重载复检      → McpServerRefresh                RPC
登出          → codex mcp logout                CLI
env 变量引用  → ConfigBatchWrite 写 env_vars    RPC
```

**一个容易写错的点**：`codex mcp add --env` 收的是 **`KEY=VALUE` 字面值**，会把密钥明文写进 `transport.env`——它不是变量名。只有经 `config/batchWrite` 写 `mcp_servers.<name>.env_vars=["LOCAL_TOKEN"]`，`codex mcp get --json` 才返回变量名。所以 **stdio 的 add 一律不带 `--env`**，环境变量引用全部由 RPC 写。HTTP 的 `--bearer-token-env-var` 本来就是变量名，可以直接用。

#### 任务分解

1. 新增 `client/server/src/application/mcp-service.ts`：CLI 侧用**异步 spawn + 超时 + 输出上限**，并按配置加**串行 mutex**（多个写操作同时改同一份配置会互相覆盖）；RPC 侧复用 pr4 在 `codex-runtime.ts` 建好的面。全程携带 SuDuo 隔离的 `CODEX_HOME`。
2. 七个端点，按 pr3 的缝落到 `http/routes/mcp-routes.ts`：
   - `GET /api/v1/mcp/servers`（列表 + 运行状态）
   - `POST /api/v1/mcp/servers`（新增）
   - `GET /api/v1/mcp/servers/:name`（详情）
   - `PATCH /api/v1/mcp/servers/:name`（编辑）
   - `DELETE /api/v1/mcp/servers/:name`（删除）
   - `POST /api/v1/mcp/servers/:name/login`（OAuth，返回授权 URL）
   - `POST /api/v1/mcp/servers/:name/logout`
   - `POST /api/v1/mcp/refresh`（重载并复检）
3. **编辑的已知限制**：`codex mcp` 无 `edit` 子命令。编辑 = `config/batchWrite` 原子改写；RPC 不可用时降级为 remove+add，并在响应里明示「非原子，失败需重建」，让界面能如实告知。
4. `client/contracts`、`cloud/contracts` 追加 `McpServerDto`、`McpServerStatusDto`（传输类型、env 变量名列表、启动状态、失败原因、认证状态、工具数、`enabled`）。只追加类型，不改既有类型。
5. 启动失败时透出官方 `startupFailureReason` **原文**，不静默、不改写成自造文案。
6. OAuth 完成通知走 pr3 的全局投影（`McpServerOauthLoginCompletedNotification` 的 `threadId` 为 null）。

#### 验收标准

- server 侧 vitest：CLI 调用参数拼装（**断言 stdio 的 add 不带 `--env`**）、RPC 状态映射、超时与输出上限生效、串行 mutex 下并发写不互相覆盖。
- 端到端验证一台 stdio 服务器：add → `config/batchWrite` 写 `env_vars` → `codex mcp get --json` 能读回**变量名**（不是值）。
- 启动失败的服务器，接口返回官方 `startupFailureReason` 原文。
- RPC 不可用时编辑降级路径可走，且响应标明非原子。
- 密钥/token 不出现在任何日志、响应或配置的明文位置（R4）。

#### 边界

- **不**自建 MCP 客户端，**不**自行解析或写入 `config.toml`（R3）。
- **不**做 `codex plugin` 与 marketplace 相关能力。
- 超时、工具 allow/deny 之类属「高级」，本片提供接口但不进主表设计。
- **本期限制（已穷举 CLI 与 schema 面确认）**：除「环境变量引用 + OAuth」外，0.143 **没有**「用户输入任意 MCP 密钥、由 Codex 统一安全保管」的官方接口。所以需要密钥的 stdio 服务器，值必须来自系统环境变量——非技术成员无法自助配置。本期只在接口层面支持变量名引用，本机密钥保管留待后续需求。需要 OAuth 的服务器不受此限。
- 界面归 pr12。

#### 依赖

pr3（全局投影承接 OAuth 完成通知 + `http/routes` 缝）、pr4（`codex-runtime.ts` 的 RPC 面）、pr5（中央装配串行链的最后一环——前序全部落定后再加本片的路由与 `server-application.ts` 装配行）。

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-39aa6a8addc5, subtask-0fbe7dd923c7, subtask-2d21da6ae36f
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
- Section: pr11-mcp-backend
- Owner: ccb_codex
- Priority: medium
- Dependencies: subtask-39aa6a8addc5, subtask-0fbe7dd923c7, subtask-2d21da6ae36f

## 审查记录 · 2026-08-17（ccb_claude）

**Review decision: pass（含一条上游能力缺口豁免）** — 归档。

执行：slot2_codex，job `job_28b36137882d`，commit `4ad701d`，9 文件 +1771/-1。

### 逐条验收判定

| # | 验收标准 | 判定 | 证据 |
|---|---|---|---|
| 1 | CLI 参数拼装（**断言 stdio add 不带 `--env`**）、RPC 状态映射、超时与输出上限、mutex 并发 | **pass** | `mcp-service.test.ts:28`「stdio add 从不带 --env」+ `expect(add?.args).not.toContain("--env")`；`:216` 并发 add 不重叠；256KiB 上限与超时均有覆盖 |
| 2 | 端到端 stdio：add → `batchWrite(env_vars)` → `get --json` 读回**变量名** | **pass** | 隔离实测通过，读到的是 `LOCAL_TOKEN` 名称而非值 |
| 3 | 启动失败返回官方 `startupFailureReason` 原文 | **豁免（上游缺口）** | 见下 |
| 4 | RPC 不可用时编辑降级可走且标明非原子 | **pass** | `mcp-service.ts:261` 返回 `atomic: false` 与「已用 Codex CLI 非原子替换；若后续步骤失败，请按原配置重建服务器。」 |
| 5 | 密钥/token 不出现在日志、响应或配置明文（R4） | **pass** | stdio 路径根本不传 `--env`，值无从进入配置；HTTP 用 `--bearer-token-env-var`（本就是变量名） |

### 验收 3 的豁免依据（审查方独立复验，未采信回执）

执行方报「0.143 不提供失败原文」。我自己起隔离 `CODEX_HOME` 实测：

```
codex mcp add broken -- /nonexistent/command
codex mcp get broken --json   → 无任何失败字段（只有 transport/enabled/timeout 等静态配置）
RPC mcpServerStatus/list      → { name: "broken", serverInfo: null, tools: {},
                                  resources: [], authStatus: "unsupported" }
```

**`serverInfo` 为 `null`，整个响应里没有任何失败原因字段。** codex 0.143 确实不暴露 `startupFailureReason`。

执行方返回 `unknown/null` 而**不伪造一个自造文案**是正确处置——与 spec 第 5 点「不静默、不改写成自造文案」的原意一致：既然官方没给，就不能假装有。

**这是本批次第四次遇到同类情形**（pr7 附件/评论数、pr8 会话删除、pr10 skill 启用态），处置一致：能做的做完，做不到的如实记账，绝不伪造数据糊弄验收。

### `mcpServerStatus/updated` 白名单：仍未观测到

我在派工时给了机会——若本片实测到该通知发出，就补进 pr3 的白名单，让 pr10 状态条的 MCP 一栏从「未知」转为真实计数。

执行方回报：**工作与失败服务重载均未实际发出该通知**，故白名单与 evidence 未改。这符合 R5′「只收已证实项」，**没有因为本片正好在做 MCP 就放宽原则**。状态条 MCP 一栏继续显示「未知」是当前唯一诚实的呈现。

### 边界核查

`http-server.ts` 3 处功能接线（import + 接口 extends + 条件注册，共 9+/1-）｜`server-application.ts` 7 行装配｜contracts **纯追加** `McpServerDto`/`McpServerStatusDto`｜未自建 MCP 客户端、未自行解析或写 `config.toml`（全走官方口子，R3）｜未动 `client/web/src/`｜未碰 `/home/sue/.codex`。

### 审查方独立验证

`build`/`typecheck`/`lint` 全 exit 0；**server 114/114**（较 pr10 后的 103 净增 11）；contracts 3/3；`protocol:diff` clean。

### 交接给 pr12

1. **界面不能显示「失败原因」**——后端拿不到，字段恒为 `unknown/null`。如实呈现为「已配置但未成功启动，Codex 0.143 未提供原因」，不要编一个。
2. 编辑走非原子降级时，响应带 `atomic: false` 与提示原文，**界面必须把这条告知用户**。
3. **非技术成员无法自助配置需要密钥的 stdio 服务器**——0.143 没有「用户输入密钥、Codex 统一保管」的官方接口，值必须来自系统环境变量。界面要说清这个限制，不要做一个填了没用的密钥输入框。OAuth 类服务器不受此限。
