---
doc_type: architecture
updated: 2026-08-15
generated_by: su-init-ai
human_verified: false
architecture_scope: client-server
scope_source_roots: ["client/server"]
---

# client/server 架构

> 一句话定位：本机 SuDuo app-server，既是 V2 需求协作的本机 BFF，也是把浏览器工作台和本机 Codex CLI 串起来的会话运行时宿主。｜最后更新：2026-08-15

> ⚠️ 本文由 `/ccb:su-init` 依据仓库证据自动生成，**尚未人工校验**（`human_verified: false`）。请 review 后再作为真相源使用；需要修改直接对话说明。

> 分支归属：本文按 `ccb/req-suduo-v2-requirements-workbench-001` 分支代码校对；该分支尚未合并 `main`。

---

## 一、概述与定位

| 项 | 内容 |
|----|------|
| 名称 | `@suduo/client-server`（v0.1.0，private，ESM） |
| 定位 | 本机 app-server：**V2 主线**经 `/api/v2/*` 代理远程需求服务并把需求落成本机会话；`/api/v1/*` 承载会话运行时；同时托管前端静态产物 |
| 架构模式 | 分层单体（`application` 服务层 / `infrastructure` 适配层），出站运行时经 stdio JSON-RPC |
| 覆盖范围 | `client/server` |
| 不覆盖 | 远程需求服务 `cloud/server`、前端 `client/web`、共享契约 `client/contracts`、`cloud/contracts`；系统全景见《SuDuo V2 系统架构》 |

仓库根 `README.md` 明确其职责边界：「app-server 不做智能编排，只负责会话与 thread 映射、请求转发、通用事件入账和重放。」

### V2 路由现状

系统已整体切到 V2，本服务的路由面因此分成两层：

| 路由层 | 状态 | 内容 |
|---|---|---|
| `/api/v2/*` | ⭐ **V2 主线** | 认证、项目、需求、评论、附件、审计、SSE，以及 V2 独有的 `project-mappings`、`workspace-mapping`、`requirements/settings` 和 `requirements/:id/sessions` |
| `/api/v1/*`（会话运行时部分） | ✅ 在用 | 会话、审批、消息、文件、设置、skills——V2 前端打开会话时仍走这套 |

`/api/v2/*` 自身不落业务库——它是**代理层**，真相源在远程 `cloud/server`；本机 SQLite 只存映射与会话引用（见迁移 `010_v2_clean_local_state.sql`）。

---

## 二、整体结构

```
  浏览器 SPA (client/web)        ←── GET / 与 /* 回落 index.html（webRoot=client/web/dist）
        │  同源 REST + SSE(after=seq)
        ▼
  ┌──────────────────────────────────────────────────────┐
  │ infrastructure/http  (Fastify)   LoopbackGuard 限制来源 │
  │   /api/v2/*  ⭐V2 主线      /api/v1/*  会话运行时        │
  └──────┬───────────────────────────────────┬───────────┘
         ▼                                   ▼
  ┌────────────────────────┐   ┌──────────────────────────────┐
  │ RequirementsV2Service  │   │ application/  会话 / 审批 /   │
  │ （代理 + 快照 + 映射）   │   │ 事件                         │
  │                        │   │ EventLedger · EventBroker ·  │
  │                        │   │ SessionEventStream ·         │
  │                        │   │ RuntimeSupervisor            │
  └───┬──────────┬─────────┘   └───┬──────────────────┘
      │          │                 │
      ▼          ▼                 ▼
 ┌─────────┐ ┌──────────────┐ ┌──────────┐
 │Materials│ │Requirements  │ │ SQLite   │
 │快照目录  │ │RemoteClient  │ │(better-  │
 │(V2_DATA)│ │  ↓           │ │ sqlite3) │
 └─────────┘ │远程需求服务   │ └──────────┘
             │SUDUO_REQUIRE│      │
             │MENTS_SERVICE_│      │
             │URL           │      ▼  AgentRuntime
             └──────────────┘
                     ┌──────────────────────────────────────┐
                     │ CodexRuntime ─ stdio JSON-RPC ─▶ codex app-server │
                     └──────────────────────────────────────┘
```

