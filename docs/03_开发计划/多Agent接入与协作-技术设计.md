---
id: suduo-design-multi-agent-001
title: 多 Agent 接入与协作 技术设计（P1 + P2）
doc_type: technical_design
requirement_id: suduo-requirement-multi-agent-001, suduo-requirement-multi-agent-collab-001
expression_spec: v1
updated: 2026-10-09
---

# 多 Agent 接入与协作 技术设计（P1 + P2）

> 需求：[P1 多 Agent 接入与本机工具服务](../02_需求设计/多Agent接入与本机工具服务-需求.md)、[P2 多 Agent 协作机制](../02_需求设计/多Agent协作机制-需求.md)｜母需求：[v3 规划](../02_需求设计/v3-多AI工具与多Agent协作规划-需求.md)
>
> 决策：ADR-0014（接入架构）、ADR-0015（工具层改为本机 MCP）、ADR-0016（凭据边界）、ADR-0017（协作核心模型），均为 proposed。
>
> 术语：界面上的「讨论」在代码里叫「房间」；「子任务」指被委派出去的那件事，执行它的会话叫「子会话」；SuDuo 给 Agent 的工具统称「SuDuo 工具」，分「需求工具」与「协作工具」。
>
> 输入：Tutti 源码研读（本机 `/Volumes/Sue-SSD/Dev/tmp/suduo/research/tutti`）；SuDuo「Codex 假设」耦合地图（2026-10-08）。用户要求 P1、P2 一起规划、一起做（2026-10-08）。

---

## 一、设计概述

**要做的事**：

- **P1 接入**：在 `client/server` 里按 Agent 配置表装配多个运行时（Codex 现有、Claude Agent SDK、ACP 通用）；把事件条目、审批载荷、权限档位改成 SuDuo 契约自有的模型（字段以 Codex 为基线）；需求工具从 Codex `dynamicTools` 迁到本机 MCP 服务；云端放开共享 Agent 的种类。
- **P2 协作**：在同一地基上加会话图（角色与关系）、本机调度器（并发上限与排队）、上下文服务（句柄与分层读取）、协作工具（读会话、委派、评审、交接）、试做组与 worktree 管理、需求共享对象与项目 AI 规范。

**为什么一起做**：P2 的每一项都依赖 P1 的三块地基——统一条目模型（跨 Agent 读会话）、本机 MCP 与会话令牌（按角色给工具）、多运行时（委派给另一家 Agent）。地基一开始就按 P2 的需要设计（会话角色字段、调度器准入），避免 P1 做完再返工。

**不变的事**：Codex 的接法（共享 app-server 进程、0.159.2 锁定、协议基线）；事件账本与 SSE 机制；需求工具的业务实现；房间任务的数据边界（ADR-0009）；已有数据不改写；独立部署形态。

---

## 二、方案与架构

```
 client/web ──REST/SSE──▶ client/server（127.0.0.1）
                           │
                           ├─ AgentCatalog（配置表）──▶ AgentStatusService（检测、版本、登录状态）
                           │
                           ├─ SessionService + SessionGraph（角色、父子、根、关系）
                           ├─ Scheduler（本机调度：每 Agent / 全部 / 房间上限，排队、插队、取消、恢复）
                           │      │ 准入后才调用 ↓
                           ├─ RuntimeRegistry（按 agentId 取运行时）
                           │    ├─ CodexRuntime      ──stdio JSON-RPC──▶ codex app-server（共享进程，捆绑 0.159.2）
                           │    ├─ ClaudeSdkRuntime  ──进程内 SDK──────▶ claude（用户自装）
                           │    └─ AcpRuntime × N    ──stdio JSON-RPC──▶ copilot / gemini / cursor-agent / opencode / qwen / kimi
                           │
                           │    同形 RuntimeEventDraft（SuDuo 条目模型）
                           ├─ RuntimeConsumer × N ─▶ Ingestor ─▶ EventLedger ─▶ EventStream（SSE）
                           ├─ ApprovalService（对象 + 可选决策 + 来源）
                           │
                           ├─ ContextService（会话卡、句柄、分层读取、读取留痕）
                           ├─ DelegationService · ReviewService · TrialService（+ WorktreeManager）· HandoffService
                           ├─ ProjectRulesService（拉取 / 缓存项目 AI 规范，按通道注入）
                           │
                           ├─ ToolMcpServer  /mcp（Streamable HTTP，会话令牌 = 身份 + 角色，独立守卫）
                           │    ├─ 需求与房间工具（现有 suduo_* 实现）
                           │    └─ 协作工具（session_* / agent_list / delegate_* / review_* / handoff_*）
                           │
                           └─ RoomAgentRunner（房间任务：按 agentId 建只读会话，经调度器准入）

 cloud/server：agents.kind 放开（016）；需求共享对象、项目 AI 规范、协作记录（017）；能力探测 agent_kinds_v2、ai_collab_v1
```

### 2.1 Agent 配置表（AgentCatalog）

`client/server/src/application/agents/catalog.ts`（新），只读数据 + 启动时校验。

| 字段 | 说明 |
|---|---|
| `id`、`displayName`、`vendor` | 例：`claude-code` / Claude Code / Anthropic |
| `channel` | `codex-app-server` / `claude-sdk` / `acp` |
| `launch` | 可执行文件名候选、参数（ACP 如 `["--acp"]`）、环境变量增减 |
| `version` | 取版本参数、最低版本 |
| `auth` | 状态检查方式（命令 + 解析器 / ACP 握手探测）、登录命令、API Key 环境变量名（只用于提示）；Claude 另有 `apiKeyOnly` 开关（ADR-0016 第 10 条，默认关） |
| `install` | 各平台官方安装命令与官网链接（只展示） |
| `models` | `codex-model-list` / `sdk-supported-models` / `acp-config-option` / `static` |
| `permissions` | 四档映射（2.4）；`readOnlyCapable` |
| `capabilities` | 图片、计划、推理摘要、用量、Skill、模型切换、中途插话、续接方式、MCP over HTTP、结构化提交工具可靠性（S0 实测） |
| `concurrency` | 默认并发上限（可被用户设置覆盖） |
| `quirks` | 启动超时、取消宽限、stdout 日志容忍、审批延迟到入参齐全、MCP 工具超时上限 |
| `terms` | 条款要点与链接，提示文案用（ADR-0016 第 9 条） |

首批：`codex`、`claude-code`、`copilot`、`gemini`、`cursor`、`opencode`、`qwen-code`、`kimi-code`。

### 2.2 统一条目模型（契约）

`client/contracts/src/items.ts`（新）定义 `SuDuoItem`，字段与 Codex `ThreadItem` 同名同形，SuDuo 只保留、文档化并版本化用到的部分：

| `type` | 用途 | 关键字段 | 来源 |
|---|---|---|---|
| `userMessage` | 用户消息 | `content[]`、`clientId` | 全部 |
| `agentMessage` | 助手消息 | `text` | 全部 |
| `reasoning` | 推理 | `summary[]`、`content[]` | Codex；Claude thinking；ACP thought chunk |
| `commandExecution` | 命令 | `command`、`cwd`、`aggregatedOutput`、`exitCode`、`durationMs`、`commandActions[]` | Codex；Claude Bash / Read / Grep / Glob；ACP execute / read / search |
| `fileChange` | 文件改动 | `changes[]{path, kind, diff}` | Codex；Claude Edit / Write / MultiEdit（hook patch）；ACP edit / delete / move、`fs/write_text_file` |
| `dynamicToolCall` | **SuDuo 工具调用**（不论经哪个通道） | `tool`（带 `suduo_` 前缀的内部名）、`arguments`、`contentItems[]`（inputText / inputImage）、`success`、`status` | Codex dynamicTools（老线程）；Codex / Claude / ACP 经 SuDuo MCP 的调用由各适配器换成这个形状（S2 实施） |
| `mcpToolCall` | 其他 MCP 工具调用 | `server`、`tool`、`arguments`、`result`、`error`、`status` | Codex MCP；Claude `mcp__*`（suduo 除外）；ACP other |
| `webSearch` | 搜索 / 抓取 | `query` | Codex；Claude WebSearch / WebFetch；ACP fetch |
| `plan` | 计划 | 文本 / 步骤 | Codex；Claude TodoWrite / ExitPlanMode；ACP plan |
| `collabAgentToolCall` | Agent 原生子 Agent | 描述、状态 | Codex；Claude Task / Agent |
| `contextCompaction` | 上下文压缩 | — | Codex；Claude compact_boundary |
| `imageView` | 查看图片 | `path` | Codex |
| `notice`（新） | 系统提示 | `level`、`text` | ACP、Claude |
| `suduoDelegation`（新，P2） | SuDuo 委派卡 | `delegationId`、`childSessionId`、`agentId`、`task`、`workspaceMode`、`status`、`resultSummary` | DelegationService 写入发起会话 |
| `suduoReference`（新，P2） | 读取留痕 | `target`（会话 / 交接包 / 评审）、`view`、`atSeq` | ContextService 写入读取方会话 |
| `suduoReview`（新，P2） | 评审结果 | `reviewId`、`reviewerAgentId`、`findings[]` 摘要 | ReviewService 写入被评会话 |

- SuDuo 工具调用在账本里只有 `dynamicToolCall` 一种形状（S2 实施时改：原计划统一成 `mcpToolCall` 再改前端；改为各适配器换形状，界面、房间进度、图片瘦身都不用动，老线程与新线程一致）。
- `extensions.<agentId>` 只供诊断，解析不得依赖。
- 事件类型不变；`ThreadRef.runtimeKind` 填通道名；会话另记 `agentId`。回合结局统一用 `turn.completed` 的 `turn.status`（`completed` / `failed` / `interrupted`）。
- `suduo*` 条目由 SuDuo 自己写入账本（来源 `system:suduo`），与 Agent 事件同一条时间线，前端按类型渲染卡片。

### 2.3 审批载荷中立化

`approval.requested` 载荷新增：`subject`（command / file / permission / question / tool，存储映射到现有 `approvals.kind` CHECK，不改约束）、`options[{id, decision, label?}]`（decision：accept / acceptForSession / acceptAlways / decline / declineAlways / cancel）、`display`（命令、目录、文件、理由）、`origin`（P2：发起该审批的会话角色与委派信息，用于「来自委派：Claude Code · 补集成测试」）。契约里 `ApprovalDecision`（现为字符串联合，`runtime.ts`）增加 `acceptAlways`、`declineAlways`；新增 `ApprovalResolution = { decision: ApprovalDecision; optionId?: string }` 作为 `approve()` 的入参。本机 `approvals.decision` 的 CHECK 只允许现有 4 个值，迁移 020 重建表放宽（做法同 `002_approval_modes.sql`）。

### 2.4 权限档位

沿用现有 `ApprovalMode`（契约 `config.ts`、本机 `sessions.approval_mode`、接口 `approvalMode`），在 `ask / auto / full` 之外增加 `readonly`；`SUDUO_MAX_APPROVAL_MODE` 照常封顶（`readonly` 低于所有档，不受影响）。

| 档位 | Codex | Claude Code（SDK） | ACP（配置表 + SuDuo 客户端策略） |
|---|---|---|---|
| 只读 | `never` + 只读沙箱 + 可联网 | `dontAsk` + `strictMcpConfig: true`（只用 SuDuo 传入的 MCP，claude.ai 账号连接器也被排除，S0 实测）+ `allowedTools` 只放行只读工具（Read、Grep、Glob、WebSearch、WebFetch、TodoWrite、SuDuo 只读工具）；`canUseTool` 其余一律拒绝；`settingSources: []`（不加载用户与项目设置，避免其 allow 规则先于 `canUseTool` 放行写入、避免带上所有者的 MCP）+ `disallowedTools` 列出写入类工具（S0 验证） | 最严格模式；`request_permission` 写入 / 执行类一律拒绝；`fs/write_text_file` 返回错误。**只有不经权限请求就能用的工具（所有者自己的 MCP、自定义工具）都被拿掉的才算做得到只读**（配置表 `readOnlyCapable`）：OpenCode 启动时注入工具白名单（其余一律 deny / 关闭，全局与 plan、build 代理级各一份）并关掉仓库配置（S6 实测） |
| 写前询问 | 现「询问」组合（`on-request` + 只读沙箱 + 不联网，写入与越权需审批） | `default` | 「询问」模式；权限请求交给用户 |
| 自动 | 现「自动」组合（`on-request` + 可写工作区 + 不联网） | `acceptEdits` | 「自动」模式；读与工作目录内编辑自动允许，执行类交给用户 |
| 完全访问 | 现「完全访问」组合（`never` + 完全访问 + 联网） | `bypassPermissions` | 「完全访问」模式；自动选允许一次 |

房间任务、评审会话显式传「只读」（删除 `codex-runtime.ts` 里按组合猜房间档的逻辑）。子会话的档位在创建时取 `min(请求档位, 父会话档位)`，被降档时在委派卡与子会话顶部显示「已按发起会话降为 X」。

### 2.5 运行时接口调整（`client/contracts/src/runtime.ts`）

| 现在 | 改为 |
|---|---|
| `StartThreadBase.security`、`StartTurnInput.security` | `approvalMode: ApprovalMode`（含 `readonly`） |
| `developerInstructions?` | 保留，内容由 ContextService 组装（角色说明 + 工具说明 + 项目规范），各适配器按通道投递 |
| `dynamicTools?` | `toolServer?: { url; token }`（角色与工具集合由令牌决定）；`dynamicTools` 仅 Codex 适配器内部服务老线程 |
| `approve()` 的 `decision` | `resolution: ApprovalResolution`（见 2.3） |
| `respondToolCall` / `isToolCallPending` | 移入 Codex 适配器内部 |
| — | 新增 `capabilities()`、`listModels?(cwd)`、`close?(sessionId)` |
| `startTurn` 直接调用 | 统一经 `Scheduler.admit(turnRequest)` 准入后调用（P2；S1 就接上，初期上限放宽） |

`RuntimeRegistry`（契约 `registry.ts` 与实现 `runtime-registry.ts`）增加 `list()`、`getByAgent(agentId)`。

### 2.6 会话图（P2）

本机 `sessions` 复用两列：`kind`（现有 normal / room_task，增加 delegate / reviewer / trial；normal 即主会话）、`approval_mode`（增加 readonly）；新增 `agent_id`、`parent_session_id`、`root_session_id`、`relation`（delegate / continue / review / trial，可空）、`relation_meta`（JSON：父回合、工具调用 ID、试做组 ID 等）、`workspace_path`（实际工作目录，试做时为 worktree）、`rules_version`。

- 引用不建关系，写 `session_references`（读取方、目标、层级、目标当时的账本序号、时间）。
- 会话列表 API 按 `root_session_id` 分组返回树。
- 删除根会话：前端询问是否连带子会话（R11）；子会话删除后保留委派记录与结果摘要。

### 2.7 本机调度器（P2）

`client/server/src/application/scheduler/`（新）。

- **准入单位是回合**：每个 `startTurn`（含首回合、委派子回合、评审、试做、房间任务）先 `admit`。准入后才调用运行时；回合结束（`turn.completed`）释放名额。
- **名额**：每个 Agent 一个计数（默认 2，配置表与用户设置可改）；全局一个计数（默认 4）；房间任务另加每个共享 Agent 1 个。
- **队列**：FIFO + 手动「先跑这个」（移到队首）+ 取消；排队项带来源（主会话 / 委派 / 试做 / 房间）。主会话的用户消息与委派同等排队（不设优先级，避免饿死；用户可插队）。
- **持久化**：排队中的委派、试做写 `delegations` / `trial_groups` 状态为 `queued`，重启后重新入队；主会话的排队回合在重启后不恢复，提示用户重发（与现在「重启中断回合」一致）。
- **停止级联**：停止某回合时，若它有运行中或排队中的子任务，前端询问是否一并停止（默认是）；调度器对子任务执行取消。
- **卡住提醒**：子任务等审批超过 10 分钟、或无事件超过 15 分钟，写一条提醒（发起会话 + 「我的工作 · 需要你处理」），不自动终止。
- **观测**：`GET /api/v1/scheduler` 返回运行中与排队中的回合（按 Agent 分组）；SSE 推送队列变化。

### 2.8 上下文服务（P2）

`client/server/src/application/context/`（新）。

- **会话卡**（开工时推送）：角色、任务说明（子会话）、需求标题 / 状态 / 链接、项目规范版本、可用句柄列表（被引用会话、交接包、评审、父会话）。按通道投递：Codex `developerInstructions`、Claude `systemPrompt.append`、ACP 首条消息前置块。
- **句柄**：`suduo://session/<id>`、`suduo://handoff/<id>`、`suduo://review/<id>`、`suduo://requirement/<id>`。用户在输入框 @ 会话时插入句柄标签；消息发送时 ContextService 在内容末尾追加一句提示「引用对象请用 SuDuo 工具读取」（对齐 Tutti 的做法，避免 Agent 去打开链接）。
- **分层读取**（从本机事件账本按统一条目模型投影，所以与 Agent 无关）：
  | 层 | 返回 | 上限 |
  |---|---|---|
  | 概要 `summary` | 最终回答、改动文件列表、状态、Agent | 4 KB |
  | 对话 `conversation` | 最近 N 轮（默认 3）的用户消息与助手回答 | 每轮 8 KB，分页 |
  | 回合列表 `turns` | 回合序号、首句、状态、时间 | 50 条分页 |
  | 回合细节 `turn` | 指定回合的命令、工具调用、文件 diff | 32 KB，超出落 `.suduo/` |
  | 改动 `changes` | 会话累计 diff（基于会话起点与当前工作目录） | 64 KB，超出落 `.suduo/` |
