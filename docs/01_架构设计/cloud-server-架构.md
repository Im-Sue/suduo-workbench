---
doc_type: architecture
updated: 2026-08-15
generated_by: su-init-ai
human_verified: false
architecture_scope: cloud-server
scope_source_roots: ["cloud/server"]
---

# cloud/server 架构

> 一句话定位：远程共享需求服务，基于 Fastify + PostgreSQL 对外提供 `/v2` 认证、需求协作与附件接口。｜最后更新：2026-08-15

> ⚠️ 本文由 `/ccb:su-init` 依据仓库证据自动生成，**尚未人工校验**（`human_verified: false`）。请 review 后再作为真相源使用；需要修改直接对话说明。

> 分支归属：本文按 `ccb/req-suduo-v2-requirements-workbench-001` 分支代码校对；该分支尚未合并 `main`。

---

## 一、概述与定位

| 项 | 内容 |
|----|------|
| 名称 | `@suduo/cloud-server`（v0.1.0，private，ESM） |
| 定位 | 远程共享需求服务：暴露 `/v2` REST + SSE，承载用户认证、项目/需求协作、评论与附件 |
| 架构模式 | 分层单体服务（`http` / `application` / `infrastructure` 三层） |
| 覆盖范围 | `cloud/server` |
| 不覆盖 | 本机工作台 `client/server`、前端 `client/web`、共享契约 `client/contracts`、`cloud/contracts`；系统全景见《SuDuo V2 系统架构》 |

**本服务是 V2 需求数据的唯一权威真相源。** 系统已整体切到 V2：浏览器不直连本服务，全部流量经用户本机的 `client/server` BFF 以 `/api/v2/*` 代理进来；本机 SQLite 只保留目录映射与会话快照引用，不复制业务数据。

与本机工作台 `client/server` 的区别在部署形态上最直观：本服务默认 `REQUIREMENTS_HOST=0.0.0.0`（内网可达、独立 PostgreSQL 与附件卷），而 `client/server` 在 `src/main.ts` 中强制 `SUDUO_HOST` 必须为 `127.0.0.1`。两者同仓但不共享运行时、数据库或部署流水线。

---

## 二、整体结构

```
  HTTP 客户端（client/web、client/server 的 RequirementsRemoteClient）
        │  REST /v2/*  +  SSE /v2/events
        ▼
  ┌──────────────────────────────┐
  │ http/server.ts (Fastify)     │  @fastify/jwt 鉴权、@fastify/busboy 上传
  └──────────────┬───────────────┘
                 ▼
  ┌──────────────────────────────┐
  │ application/                 │  AuthService / CollaborationService
  │                              │  AttachmentService / RequirementsEventHub
  └──────────────┬───────────────┘
                 ▼
  ┌──────────────────────────────┐
  │ infrastructure/              │  UserRepository / CollaborationRepository
  │                              │  AttachmentRepository / AttachmentStorage
  └──────────────┬───────────────┘
                 ▼
        PostgreSQL (pg Pool)  +  附件磁盘目录 REQUIREMENTS_ATTACHMENT_ROOT
```

---

## 三、技术栈

| 类别 | 技术 | 版本 | 说明 |
|------|------|------|------|
| HTTP 框架 | fastify | 5.11.3 | `src/http/server.ts` 构建 |
| 认证 | @fastify/jwt | 10.2.1 | JWT 签发/校验，配置见 `authSecret` / `authTtlSeconds` / `authIssuer` / `authAudience` |
| 上传 | @fastify/busboy | 3.2.1 | 附件 multipart 解析 |
| 存储 | pg | 8.23.0 | PostgreSQL 连接池，`src/infrastructure/database.ts` |
| 云端 API 契约 | @suduo/cloud-contracts | workspace:* | 本服务 `/v2` 的 DTO、常量与 schema；客户端经 link: 引用同一份 |
| 语言 / 构建 | TypeScript (`tsc -b`) | — | ESM 输出到 `dist/` |
| 测试 | vitest | — | `vitest run`，配置 `vitest.config.ts` |

---

## 四、项目结构