---

## 三、技术栈

| 类别 | 技术 | 版本 | 说明 |
|------|------|------|------|
| HTTP 框架 | fastify | 5.11.3 | `infrastructure/http/http-server.ts` |
| 存储 | better-sqlite3 | 12.11.1 | 同步 SQLite，封装于 `DatabasePort` |
| 压缩 | fflate | 0.8.2 | 工作区文件打包相关 |
| 配置解析 | yaml | 2.8.1 | Codex / skills 相关配置 |
| 客户端契约 | @suduo/client-contracts | workspace:* | `CODEX_VERSION`、`SUDUO_DEFAULTS`、`M1_RUNTIME_SECURITY_POLICY`、会话工具、本机字段等 |
| 云端 API 契约 | @suduo/cloud-contracts | link:../../cloud/contracts | 远程 `/v2` 的需求、房间等 DTO；构建时顺带编译（ADR-0010） |
| 语言 / 构建 | TypeScript (`tsc -b` + `scripts/copy-assets.mjs`) | — | ESM 输出到 `dist/` |
| 测试 | vitest + 真实 gate 脚本 | — | `vitest run`、`gate:a` / `gate:b` / `gate:c` |

---

## 四、项目结构

```
client/server/
├── scripts/copy-assets.mjs          构建后资产拷贝
├── src/
│   ├── main.ts                      进程入口：环境变量校验、启动、PID 文件、优雅关闭
│   ├── server-application.ts        composition root：装配全部服务与仓储
│   ├── application/                 业务服务层
│   │   ├── event-ledger.ts event-broker.ts event-stream.ts    事件账本与 SSE
│   │   ├── runtime-supervisor.ts runtime-consumer.ts runtime-event-ingestor.ts
│   │   ├── session-service.ts session-run-status-service.ts message-service.ts
│   │   ├── approval-service.ts interrupt-service.ts idle-monitor.ts
│   │   ├── idempotency-service.ts idempotency.ts pagination.ts
│   │   ├── project-service.ts workspace-service.ts workspace-context.ts git-service.ts
│   │   ├── requirements-v2-service.ts my-workbench-service.ts
│   │   ├── session-tools/           会话里的 suduo_* 工具（ADR-0008）：清单、实现、调度、需求卡、.suduo 目录
│   │   └── settings-service.ts model-provider-service.ts skill-admin-service.ts
│   └── infrastructure/
│       ├── db/                      better-sqlite3 适配、migration-runner
│       │   ├── migrations/          001、002、010 增量 SQL
│       │   └── repositories/        9 个仓储
│       ├── http/                    http-server.ts loopback-guard.ts doctor-page.ts
│       ├── runtime/codex/           codex-runtime + 事件/输入/审批映射
│       ├── runtime/runtime-registry.ts
│       ├── transport/               stdio-codex-transport、jsonrpc-line-parser、rpc-connection
│       ├── platform/                跨平台能力（codex-home、进程控制、Windows 输出）
│       ├── requirements-v2/         remote-client、settings/credential store、sse-parser
│       ├── workspace/               attachment-store、baseline-store、path-guard、workspace-watcher、suduo-dir
│       └── doctor/                  自检
└── test/                            30+ vitest 用例 + gate-a/b/c 真实链路脚本
```

| 关键目录 | 职责 | 状态 |
|------|------|------|
| `application/requirements-v2-service.ts` | V2 主线：代理远程需求服务、目录映射、从需求创建会话 | ⭐ V2 核心 |
| `application/session-tools/` | 需求会话工具层：工具清单、只读 / 笔记 / 对外写工具实现、`item/tool/call` 调度、写操作确认、需求卡 | ⭐ V2 核心 |
| `infrastructure/requirements-v2/` | 远程客户端、settings/credential 本地存储 | ⭐ V2 核心 |
| `application/` | 会话、审批、事件与 V2 需求代理业务规则 | ⭐ 重点 |
| `infrastructure/db/` | SQLite 事件账本、会话与 V2 本机状态仓储 | ⭐ 重点 |
| `infrastructure/runtime/` + `transport/` | Codex 运行时接入与 stdio JSON-RPC 传输 | ⭐ 重点 |