- **可读范围**：同一成员本机、同一 SuDuo 账号下的会话；房间任务不可读（R10）；跨成员只读需求共享对象（交接包、发布的评审、快照）。
- **留痕**：每次读取写 `session_references` 并在读取方账本写 `suduoReference` 条目；目标在被引用后又有新回合时，读取结果附「引用后新增 N 个回合」。
- **项目规范**：ProjectRulesService 从云端拉取当前版本（缓存，SSE 收到更新即刷新），开工时并入 SuDuo 说明，记 `rules_version`；进行中会话收到新版本只提示，用户点「应用」时以一条用户消息附上新规范。

### 2.9 MCP 工具集合与角色

令牌映射到 `{ sessionId, 工具清单 }`：清单在建线程时按会话角色与 scope 由下表定下（与 dynamicTools 一样随线程固定，记在线程元数据里，续接时按它重签令牌），`tools/list` 只返回清单内的工具，清单外的 `tools/call` 不执行（S2 实施：Agent 建线程时就来取清单，那时会话的需求关联还没写入，不能现查）：

| 工具 | 主会话 | 子会话 | 评审会话 | 试做会话 | 房间任务 |
|---|---|---|---|---|---|
| 需求只读（requirement_get / comments / attachments / attachment_view / notes_read） | ✓ | ✓ | ✓ | ✓ | ✓（只读需求） |
| notes_save | ✓ | ✓ | — | ✓ | — |
| comment_submit（须确认） | ✓（需求会话） | — | — | — | — |
| 房间只读（room_history / search / file_view） | ✓ | ✓ | — | — | ✓ |
| session_list / session_read | ✓ | ✓ | ✓（限被评会话与其需求） | ✓ | — |
| agent_list | ✓ | — | — | — | — |
| delegate_start / wait / send / cancel | ✓ | — | — | — | — |
| review_request | ✓ | — | — | — | — |
| review_submit | — | — | ✓ | — | — |
| handoff_read | ✓ | ✓ | ✓ | ✓ | — |
| handoff_submit | ✓ | — | — | — | — |

委派深度 1 由这张表实现：只有主会话拿到委派工具。工具名**不带** `suduo_` 前缀（S0 实测：各 Agent 会自己加服务名前缀——Codex 记为服务 `suduo` + 工具名，Claude 为 `mcp__suduo__<工具>`，OpenCode 为 `suduo_<工具>`）；老线程的 dynamicTools 仍用原名。

### 2.10 委派（P2）

- `delegate_start({ agentId, task, workspace: "same" | "isolated", permission?, files?, autoHandback? })`：检查目标就绪（委派工具只发给主会话，深度 1 由此实现，无需运行时再查角色）；建子会话（kind = delegate、档位取 min、工作目录同父或新 worktree、令牌角色 delegate）；写 `delegations`（queued）与发起会话的 `suduoDelegation` 条目；提交调度。返回 `delegationId`。
- 子会话首回合输入：任务说明 + 句柄（父会话、需求、发起者列出的文件）。
- `delegate_wait({ id, maxSeconds })`：最长 = 配置表该发起 Agent 的 MCP 工具超时减余量（目标约 240 秒）；到点返回 `{ status, progress: 最近几条条目摘要, result? }`。
- `delegate_send({ id, message })`：给子会话追加一条用户消息（经调度）。
- `delegate_cancel({ id })`：取消排队或中断运行。
- **结果**：子会话回合结束时组装 `{ finalMessage, changedFiles, diffStat, childSessionHandle }`，更新卡片；若发起会话当前回合有挂起的 `delegate_wait`，立即返回；若发起回合已结束：`autoHandback` 为真则经调度为发起会话开新回合（内容「委派结果：…」），否则卡片显示「让原 Agent 继续」。
- **审批来源**：子会话的审批载荷带 `origin`；审批坞分组显示。
- **用户发起**：会话输入框 @Agent → 前端调用 `POST /api/v1/sessions/:id/delegations`，与工具同一服务。

### 2.11 评审（P2）

- 发起：`POST /api/v1/sessions/:id/reviews { agentId, focus[] }` 或工具 `review_request`。
- 评审会话：角色 reviewer、只读、令牌给 `review_submit` 与只读工具；首回合输入：被评会话句柄 + 需求句柄 + 改动摘要（`changes` 层）+ 关注点 + 「完成后必须调用 review_submit」。
- `review_submit({ findings: [{ severity: "high"|"medium"|"low"|"info", file?, line?, title, detail, suggestion? }], summary })`：写 `review_reports`，在被评会话写 `suduoReview` 条目。Agent 未调用即结束时，评审面板显示其最终回答原文并提示「未拿到结构化意见」（R13）。
- 交回修改：选中的意见拼成一条用户消息发给被评会话（经调度）。
- 发布：生成发布预览 → 用户确认 → 云端需求共享对象（类型 review）。

### 2.12 并行试做与 WorktreeManager（P2）

- **准备**：检查工作目录是 git 仓库；`git status` 有未提交改动 → 提示并提供「先存检查点」（复用现有 git-service）；基点 = 当前 HEAD。
- **创建**：每版 `git worktree add <SuDuo 数据目录>/worktrees/<项目>/<组>/<agent> -b suduo/<需求号>-<agent>[-n] <基点>`；运行项目的「工作目录准备命令」（本机项目设置，可空）；失败则该版标失败并展示输出，其余照常。
- **会话**：每版一个试做会话（角色 trial，`workspace_path` 为 worktree），同一任务说明，经调度并发。
- **比较**：`GET /api/v1/trials/:id` 返回每版：最终回答、改动文件与 diffstat（`git -C <worktree> diff <基点>`，包含未提交改动，不依赖 Agent 自己提交）、测试类命令与退出码（从 `commandExecution` 条目提取）、耗时、用量。
- **采用**：先由 SuDuo 在该 worktree 提交一次（提交信息标明需求与 Agent），再 `merge`（在原工作目录 `git merge --no-ff suduo/...`，冲突则告知并停在冲突状态由人处理）或 `keep-branch`（只保留分支）。
- **清理**：未采用的版本列出将删除的 worktree 路径与分支，用户确认后 `git worktree remove` + `git branch -D`（R11）。
- 所有 git 操作由 SuDuo 在本机执行，不推送（推送属于对外副作用，不在本需求）；Agent 在 worktree 里自己执行 git 写操作可能受沙箱限制（如 Codex 写不了主仓库的 `.git`），设计不依赖它，S0 实测各家表现。

### 2.13 共享对象与项目 AI 规范（P2，云端）

- **需求共享对象** `requirement_shared_items`：`kind`（handoff / review / snapshot）、`requirement_id`、`content`（JSON，按 kind 定义 schema）、`source`（成员、Agent、会话句柄的本机不透明 ID、时间）、`status`（published / retracted）、大小上限（快照 1.5 MB，同房间任务过程）。路由：发布、列表、读取、撤回；SSE 推送。
- **项目 AI 规范** `project_ai_rules`：`project_id`、`version`、`content`（Markdown，上限 32 KB）、`updated_by`、`updated_at`；保存即新版本，不做并发拒绝（后写入的成为新版本，活动里两次修改都可见，ADR-0004）。
- **协作记录**（待需求 P2-D1）`requirement_ai_activity`：`requirement_id`、`member_id`、`agent_id`、`kind`（session / delegate / review / trial / handoff）、`status`、`branch`、`at`；客户端在相应事件发生时上报，成员可对单个会话关闭上报。
- **发布前检查**：本机对待发布内容跑一次疑似密钥匹配（常见 API Key、令牌、私钥格式），命中则在预览中高亮提示，由人决定（不拦截）。
- 能力探测：`CLOUD_FEATURES` 增加 `ai_collab_v1`；老云端上相关按钮隐藏并说明需升级服务器。

---

## 三、关键决策与取舍

| 决策 | 选择 | 理由 / 否决 |
|---|---|---|
| 条目模型 | Codex 字段为基线的 SuDuo 自有模型 | 否决全新中立模型 + 读取时翻译：重写面太大（ADR-0014） |
| 统一工具条目 | 复用 `mcpToolCall` 形状 | SuDuo 工具新会话走 MCP；`dynamicToolCall` 只留老线程 |
| Claude 通道 | 进程内 Agent SDK，`pathToClaudeCodeExecutable` 指向用户自装 `claude` | 不分发 Claude 二进制；否决直接驱动 `claude -p`（等于重写 SDK 控制协议） |
| Claude 查询生命周期 | 每会话一个长寿命流式查询，空闲回收后 `resume` 重建；S0 与「每回合一代查询」对比 | Tutti 改成每回合一代以绕开中断问题，需实测 |
| ACP 进程 | 每会话一个进程；只回收声明了 load / resume 的；回收不发 `session/close` | `session/close` 会毁掉 Agent 侧历史 |
| ACP 客户端能力 | `fs.readTextFile=false`、`fs.writeTextFile=true`、`terminal=false` | 写文件经过 SuDuo，只读档可拒、改动有权威记录 |
| MCP 服务挂载 | 同端口 `/mcp`；全局 `onRequest` 上的 LoopbackGuard（`http-server.ts`）对 `/mcp` 豁免，改由 `/mcp` 自己的守卫：loopback Host + 会话令牌 + 带 Origin 时须同源 | 现有 LoopbackGuard 要求写请求带同源 Origin，Agent 的 MCP 客户端不带，不豁免会被 403 |
| 会话令牌 | 随机 32 字节，本机只存哈希，含角色；每次建线程或续接重新签发并注入、旧令牌随即作废；会话删除时全部作废 | 只存哈希就无法再注入原文，所以续接时重签；Codex `thread/resume` 支持 `config` 覆盖（0.159.2 类型已确认） |
| 调度粒度 | 回合 | 会话可能长时间空闲，按会话占名额会浪费；回合是真正消耗资源的单位 |
| 超出上限 | 排队 | ADR-0004 |
| 委派等待 | 有上限的 `wait` + 进度 | 避开各家 MCP 工具超时；Agent 可以先做别的 |
| 结构化产出 | `review_submit`、`handoff_submit` 工具 | 不解析自由文本；各家 Agent 都会调工具 |
| worktree 位置 | SuDuo 数据目录 | 放仓库里会被构建工具、监听、搜索扫到 |
| 跨会话读取的数据源 | 本机事件账本（统一条目） | 与 Agent 无关；不依赖 Agent 回放或其私有存储 |
| 项目规范存放 | 云端带版本 + 按通道注入 | 不改仓库文件（R12）；团队一处维护 |
| Agent 状态 | 只用 CLI 自己的命令或握手；运行中鉴权失败回灌 | ADR-0016 |
| 可执行文件解析 | 配置覆盖 → PATH → 版本管理器目录 → 系统查找；Windows 优先 `.cmd` | 图形界面启动时 PATH 不全 |
| 嵌套保护 | 启动 Agent 前去掉 `CLAUDECODE` 等标记 | 开发者常在 Claude Code 里跑 SuDuo |

---

## 四、核心流程

### 4.1 建会话（三条通道）

```
POST /api/v1/sessions | /api/v2/requirements/:id/sessions | /api/v2/projects/:id/sessions
  { agentId, approvalMode, model?, effort?, trial?: { agents[] } }
  → AgentStatusService.ensureReady(agentId)            未就绪 → 400 带原因与修复入口（前置条件不满足，不是守卫）
  → SessionService 写 sessions(agent_id, role=main, root=self, ...)，签发令牌（role=main）
  → ContextService 组装说明（角色 + 工具 + 项目规范）与会话卡
  → registry.getByAgent(agentId).startThread(...)
       Codex : thread/start { approvalPolicy, sandbox, developerInstructions,
                              config: { mcp_servers.suduo: { url, http_headers, tool_timeout_sec } } }
       Claude: query({ prompt: 队列, options: { cwd, pathToClaudeCodeExecutable, permissionMode, canUseTool,
                       mcpServers: { suduo: { type:"http", url, headers } },
                       systemPrompt: { type:"preset", preset:"claude_code", append: 说明 },
                       settingSources: 主会话 ["user","project","local"]，只读 / 评审 / 房间任务 [],
                       includePartialMessages: true, env } })
       ACP   : spawn → initialize → session/new { cwd, mcpServers:[{ type:"http", name:"suduo", url, headers }] }
               → 按档位 set_mode / set_config_option
  → 首条用户消息 → Scheduler.admit → startTurn
```

### 4.2 回合与审批

同 P1：Claude 的 `stream_event` / `assistant` / tool_result / `result` 翻译为条目与 `turn.completed`；ACP 的 `session/update` 翻译、`stopReason` 映射结局；审批三通道汇成同一载荷，档位策略可直接作答并照常记录；房间任务的审批请求直接拒绝。

### 4.3 需求工具（MCP）

守卫 → 令牌 → 角色与 scope → `tools/list` / `tools/call`；写工具（comment_submit）挂起等确认；**服务端自己计时**——在给该 Agent 配置的工具超时到达前（留 30 秒余量）仍未确认，就把确认卡转为草稿（不另建表：确认卡本身就是草稿，它不属于任何运行时连接，Agent 断开与本机服务重启都不作废）并回复 Agent「已存为草稿，等用户在界面确认」；收到 MCP 取消通知或连接断开时同样转草稿（S0：Codex 超时时既不断开也不发取消，只能靠服务端计时）。

### 4.4 委派时序

```
发起 Agent              ToolMcpServer / DelegationService        Scheduler        子会话（另一家 Agent）
   │ delegate_start ──────▶ 检查 → 建子会话 → 写卡片 ───────────▶ 排队
   │ ◀── delegationId ─────│                                      │ 轮到 ───────▶ 首回合（任务 + 句柄）
   │ delegate_wait(240s) ──▶ 挂起                                              │ 审批 → 审批坞（标来源）
   │                       │ ◀──────────────────────────────── 进度事件 ────────│
   │ ◀── {running, progress}（到点）                                           │
   │ delegate_wait ────────▶ 挂起                                              │ turn.completed
   │ ◀── {completed, result} ◀─────────── 组装结果 ◀────────────────────────────│
   │ 继续本回合
（若发起回合已结束：卡片「让原 Agent 继续」，或 autoHandback 经调度开新回合）
```

### 4.5 评审、试做、交接

见 2.11、2.12；交接：会话菜单 → 向当前会话发一条用户消息「请调用 handoff_submit 生成交接包」（经调度，时间线可见）→ 草稿 → 用户编辑确认 → 发布前密钥提示 → 云端共享对象 → 同需求新会话的会话卡列出句柄。

### 4.6 Agent 状态检测

打开面板 / 重新检测 / 开工前：解析可执行文件 → 版本 → 鉴权（Codex `account/read`；Claude `claude auth status`；ACP 配置表命令，否则临时目录握手探测）→ 缓存（成功 10 分钟、失败 1 分钟）；运行中鉴权失败回灌「需要登录」。「在终端中登录」：桌面应用打开系统终端执行官方登录命令，源码运行时复制命令。

---

## 五、测试策略

| 层 | 内容 |
|---|---|
| 单元 | 各适配器翻译器（S0 录制真实 CLI 的夹具）；调度器（上限、排队、插队、取消、级联、重启恢复）；ContextService 分层读取与上限；工具角色矩阵；WorktreeManager（临时仓库：创建、准备命令失败、采用 merge / 冲突、清理）；密钥匹配 |
| 运行时一致性 | 与通道无关的场景对三种运行时各跑一遍：Codex（`fake-codex.mjs`）、ACP（新 `fake-acp-agent.mjs`，可脚本化）、Claude（可注入的假查询工厂）。场景含：回合、增量、审批三种决策、中断、需求工具、写工具确认与草稿、续接、档位策略 |
| 协作一致性 | 跨通道组合：Claude 发起委派给 ACP、ACP 委派给 Codex、Codex 评审 Claude 会话、三家并行试做；断言条目、卡片、审批来源、结果交回、停止级联 |
| MCP 服务 | 守卫（无令牌、错令牌、外源 Origin）、角色矩阵、图片返回、写工具确认 / 拒绝 / 到点或取消转草稿、`delegate_wait` 到点返回 |
| 前端 | 统一条目渲染（含 `notice`、`suduo*` 卡片、未知条目兜底）；审批坞按 options 与来源；Agent 面板；开工对话框（含并行试做）；运行面板；评审面板；试做比较；会话树 |
| 云端 | 共享对象发布 / 撤回 / 大小上限；项目规范版本；协作记录；`agents.kind` 放开与老值兼容 |
| gate | gate-a / b / c 按 Agent 参数化：Codex 全量防退化；新增一条用假 Agent 跑通需求「模拟示例」1–9 步的端到端场景；Claude 与 ACP 真实冒烟在装好对应 CLI 的机器上发布前手动跑 |
| 兼容 | 老会话回放；新客户端连老云端（只共享 Codex、隐藏协作共享按钮）；老客户端连新云端 |

