---
id: suduo-design-multi-agent-001
title: 多 Agent 接入与协作 技术设计（P1 + P2）
doc_type: technical_design
requirement_id: suduo-requirement-multi-agent-001, suduo-requirement-multi-agent-collab-001
expression_spec: v1
updated: 2026-10-08
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
| `mcpToolCall` | **统一工具调用** | `server`、`tool`、`arguments`、`result`、`error`、`status` | Codex MCP；SuDuo 工具（各 Agent）；Claude `mcp__*`；ACP other |
| `webSearch` | 搜索 / 抓取 | `query` | Codex；Claude WebSearch / WebFetch；ACP fetch |
| `plan` | 计划 | 文本 / 步骤 | Codex；Claude TodoWrite / ExitPlanMode；ACP plan |
| `collabAgentToolCall` | Agent 原生子 Agent | 描述、状态 | Codex；Claude Task / Agent |
| `contextCompaction` | 上下文压缩 | — | Codex；Claude compact_boundary |
| `imageView` | 查看图片 | `path` | Codex |
| `notice`（新） | 系统提示 | `level`、`text` | ACP、Claude |
| `suduoDelegation`（新，P2） | SuDuo 委派卡 | `delegationId`、`childSessionId`、`agentId`、`task`、`workspaceMode`、`status`、`resultSummary` | DelegationService 写入发起会话 |
| `suduoReference`（新，P2） | 读取留痕 | `target`（会话 / 交接包 / 评审）、`view`、`atSeq` | ContextService 写入读取方会话 |
| `suduoReview`（新，P2） | 评审结果 | `reviewId`、`reviewerAgentId`、`findings[]` 摘要 | ReviewService 写入被评会话 |

- 老 Codex 线程的 `dynamicToolCall` 继续可渲染；新会话不再产生。
- `extensions.<agentId>` 只供诊断，解析不得依赖。
- 事件类型不变；`ThreadRef.runtimeKind` 填通道名；会话另记 `agentId`。回合结局统一用 `turn.completed` 的 `turn.status`（`completed` / `failed` / `interrupted`）。
- `suduo*` 条目由 SuDuo 自己写入账本（来源 `system:suduo`），与 Agent 事件同一条时间线，前端按类型渲染卡片。

### 2.3 审批载荷中立化

`approval.requested` 载荷新增：`subject`（command / file / permission / question / tool，存储映射到现有 `approvals.kind` CHECK，不改约束）、`options[{id, decision, label?}]`（decision：accept / acceptForSession / acceptAlways / decline / declineAlways / cancel）、`display`（命令、目录、文件、理由）、`origin`（P2：发起该审批的会话角色与委派信息，用于「来自委派：Claude Code · 补集成测试」）。契约里 `ApprovalDecision`（现为字符串联合，`runtime.ts`）增加 `acceptAlways`、`declineAlways`；新增 `ApprovalResolution = { decision: ApprovalDecision; optionId?: string }` 作为 `approve()` 的入参。本机 `approvals.decision` 的 CHECK 只允许现有 4 个值，迁移 020 重建表放宽（做法同 `002_approval_modes.sql`）。

### 2.4 权限档位

沿用现有 `ApprovalMode`（契约 `config.ts`、本机 `sessions.approval_mode`、接口 `approvalMode`），在 `ask / auto / full` 之外增加 `readonly`；`SUDUO_MAX_APPROVAL_MODE` 照常封顶（`readonly` 低于所有档，不受影响）。

| 档位 | Codex | Claude Code（SDK） | ACP（配置表 + SuDuo 客户端策略） |
|---|---|---|---|
| 只读 | `never` + 只读沙箱 + 可联网 | `dontAsk` + `strictMcpConfig: true`（只用 SuDuo 传入的 MCP，claude.ai 账号连接器也被排除，S0 实测）+ `allowedTools` 只放行只读工具（Read、Grep、Glob、WebSearch、WebFetch、TodoWrite、SuDuo 只读工具）；`canUseTool` 其余一律拒绝；`settingSources: []`（不加载用户与项目设置，避免其 allow 规则先于 `canUseTool` 放行写入、避免带上所有者的 MCP）+ `disallowedTools` 列出写入类工具（S0 验证） | 最严格模式；`request_permission` 写入 / 执行类一律拒绝；`fs/write_text_file` 返回错误 |
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

令牌映射到 `{ sessionId, role, scope }`，`tools/list` 按下表返回：

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