---

## 五、核心模块 / 组件

| 模块 | 职责 | 依赖 |
|------|------|------|
| `createSuDuoApplication` (`server-application.ts`) | 打开数据库、跑迁移、装配全部服务与仓储、构建 HTTP server | 下列全部 |
| `EventLedger` / `EventRepository` | 通用事件入账，支撑按 `seq` 重放 | SQLite |
| `EventBroker` / `SessionEventStream` | 事件扇出与 SSE 推送（`after=seq` 续传） | `EventLedger` |
| `RuntimeSupervisor` / `RuntimeEventIngestor` / `consumeRuntimeUntilAborted` | 运行时生命周期、事件规范化入账 | `RuntimeRegistry` |
| `CodexRuntime` + `StdioCodexTransport` | 以 stdio JSON-RPC 驱动本机 codex app-server | `jsonrpc-line-parser`、`rpc-connection` |
| `SessionService` / `SessionThreadRepository` | 会话与 thread 映射 | SQLite |
| `ApprovalService` / `InterruptService` | 审批决策与中断，配合幂等服务 | `ApprovalRepository`、`IdempotencyService` |
| `WorkspaceService` / `WorkspaceWatcher` / `PathGuard` | 工作区文件读取、变更监听与路径越界防护 | 文件系统 |
| ⭐ `RequirementsV2Service` | V2 门面：settings/auth/projects/requirements/comments/attachments/audit/events 全量代理，外加 `listMappings`、`saveMapping`、`removeMapping`、`createRequirementSession`、`createProjectSession`、`listProjectSessions` | 下列三项 |
| ⭐ `RequirementsRemoteClient` | 出站 HTTP：`baseUrl + path`，按 baseUrl 取会话凭据；baseUrl 变更时作废在途请求 | `settings-store`、`credential-store` |
| ⭐ `SessionContextService` | 会话与 SuDuo 的关联：需求卡 / 项目卡、工具清单、开工水位线、工具执行上下文、`GET /api/v1/sessions/:id/context` | 远程客户端、本机仓储 |
| ⭐ `SessionToolService` / `RequirementTools` | `tool.call-requested` 异步执行并回包；写工具生成确认卡（审批表 `kind=other`），`ApprovalService` 决定后执行并回包 | 远程客户端、`EventLedger` |
| ⭐ `RemoteEventsHub` | 一条上游 `/v2/events` 扇出给所有标签页与本机房间任务接收器；上游重连后给浏览器发 `room-resync` | 远程客户端 |
| ⭐ `TokenRefresher` / `AgentPresence` | 登录过期前 1 小时续期；登记本机 Agent、30 秒心跳（含「有打开的页面」），共享期间保持常驻 | 远程客户端、`IdleMonitor` |
| ⭐ `RoomAgentRunner` (`application/room-agent/`) | 房间共享 Agent 在所有者本机执行：串行取任务 → 房间任务会话（隐藏，只读 + 联网 + 不审批）→ 组装房间上下文 → 回写进度、执行过程与回答 | 会话运行时、会话工具层（房间工具） |
| ⭐ `WorkspaceMappingRepository` / `RequirementSessionRefRepository` | V2 本机状态：远程项目→本机项目映射、会话的开工版本与水位线（`context_mode` 区分新版 / 旧版） | SQLite（迁移 010、015） |
| `LoopbackGuard` | 拒绝非本机来源请求 | — |
| `runDoctor` | 环境自检 | `platform/` |

---

## 六、关键流程 / 数据流

启动与环境校验（`src/main.ts`，均为硬失败）：

```
applyRuntimeConfigFromArgs(argv)
  → SUDUO_HOST 必须严格等于 127.0.0.1，否则抛错
  → SUDUO_CODEX_TRANSPORT 若设置，M1 仅允许 "stdio"
  → SUDUO_CODEX_VERSION 若设置，必须等于 contracts 的 CODEX_VERSION
  → 建 dataDir，DB 落在 SUDUO_DB_PATH 或 <dataDir>/suduo.sqlite
  → 可选 seedCodexHome(SUDUO_CODEX_DEFAULTS → codexHome)
  → createSuDuoApplication(...) → server.listen({host, port})
  → 写 PID 文件，stdout 输出 {"type":"suduo.ready", ...}
```