```
cloud/server/
├── .env.example                    服务与 compose 的环境变量样例
├── Dockerfile                      多阶段、非 root 的服务镜像
├── compose.yaml                    PostgreSQL 与服务的部署示例
├── DEPLOYMENT.md                   启动、健康检查、备份与恢复说明
├── migrations/                     SQL 迁移脚本
│   ├── 001_initial.sql
│   └── 002_attachments.sql
├── src/
│   ├── main.ts                     进程入口（加载配置、建库、迁移、监听、信号处理）
│   ├── migrate.ts                  独立迁移入口（db:migrate）
│   ├── config.ts                   环境变量装配与校验
│   ├── application.ts              依赖组装（composition root）
│   ├── lifecycle.ts                监听与优雅关闭
│   ├── http/server.ts              Fastify 路由与鉴权
│   ├── application/                业务服务层
│   │   ├── auth-service.ts         password-service.ts
│   │   ├── collaboration-service.ts cursor.ts
│   │   ├── attachment-service.ts   event-hub.ts
│   │   └── errors.ts
│   └── infrastructure/             出站适配层
│       ├── database.ts             migration-runner.ts
│       ├── user-repository.ts      collaboration-repository.ts
│       └── attachment-repository.ts attachment-storage.ts
└── test/                           6 个 vitest 用例
```

| 关键目录 | 职责 | 状态 |
|------|------|------|
| `src/http/` | 路由、JWT 鉴权、请求/响应编解码 | ✅ 在用 |
| `src/application/` | 业务规则与领域服务，不直接触碰 pg | ⭐ 重点 |
| `src/infrastructure/` | PostgreSQL 仓储、附件磁盘存储、迁移执行 | ✅ 在用 |
| `migrations/` | 增量 SQL；由 `runMigrations` 或 `db:migrate` 执行 | ✅ 在用 |

---

## 五、核心模块 / 组件

| 模块 | 职责 | 依赖 |
|------|------|------|
| `loadConfig` (`config.ts`) | 读取并校验环境变量，产出 `RequirementsServiceConfig` | — |
| `createApplication` (`application.ts`) | 组装仓储与服务并构建 HTTP server | 全部服务与仓储 |
| `AuthService` | 注册/登录/当前用户；口令处理委托 `password-service` | `UserRepository` |
| `CollaborationService` | 项目、需求、评论等协作数据读写 | `CollaborationRepository` |
| `AttachmentService` | 附件元数据 + 落盘，启动时 `initialize()` 占用目录 | `AttachmentRepository`、`AttachmentStorage` |
| `RequirementsEventHub` | 需求事件扇出（只带「哪条变了」），支撑 `GET /v2/events` 的默认 message 事件 | — |
| `createRoomsModule` (`application/rooms/module.ts`) | 项目聊天房间与共享 Agent：房间、成员、消息（序号、客户端 ID 合并、话题、@）、房间文件、Agent 登记与心跳、共享与申请、Agent 任务（派给所有者本机执行，结果回写为话题回复）；`room-sweeper` 每 30 秒处理到期共享与掉线 | `infrastructure/rooms/*` 仓储、`BlobStore` |
| `RoomRealtimeHub` (`application/rooms/realtime-hub.ts`) | 房间事件（带内容）以命名事件 `room` 推送，数字序号 id + epoch，最近 2000 条可按 `Last-Event-ID` 补发 | — |
| `BlobStore` / `LocalDiskBlobStore` (`infrastructure/storage/`) | 房间文件存储接口与本机磁盘驱动（独立根目录 `REQUIREMENTS_ROOM_FILE_ROOT`，支持 Range，只增不删）；以后可换云存储驱动 | 文件系统 |
| `buildHttpServer` (`http/server.ts`) | 注册 JWT 插件与全部 `/v2` 路由 | 上述服务 |
| `runMigrations` | 按序执行 `migrations/*.sql` | `pg` Pool |

---

## 六、关键流程 / 数据流

启动序列（`src/main.ts`）：

```
loadConfig()
   → createDatabase(config)            建立 pg Pool
   → runMigrations(pool)               仅当 config.runMigrations 为真
   → createApplication(config, db)     组装服务 + buildHttpServer
   → createApplicationCloser(...)      注册 SIGINT / SIGTERM
   → listenApplication(host, port)
```

失败路径上，迁移或应用组装抛错时都会先 `pool.end()` 再向上抛；`AttachmentService` 初始化后若 HTTP 构建失败，会尝试 `attachments.close()`，两者都失败时聚合为 `AggregateError`。