守卫 → 令牌 → 角色与 scope → `tools/list` / `tools/call`；写工具（comment_submit）挂起等确认；**服务端自己计时**——在给该 Agent 配置的工具超时到达前（留 30 秒余量）仍未确认，就把确认卡转为草稿（`tool_drafts`）并回复 Agent「已存为草稿，等用户在界面确认」；收到 MCP 取消通知或连接断开时同样转草稿（S0：Codex 超时时既不断开也不发取消，只能靠服务端计时）。

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
| `021_session_tool_tokens` | `(session_id, token_hash, role, scope_json, created_at, revoked_at)` |
| `022_tool_drafts` | `(id, session_id, tool, target_json, content_json, status, created_at, resolved_at)` |
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

`POST/GET /mcp`，`Authorization: Bearer <会话令牌>`；`serverInfo.name = "suduo"`；工具与角色见 2.9；参数 schema 写在 `client/contracts/src/mcp-tools.ts`（新），服务端与测试共用。

### 7.3 契约

新增 `items.ts`、`agents.ts`、`collab.ts`（会话角色与关系、委派、评审、试做、共享对象 DTO）、`mcp-tools.ts`；`runtime.ts` 按 2.5；`registry.ts` 增加 `list()`、`getByAgent()`；`config.ts` 的 `ApprovalMode` 增加 `readonly`，并增加 `DEFAULT_AGENT_ID`、默认并发。

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

### S1 契约与地基（进行中）

- **S1-1（已完成）**：运行时接口以 `approvalMode: RuntimeApprovalMode` 取代 Codex 专有的 `security`；`RuntimeApprovalMode` = 用户三档 + `readonly`，Codex 适配器用 `RUNTIME_APPROVAL_MODE_POLICIES` 换算，房间任务显式传 `readonly`，删除按组合猜房间档的逻辑。**偏差**：用户可选的「只读」档（数据库 `approval_mode` 放宽、界面选择器）移到 S5 与界面一起做，S1 不动会话表的这一列。质量门：client typecheck、lint 通过；受影响 7 组测试 84 项通过。
- **S1-2（已完成）**：Agent 配置表（八家，参数来自 S0 实测或官方核实；无可靠依据的不设最低版本，只记「已验证版本」作提示）、可执行文件解析（覆盖 → PATH → 常见安装目录，Windows 优先 `.cmd`）、状态检测服务（版本、Claude 登录状态只读 `loggedIn`、ACP 登录状态待 S4 握手判断；结果缓存成功 10 分钟、失败 1 分钟；运行中鉴权失败可回灌）、Agent 设置单独存 `agent-settings.json`（不碰 `settings.json`，替代原计划的 `agent_settings` 表）、打开系统终端执行官方登录命令；接口 `GET /api/v1/agents`、`POST /api/v1/agents/:id/recheck`、`POST /api/v1/agents/:id/login`、`GET / PUT /api/v1/settings/agents`。DTO 增加 `runtimeAvailable`（S3 / S4 之前 Claude 与 ACP 为 false）、`verifiedVersion`。本机真实冒烟：claude 2.1.284 ready、Codex ready、Copilot / Gemini / OpenCode / Qwen installed、Cursor / Kimi not_installed；八家并行检测约 8.5 秒（Node 写的 CLI 启动慢）→ S5 界面先出列表、状态逐个刷新。
- **S1-3（已完成）**：迁移 019 给 `sessions` 加 `agent_id`（默认 codex）与会话图列（`parent_session_id`、`root_session_id`、`relation`、`relation_meta_json`、`workspace_path`、`rules_version`；只加列不重建表，新会话角色的 `kind` 约束放到 P2 再扩）；会话记录与 `SessionDto` 带 `agentId`；`RuntimeRegistry` 增加 `list()`、`findByAgent()`（`AgentRuntime.agentId` 可选，老 Codex 运行时视为 codex，同一家 Agent 不能注册两个运行时）；创建会话（项目会话与需求会话）按 `agentId` 找运行时，不传为 codex，指定未接上的 Agent 报 400 并说明是哪家。质量门：client typecheck、lint、全量测试 1618 项通过。
- **S1-4（已完成）**：每个已注册的运行时一条事件消费循环。实施中发现一处多 Agent 下的真实缺陷并修正：连接断开时原来会作废**所有**待审批、恢复**所有**线程——接入第二家 Agent 后，一家 Agent 的进程退出会连带作废别家会话里的确认卡。现在 `orphanPersistedPending` 与线程恢复都按运行时限定（ADR-0017 故障隔离），并加了对应测试。