关闭路径：`SIGINT` 与（Windows 下 `SIGBREAK`／其它平台 `SIGTERM`）触发 `application.close()` 并清理 PID 文件；`SUDUO_IDLE_EXIT_MS` 到期时输出 `suduo.exit-requested` 并带 10s 兜底 `process.exit(0)`。

会话链路（结合 README 与 `server-application.ts` 装配关系）：

```
浏览器 → REST /api/v1/... → application 服务 → EventLedger 入账
                                   │
                                   ├→ EventBroker → SSE(after=seq) 回推浏览器
                                   └→ RuntimeSupervisor → CodexRuntime
                                            → StdioCodexTransport (JSON-RPC over stdio)
                                            → 本机 codex app-server
                                   ← RuntimeEventIngestor 规范化事件后入账
```

### V2 主链路：从需求创建本机会话

`RequirementsV2Service.createRequirementSession(requirementId)` 是 V2 最核心的一段编排，顺序与失败点都很明确：

```
remote.getRequirement(id)                        找到所属项目
   ▼
withMappingOperation(projectId)                  映射级串行
   ▼
requireValidatedLocalProject(projectId)          远程项目须已映射且本机目录可用
   ▼
sessionContext.captureAnchor(...)                审计水位线（查不到记 unavailable，不阻断）
remote.getRequirement(id)                        水位线之后再读需求
sessionContext.requirementSetup(...)             需求卡 + 10 个 suduo_* 工具
   ▼
sessions.createFromRequirement(localProjectId, { ..., requirementVersion, auditAnchor, setup })
   │ thread/start 带 developerInstructions（需求卡）与 dynamicTools
   ▼
写 v2_requirement_session_refs（开工版本、水位线、context_mode=tools）
   ▼
workspace.captureBaselineInBackground(sessionId)  「改动」面板基线（数据目录、按内容去重）
```

模型调工具时：`CodexRuntime` 把 `item/tool/call` 变成 `tool.call-requested` 事件 → `runtime-consumer` 交给 `SessionToolService`（不在订阅循环里等）→ 只读工具执行后 `respondToolCall`；写工具写审批表、审批坞确认后执行并回包；`serverRequest/resolved`（回合中断）与连接断开让确认卡作废。详见 [ADR-0008](../06_决策记录/ADR-0008-需求会话取数改为Codex客户端自定义工具.md) 与 [技术设计](../03_开发计划/v2-需求会话上下文重做-技术设计.md)。

对外路由面（`infrastructure/http/http-server.ts`）：

| 分组 | 路径 |
|---|---|
| ⭐ V2 认证 | `/api/v2/auth/register`、`/login`、`/logout`、`/me` |
| ⭐ V2 协作 | `/api/v2/projects[/:projectId]`、`/api/v2/projects/:projectId/requirements`、`/api/v2/requirements/:requirementId[/comments\|/attachments]`、`/api/v2/attachments/:attachmentId/content`、`/api/v2/audit`、`/api/v2/events` |
| ⭐ V2 本机 | `/api/v2/requirements/settings`、`/api/v2/project-mappings`、`/api/v2/projects/:projectId/workspace-mapping`、`/api/v2/projects/:projectId/sessions`、`/api/v2/requirements/:requirementId/sessions` |
| 会话运行时 | `/api/v1/projects[/:projectId]`、`/api/v1/projects/:projectId/sessions`、`/api/v1/sessions/:sessionId`、`/api/v1/approvals/*`、`/api/v1/projects/:projectId/files[/content\|/index\|/raw]`、`/api/v1/settings`、`/api/v1/skills/*`、`/api/v1/system/open-targets`、`/api/v1/admin/shutdown` |
| 运维 | `/healthz`、`/doctor`、`/doctor/client.js` |
| 静态 | `GET /` 与 `GET /*`：`assets/*`、`favicon.svg` 直出，其余回落 `index.html`；`api/` 前缀命中则抛 404 `NOT_FOUND` |