质量门：两端 `pnpm typecheck / lint / test`（改 `cloud/contracts` 两端都跑）；gate-c 全量在 Lima 虚拟机；独立 subagent 或 `/code-review` 复核。

---

## 六、数据设计

### 6.1 本机 SQLite

| 迁移 | 内容 |
|---|---|
| `019_session_agent_graph` | 重建 `sessions`（SQLite 改 CHECK 需重建）：`kind` 增加 delegate / reviewer / trial，`approval_mode` 增加 readonly；新增 `agent_id`（默认 `codex`）、`parent_session_id`、`root_session_id`（老会话 = 自身）、`relation`、`relation_meta`、`workspace_path`、`rules_version`；索引 `root_session_id` |
| `020_approval_decisions` | 重建 `approvals`，`decision` 的 CHECK 增加 `acceptAlways`、`declineAlways` |
| ~~`021_session_tool_tokens`~~ | S2 实施取消：令牌只在内存（本机服务重启时 Agent 进程跟着重启，续接时重签），工具清单记在线程元数据 |
| ~~`022_tool_drafts`~~ | S2 实施取消：等不到确认的写工具调用，确认卡本身就是草稿 |
| `023_agent_settings` | `(agent_id, enabled, bin_override, concurrency, updated_at)`；全局上限、默认 Agent 存现有设置 |
| `024_delegations` | `(id, parent_session_id, parent_turn_id, tool_call_id, child_session_id, agent_id, task, workspace_mode, status, auto_handback, result_json, created_at, finished_at)` |
| `025_session_references` | `(id, reader_session_id, target_kind, target_id, view, target_seq, created_at)` |
| `026_review_reports` | `(id, target_session_id, reviewer_session_id, agent_id, focus_json, findings_json, summary, status, published_ref, created_at)` |
| `027_trials` | 试做组 `(id, requirement_id, task, base_commit, selected_session_id, status)`；工作目录 `(id, group_id, session_id, path, branch, status, setup_log)` |
| `028_shared_drafts` | 交接包与会话快照草稿 `(id, kind, session_id, requirement_id, content_json, status, published_ref)` |

事件账本结构不变；审批表只放宽 `decision` 的 CHECK（020）。编号按现有最大 018 顺延，实施时以实际为准。

### 6.2 云端 PostgreSQL

| 迁移 | 内容 |
|---|---|
| `016_agent_kinds.sql` | `agents.kind` 去掉 `IN ('codex')`，改为格式检查；默认值保留 `codex` |
| `017_ai_collab.sql` | `requirement_shared_items`、`project_ai_rules`、`requirement_ai_activity`（P2-D1 采纳时启用上报） |

`cloud/contracts`：`AGENT_KINDS` 改为「已知列表 + 接受未知」；共享对象与规范的 schema；`CLOUD_FEATURES` 增加 `agent_kinds_v2`、`ai_collab_v1`。

---

## 七、接口设计