对外路由面（`src/http/server.ts`）：

| 分组 | 路径 |
|------|------|
| 健康 | `GET /v2/health` |
| 认证 | `/v2/auth/register`、`/v2/auth/login`、`GET /v2/auth/me` |
| 项目 | `/v2/projects`、`/v2/projects/:projectId` |
| 需求 | `/v2/projects/:projectId/requirements`、`/v2/requirements/:requirementId` |
| 评论 | `/v2/requirements/:requirementId/comments` |
| 附件 | `/v2/requirements/:requirementId/attachments`、`/v2/attachments/:attachmentId/content` |
| 事件 | `GET /v2/events`（SSE） |
| 审计 | `/v2/audit` |

调用方是本机 BFF 而非浏览器：`client/server` 的 `RequirementsRemoteClient` 以 `baseUrl + path` 拼接请求，并按 baseUrl 取对应会话凭据。BFF 对浏览器暴露的是同名的 `/api/v2/*`，与本服务的 `/v2/*` 一一对应（BFF 另加 `project-mappings`、`workspace-mapping`、`requirements/settings`、`requirements/:id/sessions` 等纯本机路由，那几个不打到本服务）。

---

## 九、部署 / 运行

- 构建：`pnpm --filter @suduo/cloud-server build`（`tsc -b`）
- 启动：`start` → `node dist/main.js`
- 迁移：`db:migrate` → `node dist/migrate.js`（也可由 `runMigrations` 配置项在启动时执行）
- `Dockerfile`：Node 24 多阶段构建，运行镜像以非 root 用户运行，并以 `GET /v2/health` 作为健康检查。
- `compose.yaml`：在 `cloud/` 目录下用 `docker compose --env-file server/.env -f server/compose.yaml up --build -d` 启动（构建上下文是 `cloud/` 工作区）；仅映射服务端口，PostgreSQL 与附件分别使用具名持久卷。
- `DEPLOYMENT.md`：提供启动、健康检查及备份恢复说明；在线单独执行 `pg_dump` 与在线附件卷拷贝不能组成可恢复的一致备份，须停服后同时备份或使用一致性快照。

`loadConfig()` 在建立数据库和监听前读取必填环境变量；缺失、附件目录非绝对路径或密钥不足 32 个字符都会使启动失败：

| 变量 | 约束 |
|------|------|
| `REQUIREMENTS_DATABASE_URL` | 必填 |
| `REQUIREMENTS_AUTH_SECRET` | 必填，至少 32 个字符 |
| `REQUIREMENTS_ATTACHMENT_ROOT` | 必填，必须是绝对路径 |

可选环境变量：`REQUIREMENTS_HOST`（默认 `0.0.0.0`）、`REQUIREMENTS_PORT`（默认 `4100`，取值 1–65535）。

附件硬约束（`config.ts` 常量）：单附件上限 `314572800` 字节（300 MiB），单需求附件数上限 `20`，并按 `allowedAttachmentExtensions` 白名单过滤扩展名。

---

## 十一、相关文档

| 想深入 | 看 |
|--------|-----|
| 系统总架构 | `docs/01_架构设计/v2-系统架构.md` |
| 本机 BFF 与代理层 | `docs/01_架构设计/client-server-架构.md` |
| 前端 SPA | `docs/01_架构设计/client-web-架构.md` |
| 共享类型契约 | `docs/01_架构设计/contracts-架构.md` |
| 附件与实时协作模块规格 | `docs/04_模块规格/需求协作附件与实时模块规格.md` |

---

## 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-08-15 | v1.0 | `/ccb:su-init` 依据仓库证据生成初版（未经人工校验） |
| 2026-08-15 | v1.1 | 明确其为 V2 唯一权威真相源，补充与 BFF `/api/v2/*` 的路由对应关系 |
| 2026-08-15 | v1.2 | 按 T5-1 分支代码补充 Docker、compose、部署运行手册及 `REQUIREMENTS_*` 启动校验描述 |
| 2026-10-01 | v1.3 | 加项目聊天房间与共享 Agent 模块（迁移 011、房间事件、房间文件存储、`/v2/auth/refresh`），见 ADR-0009 与对应技术设计 |