---

## 九、部署 / 运行

- 构建：`pnpm --filter @suduo/client-server build`（`tsc -b` + `copy-assets.mjs`）
- 启动：`start` → `node dist/main.js`
- 真实链路验证：`gate:a`、`gate:b`（先 build）、根级 `gate:c`

主要环境变量（默认值取自 `@suduo/client-contracts` 的 `SUDUO_DEFAULTS`）：

| 变量 | 说明 |
|------|------|
| `SUDUO_HOST` / `SUDUO_PORT` | 监听地址；host 强制 `127.0.0.1` |
| `SUDUO_DATA_DIR` / `SUDUO_DB_PATH` | 数据目录与 SQLite 路径 |
| `SUDUO_CODEX_HOME`（回落 `CODEX_HOME`）/ `SUDUO_CODEX_BIN` / `SUDUO_CODEX_DEFAULTS` | Codex 位置与初始化种子 |
| `SUDUO_CODEX_TRANSPORT` / `SUDUO_CODEX_VERSION` | 传输与版本锁定校验 |
| `SUDUO_SSE_HEARTBEAT_MS`（5000–60000）/ `SUDUO_SSE_REPLAY_PAGE_SIZE`（100–2000） | SSE 心跳与重放分页 |
| `SUDUO_RUNTIME_RESTART_MAX_MS`（1000–120000） | 运行时重启退避上限 |
| `SUDUO_FS_WATCH_DEBOUNCE_MS` / `SUDUO_FS_POLL_INTERVAL_MS` / `SUDUO_FS_FORCE_POLLING` | 工作区监听策略 |
| `SUDUO_REQUIREMENTS_SERVICE_URL` / `SUDUO_V2_DATA_DIR` | 远程需求服务地址与本地 v2 数据目录 |
| `SUDUO_IDLE_EXIT_MS` / `SUDUO_PID_FILE` / `SUDUO_LOG_LEVEL` / `SUDUO_GLOBAL_SKILLS` | 空闲退出、PID、日志、全局 skills 开关 |

---

## 十、边界 / 不做项

- 不做智能编排；模型调用由本机锁定版本的 Codex CLI 完成（README）。
- 不监听非回环地址：`SUDUO_HOST` 非 `127.0.0.1` 直接启动失败，并有 `LoopbackGuard` 兜底。
- 不支持 stdio 之外的 Codex 传输方式（`SUDUO_CODEX_TRANSPORT` 只接受 `stdio`）。
- **不承载 V2 需求数据的权威存储**：项目/需求/评论/附件的真相源在远程需求服务，本机 SQLite 只存目录映射与会话快照引用两张 `v2_*` 表。
- 不把远程 token 暴露给浏览器：凭据由 `RequirementsCredentialStore` 存在本机 V2 数据目录。
- 不为浏览器开放远程附件的直连地址；附件走 BFF 流式代理。

---

## 十一、相关文档

| 想深入 | 看 |
|--------|-----|
| 系统总架构 | `docs/01_架构设计/v2-系统架构.md` |
| 远程需求服务 | `docs/01_架构设计/cloud-server-架构.md` |
| 前端 SPA | `docs/01_架构设计/client-web-架构.md` |
| 共享类型契约 | `docs/01_架构设计/contracts-架构.md` |
| Codex 协议基线 | `docs/01_架构设计/client-codex-protocol-架构.md` |

---

## 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-08-15 | v1.0 | `/ccb:su-init` 依据仓库证据生成初版（未经人工校验） |
| 2026-08-15 | v1.1 | 按实际代码补充 V2 主线：`/api/v2` 路由面、`RequirementsV2Service` 编排、材料快照与会话绑定；TAPD/工作项标记为旧线 |
| 2026-08-15 | v1.2 | 按 T4 清理后的分支代码移除 TAPD/WorkItem 旧线描述，并更新本机迁移链与会话运行时边界 |