### 7.1 本机 REST

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/v1/agents`、`/:id/recheck`、`/:id/login`、`/:id/models` | GET / POST | Agent 列表、检测、登录入口、模型 |
| `/api/v1/settings/agents` | GET / PUT | 默认 Agent、启用、路径覆盖、每 Agent 并发、全局并发 |
| 会话创建（v1 / v2） | POST | 增加 `agentId`、`model?`、`effort?`、`trial?`；`approvalMode` 增加 `readonly` |
| `/api/v1/sessions?tree=1` | GET | 按根会话分组 |
| `/api/v1/sessions/:id/delegations` | POST / GET | 用户发起委派；列表 |
| `/api/v1/delegations/:id/cancel`、`/handback` | POST | 取消；让原 Agent 继续 |
| `/api/v1/sessions/:id/reviews` | POST / GET | 发起评审；列表 |
| `/api/v1/reviews/:id/apply`、`/publish` | POST | 选中意见交回原 Agent；发布到需求 |
| `/api/v1/trials`、`/:id`、`/:id/adopt`、`/:id/cleanup` | POST / GET | 并行试做 |
| `/api/v1/sessions/:id/handoff`、`/snapshot` | POST | 生成交接包、会话快照草稿 |
| `/api/v1/shared-drafts/:id/publish`、`/discard` | POST | 发布 / 丢弃 |
| `/api/v1/scheduler`、`/scheduler/:itemId/promote`、`/cancel` | GET / POST | 运行面板 |
| `/api/v1/sessions/:id/tool-drafts`、`/api/v1/tool-drafts/:id/send`、`/discard` | GET / POST | 写工具草稿 |
| `/api/v2/projects/:id/ai-rules` | GET / PUT | 项目 AI 规范（代理云端） |
| `/api/v2/requirements/:id/shared-items` | GET | 需求共享对象（代理云端） |

### 7.2 MCP

`POST /mcp`（单条 JSON-RPC、直接回 JSON；`GET` 回 405，不开 SSE 流），`Authorization: Bearer <会话令牌>`；`serverInfo.name = "suduo"`；工具与角色见 2.9；工具定义沿用服务端 `session-tools/catalog.ts`（MCP 版由 `mcpToolSpecsFor` 生成），不另建契约文件。

### 7.3 契约

新增 `items.ts`、`agents.ts`、`collab.ts`（会话角色与关系、委派、评审、试做、共享对象 DTO）；`runtime.ts` 按 2.5；`registry.ts` 增加 `list()`、`getByAgent()`；`config.ts` 的 `ApprovalMode` 增加 `readonly`，并增加 `DEFAULT_AGENT_ID`、默认并发。

---

## 八、文件结构 / 变更清单（按分片）

| 分片 | 主要改动 |
|---|---|
| **S0 实测** | `client/scripts/agent-probe/`（一次性，不进产品）：Codex 按线程 / 续接注入 MCP；各 Agent 的 MCP 超时上限与工具命名；六家 ACP 的启动参数、`initialize` 能力、登录与状态命令、模式与配置项、load / resume、只读能力、HTTP MCP；Claude SDK 驱动自装 `claude`、`claude auth status`、两种查询生命周期；各 Agent 调用 `*_submit` 工具的可靠性；Windows / macOS 上 worktree 与准备命令；两三家 Agent 并行时的机器负载与限流。夹具录到 `client/server/test/fixtures/agents/`；核对 SDK 与 ACP 库许可 |
| **S1 契约与地基** | `client/contracts/src/{items,agents,collab,mcp-tools,runtime,config}.ts`；`application/agents/{catalog,status-service,resolver,terminal-login}.ts`；`application/scheduler/*`（准入接入所有 `startTurn`，初期上限放宽）；`runtime-registry.ts`；`server-application.ts`（多运行时装配、每运行时一条消费循环）；`session-service.ts`（agent_id、角色、根）；`approval-service.ts`、`codex-approval-mapper.ts`（subject / options / display / origin）；`codex-runtime.ts`（权限档位、删房间档猜测）；本机迁移（6.1 前四项 + 会话图字段）；`/api/v1/agents*`、`/settings/agents` |
| **S2 本机 MCP** | `infrastructure/mcp/{tool-mcp-server,mcp-guard,tool-tokens}.ts`；`application/session-tools/*`（MCP 内容、角色矩阵、写工具挂起与草稿）；`session-context.ts` → ContextService 雏形（说明组装、会话卡）；`codex-runtime.ts`（注入 `mcp_servers.suduo`、房间档放行 SuDuo MCP、老线程保留 dynamicTools）；`codex-event-normalizer.ts`；i18n `toolSpec.ts` |
| **S3 Claude Code** | `infrastructure/runtime/claude/{claude-runtime,claude-query-factory,claude-event-translator,claude-permissions}.ts`；配置表条目；依赖锁定（排除平台可选二进制） |
| **S4 ACP** | `infrastructure/runtime/acp/{acp-runtime,acp-connection,acp-update-translator,acp-tool-kinds,acp-permissions,acp-process-pool}.ts`；六家配置；`test/fixtures/fake-acp-agent.mjs` |
| **S5 前端（接入）** | `event-projection/{timeline,reducer,shared}.ts`；`ApprovalDock.tsx`；`StartSessionDialog.tsx`、新建会话；`SessionModelSwitcher.tsx`；`settings/sections/AgentsSection.tsx`；i18n 去 Codex 化 |
| **S6 房间** | `room-agent/{runner,context,progress}.ts`（按 agentId、只读、经调度）；`agent-presence.ts`；`roomPrompt.ts`；`features/rooms/{model.ts,ShareAgentPanel.tsx,MentionPicker.tsx}`（多 Agent @）；云端 `016_agent_kinds.sql`、`rooms.ts`、`rooms-schemas.ts`、`sql.ts`、`agent-service.ts`、`agent-run-texts.ts` |
| **S7 上下文与会话图** | `application/context/*`（句柄、分层读取、留痕）；工具 `session_list / session_read / handoff_read`；会话树 API；前端：输入框 @ 会话、引用标签、`suduoReference` 渲染、会话树、「接着做」 |
| **S8 委派与运行面板** | `application/collab/delegation-service.ts`；工具 `agent_list / delegate_*`；`suduoDelegation` 卡片；审批来源分组；停止级联；自动交回；`/api/v1/scheduler*`；前端运行面板、输入框 @Agent、并发设置 |
| **S9 交叉评审** | `application/collab/review-service.ts`；工具 `review_request / review_submit`；评审面板、交回修改；发布（依赖 S11 云端对象，可先只做本机部分） |
| **S10 并行试做** | `application/collab/{trial-service,worktree-manager}.ts`；开工对话框并行试做；比较视图；采用与清理；项目准备命令设置 |
| **S11 共享与项目规范** | 云端 `017_ai_collab.sql`、路由与契约；本机代理；交接包与会话快照的生成、预览、密钥提示、发布、撤回；项目 AI 规范编辑页、ProjectRulesService 注入与版本提示；协作记录上报（P2-D1）；需求详情「AI 协作」区 |
| **S12 诊断、gate 与发布** | 诊断按 Agent 分组；gate 参数化与「模拟示例」端到端场景；`THIRD_PARTY_NOTICES.md`；README、官网措辞（如实写「支持」，ADR-0016）；总览数据边界表述（若 P2-D1 采纳） |

**依赖顺序**：S0 → S1 → S2 → （S3 ∥ S4）→ S5 → S6；S7 在 S2 之后即可开始（前端部分等 S5）；S8 依赖 S1 调度器与 S7；S9、S10 依赖 S8；S11 的云端部分可在 S2 之后并行；S12 收尾。

---

## 九、依赖与配置

| 项 | 说明 |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | 精确锁定；使用受 Anthropic 商业条款约束（SDK 文档原文），S0 核对随桌面应用分发的条件；打包排除平台可选二进制 |
| ACP 官方 TypeScript 库 | S0 核对许可后采用，或在现有 `RpcConnection` 上自写 |
| `@modelcontextprotocol/sdk` | MIT；Streamable HTTP 服务端 |
| git | 并行试做需要本机 git（现有 Git 检查点已依赖） |
| 环境变量 | `SUDUO_AGENT_<ID>_BIN`；`SUDUO_MAX_APPROVAL_MODE` 继续生效；`SUDUO_CODEX_*` 不变 |
| Codex | 0.159.2 与协议基线不变 |
| 已验证版本 | 配置表写最低版本；S12 加「已验证版本」清单，诊断页提示是否在清单内（只提示） |

---

## 十、迁移影响与风险

| 影响 / 风险 | 处理 |
|---|---|
| 时间线与服务端解析改动面大 | 条目模型以 Codex 为基线；S1 / S5 后 gate-c 全量；老会话回放用例 |
| 老 Codex 线程续接后仍发 `item/tool/call` | Codex 适配器保留 dynamicTools 处理到线程自然结束 |
| 调度器接入所有回合，可能引入新的卡顿 | S1 先以宽松上限接入，行为与现在一致；S8 再启用默认上限 |
| MCP 工具超时 | 长超时（Codex `tool_timeout_sec`、Claude `MCP_TOOL_TIMEOUT`）+ 服务端在超时前转草稿；`delegate_wait` 有上限返回 |
| Codex 按线程注入 MCP 不可行 | 退到全局登记 + 按线程覆盖请求头；再不行 Codex 保留 dynamicTools（ADR-0015） |
| ACP Agent 怪癖 | 配置表 `quirks` + Tutti 记录的对策（日志行容忍、取消宽限后结束进程、审批等入参齐全、权限应答异步、回合外迟到消息丢弃、「始终允许」文案写明） |
| Claude SDK 已知坑 | 后台子任务时以空闲状态判回合结束；`getContextUsage` 加超时；鉴权失败尽快判失败并回灌；合并用户 settings 里的 env |
| worktree 的磁盘与依赖开销 | 准备命令可配置；比较后确认清理；数据目录可设 |
| 委派与试做把额度用光 | 并发上限 + 排队；额度错误给「换 Agent 重试」 |
| 新旧客户端与云端兼容 | `agent_kinds_v2`、`ai_collab_v1` 能力探测 |
| 本机 MCP 端点安全 | 只听 127.0.0.1；令牌按会话与角色、只存哈希、重新签发或会话删除即作废；外源 Origin 拒绝；全局 LoopbackGuard 对 `/mcp` 豁免并由其独立守卫接管 |
| 依赖许可 | S0 核对，更新 `THIRD_PARTY_NOTICES.md` |

---

## 十一、分片与验收

| 分片 | 验收 |
|---|---|
| S0 | 实测报告记入第十二节；配置表各条目参数有实测依据；Codex MCP 注入方式、Claude 查询生命周期、`delegate_wait` 上限、各 Agent 提交工具可靠性有结论 |
| S1 | 契约编译通过；Codex 行为零变化（gate-c 全量通过）；`/api/v1/agents` 列出并检测八家；会话记录 agent_id 与角色；所有回合经调度器准入 |
| S2 | Codex 新会话通过 MCP 调需求工具（含图片、发评论确认、到点转草稿）；老线程 dynamicTools 照常；守卫与角色矩阵测试全过 |
| S3 | Claude Code 开工、增量、审批三种决策、中断、需求工具、续接可用；四档权限生效 |
| S4 | 至少四家 ACP 真实冒烟通过；假 Agent 一致性测试全过 |
| S5 | 开工可选 Agent；时间线对三种通道一致；Agent 面板正确；中英文案无残留「Codex」（Codex 专属处除外） |
| S6 | 房间可共享 Claude Code 与任一 ACP Agent，只读生效；一条消息 @ 多个 Agent 各自回答；新客户端连老云端只共享 Codex |
| S7 | 跨通道读会话（Gemini 读 Claude、Codex 读 Gemini）五层结果正确、有留痕；「接着做」可用；会话树正确 |
| S8 | 委派全流程（排队、运行、审批来源、等待到点、完成交回三种方式、停止级联、取消）在三种通道组合下通过；运行面板可插队与取消；深度 1 生效 |
| S9 | 评审拿到结构化意见；交回修改；未调用提交工具时的退化；发布到需求 |
| S10 | 两三家并行试做、比较、采用（merge 与保留分支）、冲突告知、确认后清理 |
| S11 | 交接包、评审报告、会话快照发布与撤回；密钥提示；项目规范版本与注入；协作记录（若 P2-D1 采纳） |
| S12 | 诊断按 Agent 分组；「模拟示例」端到端 gate 通过；两端质量门与 gate-c 全量通过；独立复核意见已处理 |

---

## 十二、实施记录

### S0 实测（2026-10-08）

驱动脚本与依赖在 `/Volumes/Sue-SSD/Dev/tmp/suduo/agent-probe/`（`package.json` 锁版本：Claude Agent SDK 0.3.293、ACP SDK 1.7.0、MCP SDK 1.32.1、OpenCode 1.18.35、Qwen Code 0.25.0、Gemini CLI 0.63.0、Copilot CLI 1.0.93）。本机 `claude` 2.1.284、捆绑 Codex 0.159.2。

**Codex（`codex-mcp-probe.mjs`，中转站模型）**

| 项 | 结果 | 对设计的影响 |
|---|---|---|
| `thread/start` 的 `config` 覆盖里写 `mcp_servers.suduo`（url + `http_headers` 里的 Bearer） | ✅ 能调用；同一进程两个线程各用各的令牌（TA / TB 不串） | 共享进程方案成立，不需要每会话一个 Codex 进程 |
| 新进程 `thread/resume` 时换令牌 | ✅ 新令牌生效 | 「续接时重签」成立 |
| 默认工具审批 | ❌ 不配时调用失败：「MCP tool call requires approval, but approval policy is never」 | SuDuo 的 MCP 配 `default_tools_approval_mode = "approve"`（取值有 auto / prompt / writes / approve）；写操作的确认由 SuDuo 确认卡负责 |
| `tool_timeout_sec = 600` 下挂起 75 秒 | ✅ 正常返回 | 写工具确认可以挂起等用户 |
| `tool_timeout_sec = 30` 下挂起 45 秒 | 30 秒超时失败；**Codex 不断开连接、不发取消通知** | 服务端感知不到 Agent 超时，改为**服务端自己计时**：在配置的超时到达前主动回复「已存为草稿，等用户在界面确认」 |
| MCP 请求的 Origin 头 | 不带 | `/mcp` 独立守卫的设计成立 |

**ACP（`acp-probe.mjs`）**

| Agent | 握手能力 | 登录方式 | 未登录时 `session/new` | 备注 |
|---|---|---|---|---|
| Gemini CLI 0.63（`--acp`） | loadSession、图片、HTTP MCP | Google、API Key、Vertex、网关 | 报「Gemini API key is missing or not configured」 | `--experimental-acp` 已废弃 |
| Qwen Code 0.25（`--acp`） | loadSession、resume、list、图片、HTTP MCP | OpenAI 兼容 API Key | 报「Authentication required」 | |
| Copilot CLI 1.0.93（`--acp`） | loadSession、close、list、图片、HTTP MCP | `copilot-login`（`_meta` 标 terminal-auth） | 报「Authentication required」 | npm 安装要连同平台包（可选依赖）一起装 |
| OpenCode 1.18.35（`acp`） | loadSession、resume、close、fork、list、图片、HTTP MCP | opencode 登录 | **能建会话**，带免费模型（`opencode/big-pickle` 等）；配置项 model、mode（build / plan） | 见下 |

OpenCode 完整回合：SuDuo MCP 工具调用成功（带会话令牌，Agent 侧工具名 `suduo_probe_echo`）；**自己写文件，不走 `fs/write_text_file`，build 模式下也不发权限请求** → 「写前询问 / 只读」须在启动时经 `OPENCODE_CONFIG_CONTENT` 注入权限规则（编辑、执行设为 ask / deny），plan 模式作只读辅助；有 `usage_update`；`session/cancel` 后立即返回 `stopReason: cancelled`。

结论：四家都支持 HTTP MCP 与 loadSession，ADR-0015 在 ACP 侧成立；「未登录」统一由 `session/new` 的鉴权错误识别为 `auth_required`。

**Claude Code（`claude-sdk-probe.mjs`、`claude-stream-probe.mjs`，用户本机订阅登录）**

| 项 | 结果 | 对设计的影响 |
|---|---|---|
| SDK 0.3.293 + `pathToClaudeCodeExecutable` 指向自装 `claude` 2.1.284 | ✅ `apiKeySource: none`，用本机订阅 | 方案成立；打包排除 SDK 的平台二进制 |
| `claude auth status` | 退出码 0，输出 JSON：`loggedIn`、`authMethod`、`apiProvider`、`subscriptionType` 及邮箱、组织等 | 解析器**只取** `loggedIn`、`authMethod`、`apiProvider`，邮箱与组织不读不存 |
| HTTP MCP（Bearer） | ✅ 工具名 `mcp__suduo__<工具>`；模型先用 ToolSearch 加载延迟工具再调用 | 工具说明里写清工具名 |
| `default` 档 | ✅ MCP 工具与 Write 都进 `canUseTool` | 审批映射成立 |
| 只读档（`settingSources: []` + `dontAsk` + `disallowedTools` 写入类） | ✅ 写工具不可用 | 成立；`allowedTools` 的裸工具名会绕过 `canUseTool`（SDK 警告），只放只读工具 |
| 不加载设置时的 MCP | ⚠️ 仍挂上 claude.ai 账号的连接器 | 只读、评审、讨论任务加 `strictMcpConfig: true`（✅ 实测只剩 SuDuo 的 MCP），满足 ADR-0009 |
| 中断 | `interrupt()` 返回后，本回合结果为 `error_during_execution`；启动完成前就中断时迭代器还会抛错 | 适配器：发过中断 → 记为 interrupted，并忽略随后的抛错 |
| 长寿命流式查询 | ✅ 同一查询连续 4 个回合，会话 ID 不变；第 3 回合中途中断后第 4 回合照常 | 采用「每会话一条长寿命查询」，不必每回合重建 |

**未实测（留待后续分片）**：Cursor CLI、Kimi Code（本机未装，配置按官方说明）；Gemini、Qwen、Copilot 的完整回合（需用户登录）；Windows 上的 worktree 与可执行文件解析；各 Agent 调用 `*_submit` 类工具的可靠性（随 S9 / S11 实测）。

### S1 契约与地基（已完成）

- **S1-1（已完成）**：运行时接口以 `approvalMode: RuntimeApprovalMode` 取代 Codex 专有的 `security`；`RuntimeApprovalMode` = 用户三档 + `readonly`，Codex 适配器用 `RUNTIME_APPROVAL_MODE_POLICIES` 换算，房间任务显式传 `readonly`，删除按组合猜房间档的逻辑。**偏差**：用户可选的「只读」档（数据库 `approval_mode` 放宽、界面选择器）移到 S5 与界面一起做，S1 不动会话表的这一列。质量门：client typecheck、lint 通过；受影响 7 组测试 84 项通过。
- **S1-2（已完成）**：Agent 配置表（八家，参数来自 S0 实测或官方核实；无可靠依据的不设最低版本，只记「已验证版本」作提示）、可执行文件解析（覆盖 → PATH → 常见安装目录，Windows 优先 `.cmd`）、状态检测服务（版本、Claude 登录状态只读 `loggedIn`、ACP 登录状态待 S4 握手判断；结果缓存成功 10 分钟、失败 1 分钟；运行中鉴权失败可回灌）、Agent 设置单独存 `agent-settings.json`（不碰 `settings.json`，替代原计划的 `agent_settings` 表）、打开系统终端执行官方登录命令；接口 `GET /api/v1/agents`、`POST /api/v1/agents/:id/recheck`、`POST /api/v1/agents/:id/login`、`GET / PUT /api/v1/settings/agents`。DTO 增加 `runtimeAvailable`（S3 / S4 之前 Claude 与 ACP 为 false）、`verifiedVersion`。本机真实冒烟：claude 2.1.284 ready、Codex ready、Copilot / Gemini / OpenCode / Qwen installed、Cursor / Kimi not_installed；八家并行检测约 8.5 秒（Node 写的 CLI 启动慢）→ S5 界面先出列表、状态逐个刷新。
- **S1-3（已完成）**：迁移 019 给 `sessions` 加 `agent_id`（默认 codex）与会话图列（`parent_session_id`、`root_session_id`、`relation`、`relation_meta_json`、`workspace_path`、`rules_version`；只加列不重建表，新会话角色的 `kind` 约束放到 P2 再扩）；会话记录与 `SessionDto` 带 `agentId`；`RuntimeRegistry` 增加 `list()`、`findByAgent()`（`AgentRuntime.agentId` 可选，老 Codex 运行时视为 codex，同一家 Agent 不能注册两个运行时）；创建会话（项目会话与需求会话）按 `agentId` 找运行时，不传为 codex，指定未接上的 Agent 报 400 并说明是哪家。质量门：client typecheck、lint、全量测试 1618 项通过。
- **S1-4（已完成）**：每个已注册的运行时一条事件消费循环。实施中发现一处多 Agent 下的真实缺陷并修正：连接断开时原来会作废**所有**待审批、恢复**所有**线程——接入第二家 Agent 后，一家 Agent 的进程退出会连带作废别家会话里的确认卡。现在 `orphanPersistedPending` 与线程恢复都按运行时限定（ADR-0017 故障隔离），并加了对应测试。
- **S1-5（调整：移到 S8）**：调度器原计划在 S1 以宽松上限接入所有回合。实施时判断：在委派与并行试做（S8 / S10）之前没有任何场景会触发上限，S1 接入只会留下测不出效果的占位代码；开回合的调用点只有 `message-service` 与房间任务两三处，S8 补接成本低。改为在 S8 与委派一起完整实现与测试。
- **S1-6（已完成）**：审批载荷加中立字段 `subject` / `options` / `display`（契约 `NeutralApprovalFields`），Codex 映射器补齐（原生字段保留，前端 S5 再切换）；决策增加 `acceptAlways` / `declineAlways`，`ApproveInput` 带 `optionId`（取代原设计的 `ApprovalResolution` 新类型，改动更小）；决定时按卡上的 options 解析选项、不在选项里报 400，没有 options 的老卡与工具确认卡只认原来四种；迁移 020 重建 `approvals` 放宽 `decision` 的 CHECK。质量门：typecheck、lint、全量测试 1625 项通过。
- **S1 验收**：gate-c 全量（官方 Lima 虚拟机，S1 末提交 2f2fa5d）通过，19 步全过（`GATE_EXIT=0`），即 Codex 行为零变化；`/api/v1/agents` 八家检测见 S1-2。「所有回合经调度器准入」随 S1-5 移到 S8。

### S2 本机 MCP 工具服务（已完成）

- **实现**：`infrastructure/mcp/mcp-endpoint.ts`（Streamable HTTP 最小实现：单条 JSON-RPC、`initialize` / `ping` / `tools/list` / `tools/call`，`notifications/cancelled` 中止进行中的调用；守卫 = loopback Host + 会话令牌 + 带 Origin 时须同源，全局 LoopbackGuard 对 `/mcp` 豁免）、`tool-tokens.ts`（内存、只存哈希、每会话一个有效令牌，重签即作废）；会话工具服务实现 MCP 一侧（工具名去 `suduo_` 前缀，说明与回复文字里提到的工具名同样换掉；图片转 MCP image）；监督器按运行时能力选通道——运行时支持且工具服务在线时签令牌走 MCP，否则沿用 dynamicTools，老线程续接不变；Codex 适配器把 `mcp_servers.suduo` 写进线程级配置（与房间档关掉所有者 MCP 的覆盖合并）。
- **写工具**：建确认卡（连接 id 固定为 `suduo-mcp`，不属于任何运行时连接），挂起等用户决定；到「工具超时 − 30 秒」或 Agent 取消 / 断开时回复「已存为草稿」，卡片留着，之后确认照样发出。
- **账本形状**：Codex 把 MCP 调用记为 `mcpToolCall`（服务 suduo）；事件归一化时换成与 dynamicTools 通道相同的 `dynamicToolCall`（工具名补回前缀、结果换成 inputText / inputImage），界面、房间进度、图片瘦身都不用改。Claude 与 ACP 运行时同样落成这个形状。实测 Codex 0.159.2：工具返回 `isError` 时条目 `status: failed`、内容保留、`error` 为 null。
- **端到端实测发现并修正的两处问题**（单测没覆盖到，均已补测试）：① Agent 在建线程时就来取 `tools/list`，而需求会话的需求关联在线程建好后才写入，现查会话范围得到空清单（Codex 会缓存）→ 改为令牌授予建线程时定下的工具清单（见 2.9）；② Node 的请求对象在请求体读完时就触发 `close`，拿它当「Agent 断开」会让每次写工具调用立刻被当成取消 → 改听响应的 `close`，并加了真实连接的测试（用旧写法会失败）。
- **验收**：本机真实链路（分支构建起在 18788，数据为 stack-b 的副本，Codex 走中转站，需求服务为本机云端）：新需求会话经 MCP 调 `requirement_get` → `comment_submit` → 确认卡 → 确认 → 评论落到云端 → 结果回到 Codex，回合正常结束；重启本机服务后同一会话续接，按记下的清单重签令牌，`requirement_comments` 照常可用。驱动脚本 `/Volumes/Sue-SSD/Dev/tmp/suduo/s2-e2e*.mjs`。到点转草稿只在单测里验证（真实等待要 9 分半）。质量门见下方「独立复核」之后的数字。
- **偏差**：令牌与草稿不建表（6.1 的 021 / 022 取消）；不新建 `contracts/src/mcp-tools.ts`；角色矩阵（委派、评审等工具）随 P2 各分片加入清单，S2 只有现有四种 scope。
- **独立复核（subagent）与处理**：
  1. 启动时恢复线程早于本机服务开始监听，排在前面的 MCP 线程续接时拿不到地址、挂不上工具，且被记为就绪、之后不再续接 → 恢复改在 Fastify `onListen` 之后开始；续接 MCP 线程时工具服务没在监听就先不续接、不记就绪（不抛错，免得发消息那条路改为重建线程、丢历史）。已修，加测试。
  2. Codex 访问 127.0.0.1 也走 HTTP_PROXY / ALL_PROXY（复核实测），代理在别的机器上时连不到工具服务、令牌明文发给代理；老的 dynamicTools 走 stdio 没有这个问题 → 启动 Agent 子进程时 `NO_PROXY` / `no_proxy` 补上 `127.0.0.1,localhost,::1`（`withLoopbackNoProxy`，Claude / ACP 运行时同样用它；不改出网代理设置本身）。已修，加测试。
  3. 重启时还在执行中（deciding）的 MCP 确认卡被一律跳过，会永远卡住、人无法恢复（不符合 ADR-0004）→ 只跳过待确认的；执行中的在本进程内留着，重启后按「结果未确认，请先核对」作废。已修，加测试。
  4. 用户点了发出、执行期间刚好到点或 Agent 断开，会告诉 Agent「没发出」而评论其实发了 → 决定开始执行时记 executing，之后不再转草稿、等执行结果。已修，加测试（去掉修正时测试失败）。
  5. 写工具准备阶段抛错时回的不是 JSON-RPC 结果 → `callTool` 统一捕获，回失败结果。已修。
  6. 同一会话两个客户端用同一个请求 id 时 inflight 互删 → 只删自己的，requestKey 加序号。已修。
  7. 转草稿的时刻改为从请求到达算起，用令牌里记的该 Agent 工具超时（`ToolGrant.toolTimeoutSec`），不再用全局常量。已修。
  8. 协议：只含 JSON-RPC 响应的 POST 改回 202（已修）。**留给 S3 / S4 实测再定**：401 不带 `WWW-Authenticate` 时实现了 MCP 授权的客户端（Claude Code）可能转去走 OAuth 发现；不开 SSE 就发不了进度通知，工具超时不可配、又只在收到进度时重置的客户端会先超时（卡片照样留作草稿，但 Agent 看到超时错误）；按 2025-03-26 协商时不支持批量请求。
  9. 回复文字里的工具名替换也会改到需求正文、评论、附件文字里恰好出现的 `suduo_<工具名>`：只影响给模型看的文字，不落盘（笔记工具不经工具返回正文），接受。
  10. 用户自己的 Codex 配置里已有名为 suduo 的 MCP 服务时会与线程级配置合并冲突：概率极低，接受，记在这里。
- **复核后重测**：client typecheck、lint 通过，全量测试 1646 项通过（server 711、web 887、desktop 36、contracts 12）；真实链路重跑（新需求会话读需求 → 发评论确认 → 落云端；重启后续接按清单重签令牌、工具可用）通过。gate-c 全量（官方 Lima 虚拟机，含复核后的修正）19 步全过（`GATE_EXIT=0`）：新 Codex 会话已默认走 MCP，老线程照常；虚拟机里 Codex 继承了宿主代理，本机直连的修正在这里同样生效。

### S3 Claude Code 运行时（已完成）

- **实现**：`infrastructure/runtime/claude/`——`claude-runtime.ts`（每个会话一条长寿命流式查询；建线程不启动进程，首个回合才启动；已有记录用 `resume`、否则用线程 ID 作 `sessionId` 新开，线程 ID 前后一致；一次只跑一个回合，后来的排队；中断、审批、撤回、进程断开都只影响这个会话）、`claude-translator.ts`（SDK 消息 → 现有条目：文字与思考按流式增量，Bash / Read / Grep / Glob / LS → `commandExecution`（查看、搜索、列目录按 Codex 的 commandActions 形状），Edit / MultiEdit / Write → `fileChange`（片段 diff），SuDuo 工具 → `dynamicToolCall`，其他 MCP → `mcpToolCall`，TodoWrite → 计划面板，Task → 协作代理，压缩 → `contextCompaction`；用量与回合结局按 Codex 形状；子 Agent 内部消息不展开；ToolSearch 不显示）、`claude-permissions.ts`（四档映射，见 2.4；SuDuo 工具服务整个放行，发评论走 SuDuo 自己的确认卡）。SDK 0.3.293 精确锁定，用到时才加载；各平台自带的 claude 二进制经 `ignoredOptionalDependencies` 不装（ADR-0016 只驱动用户本机的 claude）。
- **审批**：`canUseTool` → 确认卡（中立字段 + 沿用 Codex 审批的 request 字段，现有审批坞照常显示）；同意 / 本会话同意（Claude 建议的规则一律改记到 session，不写用户设置文件）/ 拒绝（条目记 declined）/ 拒绝并停止（同时中断回合）。Claude 撤回请求（回合被中断等）发 `approval.withdrawn`，查询结束发 `runtime.connection-closed`，消费循环据此作废相应的卡、不进账本（ADR-0017 故障隔离）。`AskUserQuestion` 的选择题界面还没有，先自动拒绝并让它在回复里直接问（S5 做界面）。
- **接口**：`POST /api/v2/requirements/:id/sessions`、`/api/v2/projects/:id/sessions` 的请求体可带 `agentId`（不传为 Codex；没接上的 Agent 报 400）。配置表 Claude Code 标为已可驱动；`AgentCatalogService.executablePath` 供运行时找 claude（用户填的路径优先）。
- **顺手修正（S1-2 遗留）**：`agentChildEnv` 原来去掉所有 `CLAUDE_CODE_*`，会连带去掉用户自己的配置（`CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_VERTEX` 等）→ 改为只去掉父会话传下来的标识与进程间通信变量（明确清单）。
- **端到端实测**（分支构建 18788 + 本机云端 + 本机订阅登录的 claude 2.1.284）：需求会话经 MCP 读需求、发评论确认、落云端；询问档的写命令与 Write 弹确认卡，同意、拒绝（记 declined）都对；同一查询连续多回合；中断记为 interrupted，之后照常；重启本机服务后续接，记得之前的对话，SuDuo 工具换新令牌照常可用；自动档改文件不问、完全访问不问。实测发现并修正：活着的查询切不到 `bypassPermissions`（启动时没允许）→ 完全访问与只读一样按「启动参数不同」重启查询（续接，历史不丢）；控制请求被拒时改为重启查询，不让这次发送失败。驱动脚本 `/Volumes/Sue-SSD/Dev/tmp/suduo/s3-*.mjs`。
- **留给后续分片**：Claude 的模型列表（`supportedModels`）与推理强度、按 Agent 区分的模型选择（S5）；用户可选的「只读」档（S5，只读参数已单测、S0 实测过）；开会话前按 Agent 状态拦截并给修复入口（S5）；桌面应用把 SDK 打进 esbuild 包后的启动验证（S12）；限流、重试提示（`api_retry` 等）。
- 质量门见 S4 之后的「S3 / S4 独立复核」。

### S4 标准 ACP 运行时（已完成）

- **实现**：`infrastructure/runtime/acp/`——`acp-runtime.ts`（每家 Agent 一个运行时实例；每个 SuDuo 会话一个 Agent 进程，会话之间互不影响；**建线程即建会话**：启动进程、`initialize`、`session/new`，线程 ID 就是 Agent 的会话 ID，没登录在这一步就报出来；闲置 10 分钟关进程，用到时再启动并 `session/load`（或 `session/resume`）续接，续接时回放的历史不进账本；进程崩了只影响这个会话，下个回合重新拉起并续接）、`acp-translator.ts`（`session/update` → 现有条目：文字与思考按「换了种更新就算结束」切分，execute / read / search / edit / fetch 按 Codex 形状，SuDuo 工具 → `dynamicToolCall`（认出各家写法：`suduo_<工具>`、`mcp__suduo__<工具>`、`suduo/<工具>`、`<工具> (suduo MCP Server)`），其他工具显示成「调用 <Agent> · 工具」，计划、用量、提示照转）、`acp-profiles.ts`（档位 → 会话模式按偏好选：只读 plan、询问 default、自动 auto-edit、完全访问 yolo；OpenCode 用 plan / build 并在启动时经 `OPENCODE_CONFIG_CONTENT` 注入权限规则，改档位重启进程）。ACP 官方 TypeScript 库 `@agentclientprotocol/sdk` 1.7.0（Apache-2.0）精确锁定，用到时才加载。
- **审批**：`session/request_permission` 先按档位策略答（只读：查看类放行、写与执行拒绝；完全访问：放行；自动：查看与编辑放行），其余成确认卡，选项就是 Agent 给的选项（allow_once / allow_always / reject_once / reject_always）加「停止」；中断时先把等着的权限请求答成 cancelled 并作废卡片（ACP 要求）。SuDuo 不代读写文件、不提供终端（`clientCapabilities` 全关），由 Agent 自己做，权限请求照常交给 SuDuo。SuDuo 的说明放在会话第一条消息前（ACP 没有系统提示参数）。
- **没装 / 没登录**：运行时抛 `AgentNotReadyError`，监督器转成 `400 AGENT_NOT_READY`（说明怎么修，details 带 agentId 与 reason，给 S5 做修复入口），这次建的会话直接退场（标为 deleted），不留出错的会话。ACP 的登录状态没有不留痕迹的检查办法（检查要建会话），所以「需要登录」在运行中确认后一直记着，直到这家 Agent 正常开出会话、或用户登录后点「重新检测」；Claude 有 `claude auth status`，照旧按检测结果。
- **端到端实测**（分支构建 18788）：OpenCode（免费模型）需求会话经 MCP 读需求、发评论确认、落云端；询问档的写命令、拒绝（记 declined）、改文件都按 OpenCode 自己的权限请求出卡并正确回包。Gemini CLI、Qwen Code、Copilot CLI 本机未登录：开会话 1–3 秒内得到 `400 AGENT_NOT_READY`（「还没登录，请先在 Agent 设置里登录」），状态变为需要登录；Cursor 未安装得到「没有找到」。**这三家登录后的完整回合需要用户先用各自的官方方式登录后再测**（SuDuo 不代登录，ADR-0016）；Cursor、Kimi 需要安装。测试用假 Agent 进程（`test/fixtures/fake-acp-agent.mjs`，SDK 的 Agent 端）覆盖握手、说明、权限三种答法、中断、崩溃续接、闲置续接、令牌重签、OpenCode 权限规则。
- **偏差与遗留**：TD 原计划的进程池（多个会话共用一个进程）改为每会话一个进程（隔离简单、cwd 与 MCP 配置天然按会话分开；闲置回收控制占用）。ACP Agent 的工具超时各家不同，SuDuo 写工具的转草稿时刻目前统一按 600 秒（Agent 若更早超时，卡片仍留作草稿）。只读能力：OpenCode 可做到（权限规则 + plan），其余四家要等登录后实测再标（配置表 readOnlyCapable 暂为 false，房间不能共享它们）。OpenCode 首次 `--version` 检测超时（首启慢），待 S12 调检测超时。

### S3 / S4 独立复核与处理

复核（subagent，读代码对照两个 SDK 的类型与源码）确认的问题，均已修正并补测试：

1. **【高】中断被当成完成**：两个翻译器发的是 `turn.completed` + status interrupted，而队列、运行状态、时间线都只认 `turn.interrupted`（Codex 的归一化就是这样）→ 用户点停止后界面显示「已完成」、排队的下一条自动发出。改为发 `turn.interrupted`；真实链路复验 Claude 与 OpenCode 都是 interrupted，之后照常。
2. **【高】ACP 续接期间点停止，消息仍发给 Agent**（Agent 在时间线外干活，自动 / 完全访问档下会悄悄改文件），紧接着的回合还会并发起第二个进程 → 每个等待之后检查回合是否还是当前回合；同一会话只允许一个启动续接在跑。
3. **【中高】中断不认识的回合静默成功**（本机服务重启前没收尾的回合永远「运行中」）→ 抛「no active turn」，中断服务据此补终态；拿掉排队中的回合时给它一个 `turn.interrupted`。
4. **【中】Claude 重启后丢说明**：系统提示追加不进 Claude 的会话记录 → 建线程时把说明记在线程元数据（`suDuoInstructions`），续接时监督器带回去。真实复验：重启后不调工具也能答出需求编号与标题。
5. **【中】Claude 没有闲置回收**（每个会话常驻一个 claude 进程）→ 与 ACP 一样闲置 10 分钟关查询，下个回合续接。
6. **【中】Claude 查询启动期间点停止再发消息，会并发起两条查询** → 同一会话只启动一条，并发的回合等同一个。
7. **【中，Windows】`.cmd` 路径有空格时起不来**（`cmd /s /c` 去引号）→ 整行外再包一层引号（ACP 运行时与 S1 的检测命令都改了）；Windows 上结束进程用 `taskkill /T` 连同子进程。
8. **【中】Claude「本会话同意」会收下切换模式的建议**，会话悄悄进 acceptEdits 而 SuDuo 仍显示「询问」→ 只收规则与目录建议；只有切换模式建议时不给「本会话同意」。
9. **【低中】改档位立刻作用于正在跑的回合** → 档位与模型改为回合真正开始时生效（与 Codex 按回合下发一致），ACP 的权限策略也按回合开始时的档位答。
10. **【低】ACP 回合中的报错只要带「key」「login」就当成没登录** → 回合中只认协议的 auth_required 错误码；启动与建会话时仍按说明文字判断。
11. **【低】ACP Agent 不支持经 HTTP 接 MCP 时工具静默缺失** → 发一条提示（suduo-tools-unavailable）。
12. 通用模式偏好里「询问」档不再选名为 ask 的模式（Cursor 的 ask 是只读问答）。自动档只放行工作目录里的编辑。

**记下、暂不改**：Claude 的询问 / 自动 / 完全访问档加载用户与项目设置（`settingSources: user, project, local`），项目里自带的 `.claude/settings.json` 的放行规则与 hooks 可以不经 SuDuo 确认卡执行——这也是 CLAUDE.md 等项目说明能生效的前提，与用户在终端里用 Claude Code 打开这个仓库时一致；只读档不加载任何设置。S5 在开工对话框里说明这一点。其余推测项（后台任务自行产生 result、Windows 下孙进程是否随 stdin 关闭退出）待真实使用中观察。

质量门：client typecheck、lint 通过，全量测试 1670 项通过（server 749、web 887、desktop 36、contracts 12）；gate-c 全量在复核修正前、修正后各跑一次，19 步都全过（`GATE_EXIT=0`）。

### S5 前端（接入）（已完成）

- **后端配合**：迁移 021 给 `sessions` 加 `read_only` 列（`approval_mode` 的 CHECK 只有三档；sessions 是父表、迁移在事务里开着外键，不能重建表）——会话的审批档含「只读」，切到只读时原来的档留着；只读只给配置表 `readOnlyCapable` 的 Agent（其余报 400 说明做不到），不受部署上限影响。开会话的请求体统一为 `SessionStartOptions`（Agent、审批档、模型、推理强度，v1 与 v2 三个建会话接口都收）。`GET /api/v1/agents?wait=false` 不等检测、先回缓存与「检测中」（新状态 `checking`），后台补检测，界面轮询；本机服务启动 2 秒后在后台检测一遍。`GET /api/v1/agents/:id/models` 按 Agent 给模型选项（Codex 走 model/list，Claude 用官方别名 opus / sonnet / haiku，ACP 先不给）。会话 DTO 带 `agent`（名字、能否只读、能力）。Claude 运行时接上推理强度（启动带 `effort`，回合间改了用 `applyFlagSettings` 下发）。版本检测超时从 8 秒放宽到 20 秒，超时也算「已安装」（找到了只是读版本慢；实测八家并行冷启动时 OpenCode 会超时）。
- **界面**：设置新增「AI Agent」（通用分段）：每家一行——接入方式、版本、状态、原因，操作（复制安装命令、在终端中登录、重新检测、官网、使用条款、设为默认），默认 Agent 选择，重新检测全部；列表先出、状态轮询补上。开工对话框：能用（或还在检测）的 Agent 不止一家时多一步「选 Agent / 权限 / 模型 / 推理强度」（默认上次用的 → 设置里的默认；不能用的灰显并写原因；Claude 提示会加载仓库自带的 .claude 设置；「管理 Agent」直达设置），只有一家能用时照旧直接开工；Agent 没装或没登录时失败页多一个「打开 AI Agent 设置」。审批坞按卡上的选项出按钮（同意 / 拒绝 + 更多里的本会话同意、始终同意、始终拒绝、拒绝并中断，决定时带上选项 id；没有选项的老卡照旧）。会话页标题旁、会话列表里标出 Agent（Codex 为默认不标）；会话内的权限切换对做得到的 Agent 多一个「只读」；模型切换按会话的 Agent 取选项、不支持切模型的不出现。通用文案去 Codex 化（审批、输入框、运行中、改动面板等改称 Agent；只有 Codex 会发的提示、Codex 分段的设置、房间（S6 前只共享 Codex）仍写 Codex）。
- **实测**（分支构建 18788，无头 Chrome 截图核对）：AI Agent 设置八家状态与操作正确；开工对话框选 Agent、模型列表、权限说明正确；Claude 会话标题旁有 Agent 标签、权限菜单有只读；OpenCode 的审批卡是「Agent 想运行命令」，更多里是它自己的「始终同意」与「拒绝并中断」，拒绝后命令没有执行。
- **偏差与遗留**：模型切换对 ACP 先不做（OpenCode 的模型在会话配置项里，配置表暂不声明 model_switch）；首启向导里的「连接 Agent」一步、按 Agent 名字说的文案（如「Claude Code 想运行命令」）留到 S12；`AskUserQuestion` 的选择题界面未做（仍自动拒绝并让它在回复里问）。
- 质量门：client typecheck、lint、testid 基线（299 个静态、13 个动态，新增动态项在测试里逐项说明）通过，全量测试 1694 项通过（server 752、web 894、desktop 36、contracts 12）。
- **gate-c**：第一次全量失败在「开始会话」——刚启动的本机服务各家还在检测，「检测中」被算进「能用的不止一家」，对话框多出选 Agent 一步，gate-c 的驱动不认识。修正：对话框在还有检测中的 Agent 时先等检测完（最多 20 秒）再决定问不问（虚拟机里只有 Codex 能用，照旧直接开工）；gate-c 驱动也认得这一步（本机装了多家时按默认选项开工）。重跑 19 步全过（`GATE_EXIT=0`）。
- **独立复核与处理**：
  1. **【高】Codex 会话中途切进 / 切出只读，线程级的「关掉所有者 MCP 与连接器」不重新下发**（只在建线程、续接时带）。实测（Codex 0.159.2）：对已加载的线程再 `thread/resume` **不会**套用新配置（令牌、关掉 MCP 都不生效）；先 `thread/unsubscribe` 再续接才生效。修正：Codex 运行时记下每个已加载线程的续接参数与是否只读，回合跨了只读就先卸载再带新配置续接（续接失败时下个回合再续）；续接一个已加载的线程（如令牌重签）也先卸载。真实链路复验：询问 → 只读 → 询问，SuDuo 工具每一轮都可用。
  2. **【中】开工选项总是发审批档，且用的是没按部署上限裁剪的默认档** → 没动过就不发（服务端用默认档并裁剪）；选择器按上限禁选更高档、默认档按上限显示。
  3. **【中】「新开会话」等 Agent 列表期间可以连点，建出两个会话** → 先切到「检查中」再等。
  4. **【中】先选只读再换成做不到只读的 Agent，显示只读、提交的却是默认档** → 换 Agent 时放下只读。
  5. **【中】开工选项绕过了推理强度的屏蔽（会卡住回合的 ultra）、档位名没翻译** → 与会话里的模型切换共用 `offeredEfforts` / `effortName`。
  6. **【中低】「管理 Agent」链接不关对话框**（模态框盖在设置页上）→ 先关对话框。
  7. 审批卡保留 Agent 给选项起的名字（Gemini 的两个「始终同意」能分开）；版本检测超时的原因在设置页显示；开工选完全访问也先确认一次；没有同意或拒绝选项时不显示回车 / Esc 提示；开会话请求体的多余字段报「只接受这几项」；开工选项在打水位线等远程准备之前就校验；启动预热的定时器在本机服务关闭时清掉；删掉没用上的字典键；英文句首大小写。
  8. 「只读」的说法改成「不改这台电脑上的文件」：Codex 的只读沿用房间档（只读沙箱、可联网），不承诺「不运行会改东西的命令」（联网命令仍可能有外部副作用）。**记下**：Claude 的只读不加载任何设置（包括项目的 CLAUDE.md），这是只读档安全优先的取舍。
- 复核后质量门：client typecheck、lint、testid 基线通过，全量测试 1697 项通过（server 753、web 896、desktop 36、contracts 12）。gate-c 全量（复核修正后）19 步全过。

### S6 房间共享任意 Agent（已完成）

- **云端**：迁移 016 把 `agents.kind` 的固定 CHECK 换成格式校验（`^[a-z][a-z0-9-]{0,31}$`，与 JSON Schema 的 pattern 一致），唯一约束仍是（所有者、设备、种类）；契约 `AGENT_KINDS` 与 `agentKindName`（产品名不随语言变，不认识的种类原样显示），Agent 的英文兜底标签按种类写（“陈思远's Claude Code · MacBook”）；房间「最后一条」的 Agent 作者带 `kind`（老云端没有，按 codex）；`/v2/health` 声明 `agent_kinds_v2`。
- **本机登记**：`AgentPresence` 除 Codex 外，按设备文件 `kindsByServer[当前服务器]` 为每家共享过的 Agent 各登记一个云端 Agent，一起心跳；任一家有开着的共享就常驻。按服务器分开记（与目录关联按服务器区分一致）。新端点 `POST /api/v2/agents/self/kinds`（登记并返回云端 Agent）、`DELETE /api/v2/agents/self/kinds/:kind`（不再提供：停止登记与心跳，云端随后标离线）。老云端不认的种类（400）本代不再重试。
- **只读红线（ADR-0009）**：`AgentCatalogService.roomAgentProblem` = 接上了 + 配置表 `readOnlyCapable` + 设置里没停用，三处把关——登记（不合格的拒绝；设备文件里手写的也不登记；已登记的改成不合格后停止心跳）、执行前（`RoomAgentRunner` 每个任务开工前再查，不合格以「没能在本机开始执行」收尾，新建与续接两条路都经过）、建会话（房间任务会话显式要只读档，做不到只读的被会话服务拒绝；运行时本来也固定只读）。可共享的是实测过只读拦截的 Codex、Claude Code、OpenCode。
- **执行**：`RoomAgentRunner` 按任务的 Agent id 找本机那一家，用它的种类开房间任务会话（每家各自的会话、各自续接）；各家各自对账（一家失败不挡别家）；晚登记上的一家立刻触发对账。各家共用一个队列、一次只跑一个（按家并发等 S8 调度器）。房间固定层与消息作者按产品名写（「你是陈思远的 Claude Code」），规则不再承诺「能跑只读命令」（Claude、OpenCode 的只读不给执行命令）。
- **界面**：共享面板「我的 Agent」每家一行开关；「共享本机的其他 Agent…」菜单列出本机做得到只读、还没登记的各家（不能用的灰显并写原因：需要登录、已停用），选中即登记并按时长共享，云端不声明 `agent_kinds_v2` 时不出现；其他家在哪都没共享着时可以去掉；开关旁写个人订阅的说明（ADR-0016 第 7 条，只告知不限制）。@ 候选、消息、运行状态、申请提醒按「所有者 的 产品名」显示；同一个人同一家有多台设备才带设备名；高亮从云端标签反推时先认已知产品名。
- **OpenCode 只读实测**（S6，之前配置表标 false）：S4 记的「权限规则 + plan」只拦住内置的写文件与 Bash；复核指出所有者自己配的 MCP、自定义工具不经 ACP 权限请求。实测在所有者配置里加一个会写文件的 MCP 并显式放行（含 plan 代理级）：旧注入下 OpenCode 手上有 `marker_write_marker`、`apply_patch`、`task`、`skill`；改为注入工具白名单（read、grep、glob、list、webfetch、todo、`suduo_*`，其余 deny 且关闭，全局与 plan / build 各一份）+ `OPENCODE_DISABLE_PROJECT_CONFIG=1` 后只剩白名单，经 SuDuo 只读会话它回答「没有这个工具」、文件未写；对照组（放行）能写。白名单下房间工具 `suduo_room_history` 照常可用。另：OpenCode 免费模型已不允许从 ACP 调用（「free tier can only be used from within OpenCode」），要用它得配自己的模型服务；实测时临时经 `OPENCODE_CONFIG` 指向中转站（Key 只从钥匙串进进程环境；注意 SuDuo 会去掉子进程环境里的 `SUDUO_*` 变量）。
- **实测**（分支云端 19091 用主库的只读导出 `suduo_s6`，分支本机服务 18788）：一条消息同时 @ Codex 与 Claude Code，两家各建房间任务会话（Claude 的 `agentId=claude-code`）、各自只读回答，回复作者种类正确，让它们写的文件没有出现；OpenCode 同样跑通；重启后按设备文件自动重登、共享仍在；无头 Chrome 截图核对共享面板、@ 候选与运行状态的名字。
- **独立复核与处理**：
  1. **【高】OpenCode 只读没关所有者的 MCP / 自定义工具** → 见上「OpenCode 只读实测」。
  2. **【中高】只读校验只在登记时做**（设备文件手写、配置表以后改回 false、设置里停用都绕得过）→ 登记、执行前、建会话三处把关。
  3. **【中】共享过的种类不分服务器、没法去掉、老云端每 30 秒报错一次** → 按服务器记、去掉入口、400 本代不重试。
  4. **【低中，记下】老 Web 连新云端分不清同一台电脑上的 Codex 与 Claude Code**（老前端写死 Codex，都是只读、无安全风险，但会 @ 错）→ 发版说明要求团队成员一起升级客户端。
  5. 心跳里「换了账号」分支补清其他家；runner 各家各自对账、晚登记立刻对账；标签反推先认已知产品名（所有者名带「's」不拆错）；英文冠词；`kind` 非字符串的报错；停用的写「已停用」、不执行房间任务；补上配置表判定、执行前拒绝、去掉、按服务器等测试。
  ADR-0004：新增的拒绝只有「不能在讨论里执行的 Agent 不登记 / 不执行」，过判据（拿掉它最坏是别人借所有者的 Agent 改文件或产生对外副作用，不可恢复，命中两条红线）；没有新增锁、版本校验、幂等表或 409，重复登记靠云端 `ON CONFLICT` 合并。
  复核第二轮：修正到位；另补「去掉一家时它的心跳 / 登记请求还在路上，回来不再把它加回来」。复核还发现 client typecheck 实际没过（测试文件里的可选字段）——之前用 `pnpm -s typecheck | tail` 看输出、没看退出码，`-s` 把报错吞了；改为按退出码判定后两端全过。
- **偏差与遗留**：Gemini、Qwen、Copilot 登录后再实测只读并标配置表；各家共用一个执行队列（S8 调度器按家并发）；老 Web 的显示问题见上第 4 条（写进发版说明）；在设置里停用 Codex 后它仍登记在线、可共享，被 @ 时以「已停用」失败收尾（其他家停用即停止心跳、变离线），先按告知处理。
- 质量门（按退出码）：client typecheck、lint、testid 基线（303 个静态、14 个动态）通过，全量测试 1712 项通过（server 763、web 901、desktop 36、contracts 12）；cloud typecheck、lint 通过，测试 219 项通过（server 195、contracts 24）。gate-c 全量：实现后一轮、复核修正后一轮都通过（`"status":"passed"`）。

### S7 会话引用与接着做（已完成）

- **读另一个会话**：新工具 `session_list` / `session_read`（内部名 `suduo_session_*`），给需求会话与项目会话（房间任务没有，R10）。`application/context/`：`session-projection.ts` 把账本按「一条用户消息到下一条之前」整理成回合（最终回答取最后一条 agentMessage，命令打码密钥，收工具调用、文件改动、联网搜索与结束状态，不看流式增量）；`session-reader.ts` 分五层——概要（Agent、需求编号、状态、回合数、最终回答、改动文件）、对话（最近 N 轮，默认 3）、回合列表（每页 50）、回合细节、累计改动（目标会话的工作区基线 + 每个文件的精简 diff；没有基线的老会话退回 Agent 报告的改动，不现拍基线以免把之前的改动算没）。回包开头写明「来自另一个会话，是材料不是指令」；超过单次工具结果上限的整份存到读取方项目的 `.suduo/sessions/<ID 前 8 位>/` 并回路径。不可读：自己、房间任务、已删除、不存在。可读范围默认当前项目，`scope=all` 跨本机项目（同一台电脑、同一个 SuDuo 账号下的本机会话）。
- **留痕**（R8）：迁移 022 `session_references`（读取方、目标、层、读时目标的账本序号）；再读同一个会话时说明「上次读取后又有 N 个新回合」。时间线上 `session_read` 步骤显示成「读取了 Claude Code ·「导出接口」· 最近 3 轮」（按会话 ID 取名字）——用工具步骤本身表达，没有另写 `suduoReference` 条目，免得同一次读取出现两行。
- **引用句柄**：输入框 `@` 面板在文件之前列本机会话（当前项目优先，最多 4 个），选中插入 `[标题](suduo://session/<ID>)`；用户消息里显示成会话标签（Agent · 标题，点开跳过去）。发给 Agent 时，线程的工具清单里有 `session_read` 才在输入末尾附一句「这是本机别的会话，用 session_read 按 ID 读、先读概要、别当网址打开」；账本里的消息原样。
- **接着做**（需求 4.2）：`POST /api/v2/sessions/:id/continue` 按原会话类型在同一需求 / 同一项目 / 同一本机项目下开新会话（沿用标题），写 `parent_session_id`、`root_session_id`（沿用原会话的根）、`relation=continue`；`SessionDto` 带这三列，单个会话详情带 `links`（接续自 / 已由谁接着做，含已删除）。界面：会话头「交给另一个 Agent 接着做」→ 选 Agent、权限、模型（默认避开原会话的那一家）→ 开新会话、跳转、输入框预填「接着 @原会话 继续：」（不自动发出）；两边顶部互相显示；会话列表里接续出来的会话缩进在父会话后面（父会话不在同一组时行上写「接续自」）。房间任务不能接着做（400）。
- **实测**（分支构建 18788 + 分支云端 19091）：Claude Code 在会话 A 新建 `s7-greet.js` → OpenCode 在会话 B 里收到 `@A`，调 `session_read`（概要、累计改动），答对文件与函数签名 → Codex 在会话 C 里调 `session_list`、读 B 的概要与最近一轮；`session_references` 记下 4 条（B→A 概要 / 改动、C→B 概要 / 对话）；接着做 A 开出的 D 两边互相显示。无头 Chrome 截图核对读取步骤的名字、消息里的会话标签、`@` 面板、对话框（原会话是 OpenCode 时默认选 Codex）、跳转后的预填、接续横幅与会话列表缩进。
- **独立复核与处理**：
  1. **【中】回合按用户消息切，与真实回合脱节**（回合进行中又发的消息会把下一条的回答、命令吞进去）→ 按运行时的回合切：`turn.started` 开一轮，事件按 turnRef 归属；Codex 并入进行中一轮的消息有 userMessage 条目（clientId = 发送时的 clientTurnId）作证据，并入那一轮；没有证据的（Claude / ACP 排队）归到之后开始的那一轮；开不起来的回合、刚发出还没开始的都单独成轮。真实账本复验（Claude、OpenCode、Codex）一致。
  2. **【中】改动层的 diff 只裁首尾、单个 hunk**（千行文件改两处会变成近千行删除 + 近千行新增，再被截断后只看得到删除）→ 新 `line-diff.ts`：去掉首尾相同行后用 Myers 算最少改动、多个 hunk 各带 3 行上下文；改动太多时按整段替换并注明；每个文件不再截断，整份放不下时连同 diff 一起存文件；最多给 60 个文件的 diff，其余列名字。
  3. **【中】没关联 SuDuo 项目的本机会话也给「接着做」，新会话却读不了原会话** → 会话页只对需求会话、项目会话（新版）显示「接着做」，`@` 面板也只在这类会话里列会话（服务端接口照旧允许）。
  4. **【中】预填首条消息在开发模式（StrictMode 跑两遍 effect）下会丢** → 取不到时保留已取到的，换会话才清。
  5. 读自己不再拒绝（线程重建后 Agent 不记得之前的对话，读自己是恢复办法；不过 ADR-0004 判据），回包注明「这就是当前会话」；关联的远程项目在别的需求服务上的会话不列、不读（需求 4.1「同一个 SuDuo 账号」）；`scope=all` 改为含已归档、不含房间任务与已删除（与当前项目范围口径一致）；命令输出、工具参数与结果、`.env` 一类文件的改动打码；会话 ID 不分大小写；回包加结束标记；回合投影按（会话、账本序号）缓存；回合列表一回合一行、翻页越界说明共几页、落盘文件名带页码 / 轮数；`@` 面板的会话列表失败或半分钟后重取；对话框重开清掉上次的错误；迁移 022 顺手给 `parent_session_id` 建索引。
  ADR-0004：没有新增锁、版本校验、幂等表或 409；新增的拒绝只有读房间任务（R10）、读已删除、读别的账号的会话（需求 4.1）与接着做房间任务（R10）。
- **偏差与遗留**：`handoff_read` 移到 S11（交接包在那里才有）；工具服务没起来、退回 dynamicTools 通道的线程不记工具清单，消息里引用会话时不附「用 session_read 读」的提示；只认新位置的工作区基线，迁移前留在 `.suduo/baselines` 的老基线读「改动」时退回 Agent 报告的改动；没关联 SuDuo 项目的本机会话没有工具上下文，拿不到会话工具（与需求工具一致）；工具清单在建线程时定下，S7 之前建的线程续接后也没有会话工具，新会话才有；会话树没另开 `?tree=1` 接口，列表按 `parentSessionId` 在每天分组里缩进；接着做暂时只能同目录（独立目录随 S10 并行试做的工作目录一起做）；删除根会话时询问是否连带子会话（R11）随 S8 委派一起做。
- 质量门（按退出码）：client typecheck、lint、testid 基线（313 个静态、14 个动态）通过，全量测试 1742 项通过（server 780、web 914、desktop 36、contracts 12）。gate-c 全量：实现后一轮、复核修正后一轮都通过。

### S8 委派与运行面板（已完成）

- **本机调度**（2.7，S1-5 移到这里）：`application/scheduler/turn-scheduler.ts`——每个回合开始前拿名额、终态还名额；每家默认 2、合计默认 4（设置「AI Agent · 同时运行」可改 1–8，改了立即按新上限放行）；超出的排队不拒绝（R4），按先后、某一家满了不挡别家；同一会话一次只放行一个。会话里已有回合在跑、又没有排队或正在开的项时再发的消息照旧由运行时并入或排在会话内；运行时自己接着开的回合（Claude、ACP 会话内排队）在 `turn.started` 时补登记，照样占名额。终态先于登记到达时立即还；每 30 秒对账（账本里已不在跑的、拿到名额 5 分钟仍没开起来的收回）。房间任务（`waitForTurn`）、委派、用户消息都经它。`GET /api/v1/scheduler`、`POST /api/v1/scheduler/:id/promote|cancel`（取消运行中的 = 中断它的回合）。
- **排队的消息**：名额满时 `POST /messages` 先登记消息、返回 `turnRef: null` + `queued`（契约 `SendMessageAccepted.turnRef` 改为可空），账本记 `turn.queued`；轮到时按会话**现在**的权限 / 模型开回合（排队期间被删除或归档就不开）、补一次回合前存档，记 `turn.dequeued{reason:"started"}`；取消、会话不可用、开不起来分别记 `turn.dequeued{reason}` / `turn.start-failed`。队列只在内存里：启动时给重启前还排着的消息补 `turn.dequeued{reason:"restart"}`（界面说明「没有发出，需要的话请重发」）。会话里已有排队项时再发的排在后面。前端：排队行在轮到前显示、可取消；本地队列认得服务端排队（等名额期间不算归属超时，没发出就暂停）。
- **委派**（2.10 / 4.4，需求 4.3）：迁移 023 `delegations`；`application/collab/delegation-service.ts` + `delegation-tools.ts`；工具 `agent_list` / `delegate_start` / `delegate_wait` / `delegate_send` / `delegate_cancel`（内部名 `suduo_*`），给需求会话与项目会话。子会话与发起会话同一需求 / 项目、同一目录，`relation=delegate`，权限取两者低的（R3），开场附角色说明、不挂委派工具与对外写工具（深度 1，R2；评论由发起会话发）——线程续接失败重建时同样套用。首条消息是任务与相关文件。`delegate_wait` 最长 min(240 秒, 工具超时 − 30 秒)，到点给进度；做完组装结果（最终回答、改动文件、增删行数）。发起 Agent 挂在 `delegate_wait` 上时让出它的名额（子会话要的可能正是同一家的名额，不然两边互等；收回时可能暂时超出上限一个）。结果交回三条路：发起 Agent 正在等（发起回合还在跑才记「已交回」）、勾了自动交回就在发起会话空下来时开新一轮、否则卡片上「让原 Agent 继续」。委派只认自己发给子会话的消息（发出前按 clientTurnId 记下；归属的回合按证据认：子会话的 userMessage 条目（Codex 并入进行中一轮时只有它可信）> 发送回执 / 排队开起来的出队记录，开始、结束先于回执到达的先记着、回执来了再认）：这些消息都结束才算做完（排着的补充、Claude / ACP 会话内排着的下一轮、Codex 并入进行中一轮的都算它的；结局汇总：有做完的算做完，否则有失败的算失败，否则已取消）；用户在子会话里自己接着聊的回合不改委派的状态与结果；`delegate_send` 让它回到运行中。停止子回合（卡片、运行面板、子会话页）记「已取消」、不交回；叫停时还在开的回合，开起来就停掉；取消委派只撤 / 停委派自己的消息与它自己开的回合，补充并入了用户在子会话里正在跑的那一轮时不中断用户的回合；停止级联（R7）问是否一并停止，默认是。重启：排队中的委派把重启前排着、没发出的那几条（委派发的）在本机服务开始监听、线程续接之后重发，子会话里说明「已自动重新排队」；在跑的标「已中断」。用户也可以在输入框 `@Agent 任务` 发起（只带文字、一次一家，带了附件 / 技能或 @ 了几家时说明、不发送）。
- **审批来源**（R6）：发起会话的待审批列表合并没做完的委派子会话的卡片，带 `origin`（子会话标题、Agent、任务），审批坞标「来自委派：Claude Code · 任务」。
- **界面**：委派卡片（状态、等审批数、结果与 +N −M、停止、打开子会话、让原 Agent 继续、子会话已删除）；侧栏「运行」入口与运行面板（按 Agent 分组、运行中 / 排队、先跑这个、取消、停止——会话有没做完的委派时就地问是否一并停止）；设置里的并发上限（只列能用的 Agent）。
- **删除连带子会话**（R11，S7 遗留）：会话详情带 `links.descendantCount`；删除对话框在它往下还有会话时多一个「同时删除它往下的 N 个会话」（默认勾选，查到之前不让确认）；`DELETE /api/v1/sessions/:id?withChildren=true`；子会话上没做完的委派先取消，删后父会话的卡片显示「子会话已删除」、结果照留。
- **顺带修 S4 的 ACP 问题**（S8 实测发现）：OpenCode 配 GPT 类模型时用 `apply_patch` 改文件，ACP 数据里没有 diff 内容也没有位置，改动只在 `rawOutput.metadata.files` → 从那里取（新增给全文、删除给原文、修改与改名给 diff 片段），委派结果与改动卡片才有文件与行数；同一原因，「自动」档按位置判断「在不在工作目录里」时空列表恒为真、越界补丁也会放行 → 改为从位置、diff、输入路径与补丁头取路径（相对路径按工作目录），取不到就出确认卡。
- **实测**（分支构建 18788 + 分支云端 19091）：Codex 主动委派给 Claude Code（排队 → 运行，子会话的命令确认出现在发起会话审批坞并标来源，完成后 `delegate_wait` 拿到结果，子会话没有委派工具，文件确实生成）；用户 @OpenCode 委派 + 让原 Agent 继续（发起会话新开一轮接着做）；Codex 上限 1 时第二条排队（`message.submitted → turn.queued → turn.dequeued(started) → turn.started → turn.completed`），调大上限后排队项立即开始；停止级联（子回合 `turn.interrupted`，委派「已取消」）；OpenCode 委派新建文件后卡片显示「改了 1 个文件 · +3 −0」，删除子会话后卡片显示「子会话已删除」；委派结束后在子会话里接着聊，委派状态、结果不变、父会话没有多一轮；排着一条时重启本机服务，那条记 `turn.dequeued(restart)`、对话流里有说明；Claude Code 上限 1 被占着时委派排队，重启后自动重新排队并完成（`turn.dequeued(requeued) → message.submitted → turn.started → turn.completed`）；子会话的工具清单没有委派工具与 `comment_submit`；Codex 子会话在回合进行中收到补充消息，两条消息都并入同一轮（两条 userMessage），这一轮结束委派即「已完成」，回答包含补充的要求。无头 Chrome 截图核对委派卡片、运行面板、并发设置、删除对话框、重启说明。
- **独立复核与处理**：
  1. **【高】排队的消息轮到时用的是入队时的会话快照**（排队期间降了权限仍按原权限开、删除 / 归档了照样开）→ 轮到时重读会话与项目、按最新权限 / 模型开，不可用就不开并记一笔；删除或归档时撤掉它在队列里的项。
  2. **【高】重启后排队中的用户消息永远显示「会自动开始」** → 启动时收尾（见上）；取消排队失败时报错。
  3. **【高】委派结束后子会话的每个新回合都会重新「完成」委派，勾了自动交回还会反复给发起会话开新一轮** → 只跟没结束的委派。
  4. **【中】取消与建子会话 / 发消息竞态，取消可能失效、状态被写回运行中** → 建完子会话、发完消息都重读，已取消就不发 / 停掉刚开的回合，不再无条件写状态；排队状态改由子会话的 `turn.queued` 驱动。
  5. **【中】前端本地队列不认识服务端排队**（10 秒归属期限暂停；排队期间又发的消息另排一张票，到 Codex 时两张同时放行）→ 见上「排队的消息」；调度器同一会话一次只放行一个。
  6. **【中】Claude / ACP 会话内排队的回合不占名额** → `turn.started` 补登记。
  7. **【中】`delegate_wait` 在发起回合已停时仍记「已交回」** → 发起回合结束即结束等待，只有发起回合还在跑才记。
  8. **【中】子会话线程重建后丢角色说明、委派工具又挂回去** → 重建时同样套用。
  9. **【中】子会话拿到了对外写工具 `comment_submit`，它的确认卡在父会话里不标来源** → 子会话不挂写工具；工具确认卡也标来源。
  10. **【中，与规格不符】重启时排队中的委派被标「已中断」** → 重新排队。
  11. 改并发上限立即放行；停止子回合记「已取消」、不交回；运行面板停止时问级联；房间任务排队中被叫停直接撤掉（不等轮到再中断）；`waitForTurn` 被取消也记 `turn.dequeued`；S7 回合投影把被取消的排队消息单独算一轮，不并进下一轮；排队行按 `clientTurnId` 对上（原来任何回合开始都会把所有排队行标成已开始）；删除对话框在子会话数查到前不让确认；输入框 @Agent 不悄悄丢附件、不只发给第一家；子会话已删时补充消息报 404（原来 409）。实测中另发现排队相关说明用了 info 级、被对话流过滤掉（info 级只收进会话头）→ 改为工作台自己的提示级别。
  ADR-0004：没有新增锁、版本校验、幂等表或用于并发冲突的 409；超出上限一律排队，删除连带只是询问（R11 非红线）。新增的拒绝：深度 1 的运行时拒绝（子会话调用委派工具、对子会话发起委派）——需求写的是「靠不提供工具实现」，主机制仍是不挂工具（重建时也不挂），运行时拒绝只作兜底，过判据：拿掉它最坏是多层委派多花回合与额度，人能停掉恢复，不触红线，但它保的是用户拍板的业务规则 R2，不是一致性守卫，保留；其余是前置条件与输入校验（目标 Agent 没接上 / 停用、并发值越界、任务为空、操作已不存在的队列项）。
  **复核第二轮**（核对上面的修法）：上轮高、中项大多修好，名额计数没有永久泄漏或重复计数的路径；新发现并处理——
  1. **【中】重启收尾按「之后有回合开始」近似判断，会漏掉同一会话后面的排队项**（前端永远显示排队、本地队列卡住）→ 每次放行都记了出队，去掉近似，只认出队与开不起来的记录。
  2. **【中】委派在第一个回合结束时就算做完**（排着的补充、会话内排着的下一轮被忽略，交回半截结果）→ 按 clientTurnId 跟踪委派自己的消息，都结束才算做完；同时只认自己的消息，用户在子会话里自己排的消息被取消不再把委派记成已取消；做完后退订。
  3. **【中】排着的委派轮到了、回合还在开时取消不会中断**（子 Agent 照做、卡片却显示已取消）→ 自己的回合在委派已取消时一开始就中断；运行面板对还在开的运行项点停止，开起来就中断（原来静默无效）。
  4. 中低与低：回合还在开时又发的消息排在它后面（原来会抢先开回合、名额少算）；重启后重发委派等开始监听、线程续接之后（原来在构造阶段就发、会跳过 MCP 续接）；会自动重排的说明不再叫人重发；重发只发委派自己排着的那几条（原来取会话最后一条消息，可能是用户的）；归档 / 删除撤队记对原因（原来都记 cancelled）；会话事件监听一个出错不挡别的（原来会跳过还名额）；发起 Agent 等结果时让出名额；等结果只在发起会话真的没有回合在跑时才结束（Claude / ACP 撤掉会话内排着的回合也发 `turn.interrupted`），是否交回按本机调度判断（不受重启前遗留的「在跑」回合影响）；属于回合的 `turn.start-failed` 不再被排队分支吞掉；开不起来的排队消息按失败暂停本地队列。
  **复核第三轮**：第二轮的修法（N1、N4、N7、N9、N10、N13、重启顺序）都到位；新发现并处理——
  1. **【中高】Codex 子会话在回合进行中收到补充后，委派永远停在运行中**（消息并入进行中的一轮，回执给的回合 ID 不会出现在账本里；回合结束时只去掉了第一条）→ 以子会话的 userMessage 条目（clientId = clientTurnId）作为强证据对上真正的回合；回合结束时去掉所有对上的条目。
  2. **【中】回合开始时「先认第一条还没对上的」会把用户自己的回合当成委派的**（委派排着、用户的消息先轮到时，委派被记成已完成、取消时还会中断用户的回合）→ 去掉这条规则，只按回执、出队记录与 userMessage 证据认；开始 / 结束先于回执到达的先记着。
  3. 低：幂等键改用随机串（同一毫秒两次补充会撞）；取消只撤 / 停委派自己的消息（原来会连用户在子会话里排的一起撤、跑的一起停）；重启重发改走统一的发送路径（处理回执与发送期间被取消）；委派的消息有在跑的时卡片不显示「排队中」；发送失败且没有别的消息时退订；重启收尾只给委派的未发出消息按 clientTurnId 取内容（原来把这些会话的全部消息读进内存）。
  **复核第四轮**（只看委派消息跟踪，模拟 20 个场景）：用户回合与委派交错不再误认，取消后迟到事件、排队开起来时已取消、发送期间被取消都正确；新发现并处理——
  1. **【中】Codex 并入进行中一轮后一直没等到 userMessage 证据（那一轮被停掉时 Codex 丢掉还没取的输入、不再记条目），委派永远停在运行中** → 记下「发送时子会话有回合在跑、运行时会并入」，子会话一轮结束且空下来后，这类没证据的按这一轮的结局一起收掉。
  2. **【中低】还有别的消息在做时补充发送失败，错误被吞掉、发起 Agent 以为发出去了** → 状态不变，报错给调用方。
  3. **【中低】取消委派会中断用户在子会话里自己的回合**（委派的补充并入了那一轮时）→ 只中断委派自己开的回合（回执 / 出队记录的回合与证据一致），并入别人回合的直接不再等。按 ADR-0004「不毁人的工作」先这样定，**待用户确认**。
  4. 低：发送期间被取消、发送又失败时退订；结局不再取决于最后结束的那一条（排着的补充被撤时主任务那轮已做完算做完）。
- **偏差与遗留**：独立工作目录（`workspace: isolated`）与 `delegations` 表的 `parent_turn_id`、`tool_call_id`、`workspace_mode` 列随 S10 试做一起做；委派卡片用 `delegation.updated` 事件表达（发起会话时间线取同一委派最新一条），没有另写 `suduoDelegation` 条目；卡住提醒（等审批 10 分钟 / 无事件 15 分钟写提醒）没做，卡片上显示等确认数，随 S11 / S12 做；额度错误时「换一个 Agent 重试」没做（失败原因照写在卡片上）；队列变化没走 SSE 推送，运行面板轮询（打开时 2 秒、关着 10 秒）；审批坞按来源加标签、没有分组；「已按发起会话降为 X」的提示没做（权限取低照做）；`delegate_wait` 上限按统一的工具超时（600 秒）算，ACP 各家实际超时不同（S4 遗留），Agent 更早超时时可以再调一次 wait；委派只带文字（附件、技能在子会话里再发）、一次一家；排队的消息轮到时线程绑定与消息内容仍是入队时的（期间线程被重建的极少见）；本机服务启动恢复已挂线程时有一条「恢复 runtime thread 失败」后台报错，不是 S8 引入（不含 S8 的主栈重启也有），另查。第四轮复核记下、未处理的小概率问题：Codex 在回合收尾那一刻并入的补充会记进旧回合但不再推理（委派照样报做完）；发送结果不确定的失败（如开回合超时，回合其实可能开了）照样记失败；已轮到、开回合还在途时本机服务退出，重启后会当成「没发出」重发一次；取消时靠中断服务把 Codex 幽灵回合认作「已停」的报错文案只在 0.143 实测过（没证据的并入条目现在取消时直接去掉，不再走这条）。
- 质量门（按退出码）：client typecheck、lint、testid 基线（339 个静态、15 个动态）通过，全量测试 1797 项通过（server 825、web 924、desktop 36、contracts 12）。cloud 未改动。gate-c 全量（Lima 虚拟机）：实现后一轮通过；之后每轮复核修正后各跑一轮，均通过（其间三次在开头自检时虚拟机连中转站超时，属网络问题，网络恢复后重跑即过）。

### S9 交叉评审（已完成）

- **发起**：会话头「请另一个 Agent 评审」（选评审 Agent——只列做得到只读、能用的，默认避开这个会话的那一家；关注点：正确性 / 安全 / 测试 / 是否满足需求，默认全选；补充说明）或主会话的工具 `review_request`（内部名 `suduo_review_request`，需求会话、项目会话有；子会话、评审会话没有，调用时也拦）。`POST /api/v1/sessions/:id/reviews`、`GET` 同路径列表、`POST /api/v1/reviews/:id/apply|cancel`。做不到只读的 Agent 报「做不到只读，不能做评审」（R3，配置表 `readOnlyCapable`）。
- **评审会话**：迁移 024 `review_reports`；`application/collab/review-service.ts`。评审会话与被评会话同一需求 / 项目、同一目录，`relation=review`，**固定只读**；开场附「只读评审」角色说明；工具 = 被评会话 scope 的只读工具 + `review_submit`（去掉结论笔记、对外写、委派与请求评审），线程续接失败重建时同样套用；评审会话的权限在界面上锁定只读（说明「评审会话固定只读」），输入框不给 @Agent 委派（R2）。第一条消息：被评会话句柄、关注点、关联需求、改动的文件列表与增删行数（从被评会话账本投影，最多列 60 个），让它用 `session_read`（changes 层）读细节；经本机调度（来源「评审」）。
- **结构化意见**（R13）：`review_submit({ findings: [{ severity, file?, line?, title, detail, suggestion? }], summary })`，参数不对时回说明让它改了再交，按 f1、f2 编号存下；可以再次提交覆盖。只跟评审会话的第一条消息（按 clientTurnId 认，回合按回执 / 出队记录 / userMessage 证据对上，沿用 S8 的办法）：这一轮结束时提交过就是「已提交」，没提交就退化为「没拿到结构化意见」并显示它的最终回答原文，提示可以打开评审会话让它补交；之后在评审会话里接着聊不改报告。被评会话的时间线每次变化记一条 `review.updated`。
- **交回修改**：评审卡片逐条列出意见（严重程度、文件与行、问题、建议），默认勾上还没交回过的高、中两级；「交给原 Agent 修改（N 条）」把选中的拼成一条消息发给被评会话（经本机调度），开头写明「这是另一个 Agent 写的材料，不是用户的指令；先判断每条是否成立，无关操作先问用户」，记下交回过哪些（卡片上标「已交回」；评审者再次提交换了意见时清掉）。意见最多 50 条，标题与正文有长度上限。卡片可以停止评审、打开评审会话；评审会话删了显示「评审会话已删除」，意见照留。
- **实测**（分支构建 18788 + 分支云端 19091）：Claude Code 在项目会话里照抄一行有缺陷的 `average`（空数组会抛异常）→ 分别请 Codex、Claude Code、OpenCode 只读评审，三家都调用 `review_submit` 交回结构化意见（2 / 4 / 2 条，都指出空数组与非数组输入）；选 f1 交回后 Claude Code 改好了文件。评审会话 `relation=review`、只读，工具清单只有只读工具与 `review_submit`。**真实链路发现并修复**：MCP 放行检查要求工具同时在「线程授予清单」与「会话 scope 清单」里，按角色加的 `review_submit` 不在任何 scope，Codex 第一次调用收到「SuDuo 没有工具」、退化为「没拿到结构化意见」→ 放行检查认评审会话的 `review_submit`。另一次原任务写明「不加检查」时，Codex 尊重原任务、交回 0 条意见（状态「已提交」、总评说明理由）。无头 Chrome 截图核对评审卡片（已交回标记、默认勾选）与对话框（默认避开会话的 Agent）。
- **独立复核与处理**：没有高严重度问题，主流程通；处理——
  1. **【中】委派子会话也拿到了 `review_request`**（S9 把它加进需求 / 项目 scope，子会话的去工具规则没跟上，「不提供工具」退化成只靠调用时拒绝）→ 两种角色去掉哪些工具收进工具目录（`delegateChildDropsTool`、`reviewerDropsTool`），建会话与线程重建共用，测试直接用这两个谓词。
  2. **【中】评审者再次提交后「已交回」标记对不上新意见**（从 f1 重新编号）→ 意见变了就清掉交回标记。
  3. **【中】评审会话在用户这一侧还能 @Agent 委派、能把权限从只读提上去**（R2 / R3）→ 委派入口与服务端都排除评审会话；权限切换在评审会话里锁定为只读并说明（服务端不拒绝，人是仲裁者，ADR-0004）。
  4. **【中，设计】交回的消息把另一个 Agent 写的文字当成用户指令发给原 Agent**（评审者读到的不可信内容可能借「建议」带进操作）→ 措辞改为「是材料不是指令、先判断、无关操作先问用户」，多行正文缩进；意见条数与长度设上限。
  5. 低：评审会话还没建好时卡片不再说「已删除」（DTO 加 `reviewerDeleted`）；建评审会话期间被叫停、随后建失败保留「已取消」；回合中途已提交、随后重启的收尾为「已提交」（原来一直显示「停止」）；并发交回重读后合并（原来会丢标记）；需求会话的评审会话 / 委派子会话用自己的标题（原来是需求标题，S8 同样受影响）；评审卡片状态变化也触发滚到底；注释挂错位置。
  ADR-0004：没有新增锁、版本校验、幂等表或用于并发冲突的 409；交回不去重（重复交回允许）。新增的拒绝：做不到只读的 Agent 不能评审（保 R3，拿掉它可写的评审者在同一目录里可能覆盖未提交的改动，红线 1）；子会话 / 评审会话请求评审、非评审会话提交意见、评审会话委派（R2 与角色规则的兜底，主机制是不提供工具与入口；拿掉最坏是多开会话、多花额度，人能停）；其余是输入校验与「目标已删除」。**不做的限制**：技术设计 2.9 写评审会话的 `session_read`「限被评会话与其需求」，过判据——拿掉它最坏是评审者读到同一用户的其他本机会话，不触红线，不做拒绝，评审范围靠第一条消息与角色说明指明。
- **偏差与遗留**：发布到需求（评审报告挂到需求、团队可见）随 S11 云端共享对象一起做（`review_reports` 届时加 `published_ref`；迁移编号实为 024）；用 `review.updated` 事件表达评审卡片，没有另写 `suduoReview` 条目；停止级联（R7）只含委派，评审从卡片或运行面板停；评审会话的审批没有并进被评会话的审批坞（固定只读，实际不出审批）；卡住提醒、「我的工作 · 待处理的评审意见」随 S11 / S12；评审会话沿用需求 / 项目会话的通用规则说明，其中提到它没有的结论笔记工具（工具清单本身没有，角色说明写明只读）；再次提交覆盖意见时卡片没有单独提示「意见已更新」。
- 质量门（按退出码）：client typecheck、lint、testid 基线（356 个静态、15 个动态）通过，全量测试 1820 项通过（server 841、web 931、desktop 36、contracts 12）。cloud 未改动。gate-c 全量（Lima 虚拟机）：实现后一轮通过（其间一次 settings-codex 两次自检对不上，属中转站网络抖动，重跑即过）；复核修正后一轮通过（`"status":"passed"`）。

### S10 并行试做（已完成）

- **会话在独立目录里干活**：`sessions.workspace_path`（迁移 019 已留）开始写入；`WorkspaceContextResolver` 按它给执行根（`isolated`），本机服务里共用一个，开线程、续接、重建、开回合（`projectRoot` / `workspaceRoots`）、中断、启动时恢复已挂线程都经它；试做会话不给原目录做回合前存档；会话工具的上下文（需求材料、相对路径）与「改动」面板的基线和 diff 都按执行根。
- **WorktreeManager**（`application/collab/worktree-manager.ts`）：`inspect`（是不是 git 仓库、HEAD、分支、有没有未提交改动）、`freeBranch`（`suduo/<REQ-n 或 trial-组号>-<agent>`，git 里已有、别的试做还在准备、同一组已分出去的都避开，加 `-2`；同一本机项目的分配排队进行；真建时 `worktree add -b` 遇到同名分支会失败，不动别人的分支）、`createBranch`（`git branch --no-track <分支> <基点>`，同名分支已存在会失败）与 `addWorktree`（`git worktree add <SuDuo 数据目录>/worktrees/<本机项目>/<组>/<agent> <分支>`）分两步、分开记、`setup`（在 worktree 里用 shell 跑准备命令，15 分钟超时：先 SIGTERM 整个进程组，宽限 5 秒后 SIGKILL，不等后台进程占着的输出管道，超时算失败；留输出末尾）、`changes`（在索引的临时副本里 `add --intent-to-add` 再与基点比较，含未提交与未跟踪的文件，不依赖 Agent 自己提交，也不动这一版自己的索引；`-z` 原样取路径）、`commit`（仓库没配身份时用 SuDuo 的身份）、`merge`（`merge --no-ff`；有冲突停在冲突状态返回冲突文件（`-z`），git 自己拒绝时返回说明）、`isMerged`（`merge-base --is-ancestor`，与 `branch -d` 的判断一致）、`removeWorktree`（`worktree remove --force` + prune）、`deleteBranch`（`-d` / `-D`）。所有 git 操作在本机，不推送。
- **TrialService**（迁移 025 `trial_groups` / `trial_entries`；`trial-service.ts`）：`precheck` → 发起（2–3 家，同一家可以试两版；不是 git 仓库报错；准备命令记在本机库里，按项目取上次的；项目是仓库里的子目录时记下相对位置，试做会话与准备命令在 worktree 的同一子目录里）→ 后台各版独立（任何一步出错都记在这一版上，不会卡在「准备中」）：建分支（成功才记 `branch_created`）→ 建 worktree（成功才记 `worktree_created`）→ 跑准备命令（失败标「准备失败」并留输出）→ 开试做会话（同一需求 / 项目，`relation=trial`、没有父会话，在 worktree 里；开场附「并行试做」角色说明，告诉它别的 Agent 也在做、只在当前目录改、别切分支别 push；不挂委派、评审、对外写与结论笔记）→ 发任务（经本机调度，来源「试做」）。比较：每版的状态（准备中 / 准备失败 / 排队 / 进行中 / 做完 / 回合失败 / 已中断 / 已删除）、等你确认的操作数、最终回答、相对基点的改动文件与增删、测试类命令与退出码（按测试运行器的写法认）、耗时。采用：先在这一版的分支上提交（`SuDuo 试做：REQ-n · Agent`），再合并到原工作目录当前分支或只保留分支；采用方式与结果记在这一版上（已合并 / 冲突与文件 / git 拒绝的说明 / 已保留分支），组上只记最近一次采用的是哪版；冲突、git 拒绝不算采用成了。采用对话框按组记下的本机项目查原目录现在的分支与未提交改动（`GET /api/v1/trials/:id/repo`，不经云端）。采用、清理、准备都在发起时的本机项目里做（按组记下的本机项目，不随目录关联变）。清理：每版带一份「清理计划」（删不删工作目录；分支 `-d`（提交都已在当前分支里，按 git 现在的状态看）/ `-D`（有没合并的提交，会丢）/ 保留（采用为保留分支）/ 不碰（分支不是这一版建的，同名分支可能是别人的；或已经不在）），确认对话框照它逐条列出（R11）；`-D` 只对确认对话框里写明「会丢」且勾上的版本执行（请求带 `forceBranches`），执行时状态变成要 `-D` 但没确认过的，分支留着请再确认；目录还在被用（还在准备，或这一版的会话 / 从它开的评审、接着做在排队或运行，DTO 的 `busy`）的版本不动、对话框不能勾；`-d` 被 git 拒绝（比如分支设了 upstream）时工作目录照删、分支留着并记下 git 的原话，下次计划按没合并、对话框照原话标出；删了工作目录的会话（含从它开的评审、接着做）归档；全清理完试做结束并删掉空的组目录。本机服务重启时还在准备的版本按发起时的语言记为失败，目录已建出来的记下。
- **从试做会话出去的会话**：评审、接着做（以及接着做的会话再委派）开的新会话沿用原会话的工作目录（`createRelatedSession` 传 `workspacePath`），不回到项目目录；试做会话不能委派（入口不给，服务端也拒绝，R2）。
- **在独立目录里干活的会话页**：会话 DTO 带 `workspacePath`；不给「回到开始前」，「环境」标签只说明（检查点、还原与 git 状态属于原目录）；文件树、预览、用编辑器打开、回答里的路径链接按会话的工作目录（文件接口带可选 `sessionId`）；会话头显示 worktree 路径。结论笔记读写原项目目录（工具上下文的 `notesRoot`；`.suduo` 不进 git，worktree 里没有，写进去会随清理删掉），给它看的笔记路径用绝对路径（相对路径在 worktree 里找不到，长笔记读不全）；材料下载仍按执行根。工作目录删了（试做清理过）的会话不能再接着做、请评审（说明目录已删）。
- **原目录合并进行中**：采用时合并有冲突，原目录停在冲突状态；这时回合前自动存档跳过并在环境页说明（否则会把冲突标记当合并提交提交掉、让 `git merge --abort` 失效）。
- **界面**：开工对话框「选 Agent」那一步（能用的不止一家时出现）左下角「并行试做」→ 表单：选 2–3 个 Agent、任务说明、准备命令（带出记下的）；原目录有未提交改动时提示「试做版本基于最近一次提交」并给「先存检查点」（告知不拦）；不是 git 仓库时说明做不了。比较页 `/trials/$trialId`：各版并排一列，还有版本在准备 / 运行时每 3 秒刷新；做完的「采用这一版」（合并到原分支 / 保留分支稍后提 PR）；都停下后放慢到 15 秒，全清理完不再刷新；采用对话框说明合并到原目录现在的分支、原目录有未提交改动时 git 可能拒绝、之前采用过哪一版；「清理工作目录」确认对话框照清理计划逐条列出、默认勾上没采用的版本，还在进行的不能勾。试做会话的会话头有「并行试做」链接回比较页。
- **实测**（分支构建 18788，测试仓库 verify-order）：Codex + Claude Code 两版（准备命令 `echo setup-ok` 两版都跑了），各自新建文件并跑 `node --test` 通过；采用 Codex 版合并回 master（分支上一个 `SuDuo 试做：Codex` 提交 + 一个合并提交），清理后两版的 worktree 与分支都删了。Codex + Claude Code + OpenCode 三版：三家都做完、都跑了测试；Claude Code、OpenCode 在自动档下执行命令仍要确认，比较页显示「进行中」看不出卡在审批 → 每版加「等你确认 N 个操作」。实测发现测试命令识别把 `rg --files -g 's10-sum.test.js'` 也算进去 → 改为按测试运行器的写法认。无头 Chrome 截图核对比较页、采用对话框、清理确认对话框。复核修正后再测（Codex + Claude Code）：比较页轮询多次后两版 worktree 的索引都没被改（新文件仍是未跟踪，中文文件名原样显示）；从试做会话委派返回 400；从 Codex 版请 Claude Code 评审，评审会话的工作目录就是这一版的 worktree，交回 4 条意见；先保留 Claude Code 的分支、再合并 Codex，清理计划分别是「保留」与「-d」，清理后 Claude Code 的分支留着、Codex 的分支删了，两版的会话与评审会话都归档；仓库里没有写 `.suduo/trial.json`。界面核对（无头 Chrome）：采用对话框写明合并到 master、原目录有未提交改动、之前采用过 Claude Code；清理对话框逐条列出「删工作目录（里面没提交的改动一起删）」「删分支（它的提交都已在当前分支里）」「保留分支」，默认只勾没采用的；试做会话页没有「回到开始前」。第二轮修正后再测：试做会话的文件树与预览按 worktree（原目录没有的新文件列得出、读得到）；给合并过的 Codex 分支设 upstream 后清理，`-d` 被拒、工作目录照删、记下 git 原话，再清理时计划变为「-D，会丢」，没确认就留着，确认后删掉，试做结束。
- **独立复核与处理**（第一轮结论：不建议提交）：
  1. **【高】试做会话里还能委派、请评审、接着做，建出来的会话跑在原目录**（违反 R2 与隔离）→ 委派入口与服务端都排除试做会话；评审、接着做开的新会话沿用原会话的工作目录。
  2. **【中高】清理删的分支可能不是这一版的**：worktree 没建成的版本也会 `-D` 同名分支；先保留 A 的分支、再合并 B，组上的采用记录被覆盖，A 的分支被 `-D`；分支名先算后建，同一家两版或同时发起会撞名；`-d` 失败的处理不清。这些都让「删除前确认」显示的不准（红线 1）→ 每版记 worktree 是否建成与自己的采用方式；清理计划按 git 现在的状态判断合没合并，确认对话框照计划逐条列出；分支名分配排队并避开还在准备的；`-d` 被拒绝时如实说明，再清理一次才按没合并 `-D`。
  3. **【中高】试做会话页的「回到开始前」会还原原目录**（检查点是原目录的）→ 在独立目录里的会话不给。
  4. **【中】比较页每 3 秒改写试做目录的 git 索引**（实测让 Agent 的 `git stash` 失败）→ 改在索引的临时副本里比较。
  5. 中：准备命令存在仓库的 `.suduo/trial.json`，普通会话的 Agent 能改它、换掉下次要跑的命令 → 改记在本机库里；准备途中出错卡在「准备中」、任务发送失败卡在「排队中」→ 兜底记失败并说明；清理会删还在跑的版本 → 还在准备 / 排队 / 运行（含从它开的评审、接着做）的不动、对话框不能勾；项目是仓库里的子目录时执行根算错 → 记相对位置；采用、清理按需求重新解析本机项目（目录关联改过会操作别的目录）→ 按组记下的本机项目；采用对话框补当前分支、未提交改动、之前采用过哪一版。
  6. 低：中文文件名被转义（`-z`）；重启收尾说明固定中文（按发起时的语言）；没有需求编号时提交信息取了标题第一个词（改存编号）；准备命令超时留下子进程（结束整个进程组）；比较页都停下后不再刷新（放慢到 15 秒，全清理完才停）；发起时 agents 里多余字段原样传给建会话（只取权限、模型、推理强度）；清理后留下空目录。
  第二轮结论：四条必修项闭合三条，另修——
  7. **【中高】`.suduo` 跟着 worktree 走**：试做会话的需求卡与 `notes_read` 读不到原目录的结论笔记；从试做会话接着做的会话存的笔记写进 worktree、清理时被一起删掉（红线 1，确认里也没写）→ 工具上下文分出笔记根，笔记读写原项目目录。
  8. **【中】`-d` 被拒后「再清理一次会强删」没实现**（分支设了 upstream 或在别处检出时，`is-ancestor` 判为已合并、`-d` 却拒绝，计划每次都是 `-d`，试做关不掉）→ 记下 git 原话、下次按没合并；`-D` 只执行确认过的（`forceBranches`），确认后到执行前分支状态变了也不会越过确认。
  9. **【中】「环境」标签仍能对原目录存检查点、还原** → 独立目录会话只显示说明。
  10. **【中】采用冲突后，原目录下一次回合前自动存档会把冲突标记提交掉** → 合并进行中跳过并说明。
  11. 中低：清理对话框的「在忙」只看这一版自己的会话、一律提示「已清理」→ 服务端算 `busy`，提示按实际结果；采用对话框依赖目录关联与云端 → 按组查原目录；试做会话页的预览、用编辑器打开、路径链接用原目录（⌘ 单击会打开原仓库的同名文件）→ 文件接口按会话的工作目录。
  第三轮结论：前一轮 12 条都已闭合，没有新的高或中高问题；另修——
  13. **【中】笔记路径相对原项目目录、在 worktree 里解析不到**（笔记超过 1 万字时只给路径，试做会话读不到全文，从它衍生的会话可能凭节选整篇写回、覆盖后半段；有历史备份可找回）→ 笔记根与工作目录不同时，卡片与工具回包给绝对路径。
  14. 低：时间线上的文件改动卡按原目录换算路径（报「不在项目里」）→ 按会话的工作目录；从已清理的试做会话还能接着做 / 请评审（新会话的目录不存在）→ 说明目录已删；`-d` 被拒后的计划文案与 git 原话并排时矛盾 → 写成「强制删除（git 不认它已合并）」；准备命令正常结束后 SIGKILL 计时器没清（进程组号复用风险）→ 结束时清掉；git 的 `hint:` 提示行混进说明 → 去掉。
  12. 低：冲突、git 拒绝也标「已采用」；`worktree add -b` 检出失败时分支留下而记为「没建出分支」→ 分支与工作目录分两步建、分开记；准备命令超时只发 SIGTERM 且等管道关闭 → 宽限后 SIGKILL、不等管道；冲突文件名转义；同时清理两次时把「分支不在」记成失败；只删分支的那次重复归档会话。
- **ADR-0004**：没有新增锁、版本校验、幂等表或用于并发冲突的 409；分支名分配排队是串行化，不拒绝。新增的拒绝或跳过：试做会话委派（R2 兜底，主机制是不给入口与工具；拿掉最坏是试做的对比不公平、多花额度，人能停）；没有工作目录的版本不能采用（前置条件，没有东西可提交）；清理跳过目录还在被用的版本（拿掉它最坏是删掉 Agent 正在写的目录、未提交的改动丢失，红线 1；告知原因，停下后再清理）；`-d` 被 git 拒绝不自动改 `-D`、`-D` 只执行确认过的（没合并的提交会丢，红线 1，须是用户看到「会丢」后确认的；给出路：再清理一次，确认里照 git 原话标出）；合并进行中跳过回合前自动存档（不是拒绝用户的操作，是不替用户做会让 `merge --abort` 失效的自动提交，告知原因）。工作目录已删的会话不能再开关联会话（前置条件：没有目录可用）。其余是输入校验与「不是 git 仓库」。
- **偏差与遗留**：会话菜单「用其他 Agent 也试一版」没做（入口只在开工对话框）；比较视图没有用量与逐文件 diff（看细节打开这一版的会话）；委派子会话在独立工作目录里跑（2.12 提到的选项）没做，委派面板没加工作目录列；worktree 位置不能设置（固定在 SuDuo 数据目录下），准备命令没有设置页入口（在发起表单里改）；试做会话还去掉了结论笔记 `notes_save`；比较页没有停止按钮（R7 在各版会话里停）；发起表单不能逐版选权限与模型（接口支持，表单用默认）；迁移编号实为 025（设计写 027）；试做会话页的文件变化监听与输入框 @ 文件补全（文件索引）仍是原项目目录（worktree 里的改动不会自动刷新文件树，展开目录、预览照常按 worktree 读；「改动」面板按执行根照常刷新）；手动存检查点与还原在原目录合并进行中时照常执行（用户主动操作、可撤回，没加拦截）；评审、委派沿用工作目录与接着做共用 `createRelatedSession`，只有接着做有 http 测试（评审在真实链路里验证）；采用时提交用 `--no-verify`（不让仓库的提交钩子挡住采用，合并时照常跑钩子）；`trialDropsTool` 与 `reviewerDropsTool` 目前去掉的工具相同，分开命名以便各自演变。
- 质量门（按退出码）：client typecheck、lint、testid 基线（387 个静态、15 个动态）通过，全量测试 1850 项通过（server 863、web 939、desktop 36、contracts 12）。cloud 未改动。gate-c 全量（Lima 虚拟机）：实现后一轮通过；三轮复核修正后各跑一轮，均通过（19 步，`PASS`）。
