---
doc_type: dev_task
task_id: subtask-39aa6a8addc5
title: D7 · Codex 全局状态投影与后端接线缝
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-workbench-ui-refit-001
section_id: pr3-codex-global-state
order: 3
implementation_owner: ccb_codex
dependencies: []
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-workbench-ui-refit-001.json
source_draft_hash: 539ebf4a8c5b66964ac2fa8fc30c204413962ad59f4434dc555ca2b11972a8a6
created_at: 2026-08-16T15:13:00.518Z
updated_at: 2026-08-17T01:41:54.919Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-workbench-ui-refit-001","branch":"ccb/req-suduo-v2-workbench-ui-refit-001"}
---

# D7 · Codex 全局状态投影与后端接线缝

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 让 threadId 为 null 的官方全局通知不再被 ingestor 丢弃，落成内存投影供设置页状态条消费；同时建立 http/routes 接线缝，供后续后端片挂载各自端点。 |
| 需求来源 | suduo-v2-workbench-ui-refit-001 |
| 本期范围 | pr3-codex-global-state · D7 · Codex 全局状态投影与后端接线缝 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### D7 · Codex 全局状态投影与后端接线缝

#### 任务概述

设置页顶部要有一条状态条，回答用户最常来设置页问的那个问题——「现在到底是好是坏」。它依赖四类 Codex 官方通知：配置告警 `configWarning`、Skills 变更 `skills/changed`、MCP 状态 `mcpServerStatus/updated`、MCP OAuth 完成。

问题是这四类通知的 `threadId` **本来就可以是 null**（它们不属于任何一个会话），而 `runtime-event-ingestor.ts` 关联不到 session 就直接丢弃。也就是说：如果不做这一片，状态条、MCP 故障提示、配置告警会**全部静默失效**——界面上什么都不显示，用户以为一切正常。只给 normalizer 加个映射不够，事件仍然到不了投影层。

本片还顺带承担一件结构活：`http-server.ts` 是 1430 行单文件、28 条路由平铺。本期有五片要加端点，都改这一个文件必然冲突。本片作为第一个加端点的后端片，负责把 `http/routes/` 这条缝开出来。

**归属说明**：`runtime-event-ingestor.ts` 的改动原本与需求 `suduo-token-docs-runtime-noise-001` 的 4.4 撞车，用户 2026-08-16 拍板「那边避让」，由本需求承接，那边已在文档标记移交。

#### 任务分解

1. `codex-event-normalizer.ts`：暴露 `nativeType`。现在所有未映射方法一律归 `runtime.unknown`，没有区分力，白名单判定无从下手。
2. 新增 `client/server/src/application/codex-global-state.ts`：订阅无 `threadId` 的官方通知，落**内存投影**（不进 DB，重启重建）。
3. `runtime-event-ingestor.ts`：按 R4′ 双条件识别全局事件后分流到全局投影；不满足条件的未知无关联事件**仍然抛错**。
4. 新增 `GET /api/v1/codex/status`（SSE）供设置页读取全局状态。
5. **建接线缝**：新增 `client/server/src/infrastructure/http/routes/` 目录与 `registerCodexStatusRoutes(server, deps)` 范式；`http-server.ts` 只加 1 行注册。存量 28 条路由**不迁**（不做无关重构）。`server-application.ts` 只加本片 service 的装配行。

#### 继承约束（来自 suduo-token-docs-runtime-noise-001，不得弱化）

| 规则 | 内容 |
|---|---|
| R3′ | 未知无关联 runtime 事件**必须继续抛错**并进 `onError`，保住 codex 进程死因等排查线索 |
| R4′ | 已知全局事件判定须**同时**满足：`payload.extensions.codex.nativeType` 命中白名单 **且** 无 `threadRef`/`sessionHint`。缺一不可——纯结构性判定会吞掉真正无关联的故障 |
| R5′ | 白名单**只收已证实项**。继承两项：`configWarning`、`remoteControl/status/changed`；本片新增前须逐项实测：`skills/changed`、`mcpServerStatus/updated`、MCP OAuth 完成通知 |

#### 验收标准

- **双向单测**（继承那边的，不得只做一半）：已知全局事件不报错 ＋ 未知无关联事件仍报错。
- **本需求新增一条**：已知全局事件**到达投影且可被 `/api/v1/codex/status` 读出**——「不报错」不算完成。
- R5′ 白名单里每一项都有实测记录（实际触发过、抓到过 `nativeType` 原文），不得凭方法名推断。实测须在**隔离 `CODEX_HOME` 的确定性夹具**下进行；夹具与触发脚本随片提交、可重复执行，`nativeType` 原文证据落到仓库内固定位置，不接受一次性手工记录。pr10／pr12 的告警类验收复用同一套夹具。
- `http/routes/` 缝可用：`http-server.ts` 中本片只新增 1 行注册。
- 既有会话事件投影行为零变化（R7）。

#### 边界

- 不动 `event-projection/` 的语义、审批链路、`thread/*`、`turn/*`（R7）。
- 全局投影**不进数据库**，重启重建即可，不要引入持久化。
- 不迁移 `http-server.ts` 存量 28 条路由。
- 设置页状态条的界面归 pr10，本片只提供数据面。

#### 依赖

无。可与 pr1/pr2 并行。

## 三、执行顺序 / 里程碑

- 前置依赖: 无
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
- Section: pr3-codex-global-state
- Owner: ccb_codex
- Priority: high
- Dependencies: none

## 审查记录 · 2026-08-16（ccb_claude）

**Review decision: pass** — 归档。

执行：slot2_codex，job `job_5301a7351c9e`，commit `2151069`，10 文件 +734/-3。

### 逐条验收判定

| # | 验收标准 | 判定 | 证据 |
|---|---|---|---|
| 1 | 双向单测：已知全局事件不报错 ＋ 未知无关联仍报错 | **pass** | `codex-global-state.test.ts` 三例：白名单事件入投影、`not/known` 仍 `toThrow`、带 `threadRef`/`sessionHint` 不分流 |
| 2 | 已知全局事件到达投影且可从 `/api/v1/codex/status` 读出 | **pass** | `http.test.ts` 真实起服务读 SSE，断言 `content-type: text/event-stream`、`event: status`、`configWarning` |
| 3 | R5′ 白名单每项有隔离夹具实测记录 | **pass** | `codex-global-notifications.evidence.json`：codex-cli 0.147.0，`skills/changed` 有触发法与原文；未证实项**明确不收** |
| 4 | `http/routes/` 缝可用，`http-server.ts` 只加 1 行注册 | **pass** | diff 实核：`+registerCodexStatusRoutes(server, dependencies);` 单行 + import 块；存量 28 路由未迁 |
| 5 | 既有会话事件投影零变化（R7） | **pass** | diff 未触 `event-projection/`／`thread/*`／`turn/*`／审批链路；既有 82 测试全绿 |

### 三条继承约束核验

- **R3′ 保住**：`runtime-event-ingestor.ts` 的 throw 原样保留在全局分流之后，未知无关联事件仍抛错并带 payload 前 500 字符。
- **R4′ 双条件**：`isCodexGlobalEvent()` 要求 `nativeType` 命中白名单 **且** `threadRef === null && sessionHint === undefined`，缺一即 false，落回抛错路径（fail-safe）。
- **R5′ 只收已证实**：白名单终值 3 项（`configWarning`、`remoteControl/status/changed`、`skills/changed`）。

### 审查方独立验证（未采信回执）

`pnpm build` / `typecheck` / `lint` 全 exit 0；`pnpm --filter @suduo/client-server test` **82/82 passed（19 文件）**。diff 实核确认无 migration、无 `.sql`、无持久化。`~/.codex` 未被触碰。

### 遗留缺口（不是本片缺陷，但必须往下游带）

`mcpServerStatus/updated` **未进白名单**：隔离 0.147.0 夹具下 `mcpServerStatus/list` 能读到本地 stdio responder，但**未观测到状态变更通知发出**。按 R5′「只收已证实项」，不猜测收录是正确处置。

**后果**：设置页状态条的 MCP 一栏在补上实测前不会有数据。**pr10（状态条界面）与 pr12（MCP 设置页）必须知道这个数据面缺口，不要按"后端已就绪"设计**。OAuth 完成通知同理，已在 `codex-global-state.ts` 留具名扩展点（`mcpServer/oauthLogin/completed`）。

剩余风险：全局投影为进程内存态，重启后需 Codex 重新通知才重建——符合 spec「不进 DB」的既定取舍。
