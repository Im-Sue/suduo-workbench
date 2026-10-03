---
id: suduo-v2-pm-requirement-intake-001-design
title: SuDuo V2 PM 需求前置闭环 技术设计
doc_type: technical_design
requirement_id: suduo-v2-pm-requirement-intake-001
expression_spec: v1
updated: 2026-08-21
---

# SuDuo V2 PM 需求前置闭环 技术设计

> 一句话：在既有附件表之上加一层不可变的产物版本，用「发布」这一次数据库事务同时产出版本、文件清单与发布评论，并把会话材料从预拉快照改成按需拉取 ｜ 最后更新：2026-08-21
>
> **无独立 status** —— 跟随 `suduo-v2-pm-requirement-intake-001`。

---

## 一、设计概述

**目标对齐**：需求侧要三件事——状态多一档「梳理中」、材料升级为可发布的产物版本、会话不再预拉材料。技术侧真正的难点不在这三件事本身，而在它们各自撞上的既有实现：产物版本要「历史全留」，但附件删除是立即物理删 blob；发布要产出新事件，但前端事件处理是穷举式分支；会话去预拉要改快照语义，但快照 manifest 的版本字段被写死。本设计逐一给出改法，并把两处需求文档与代码现状不符的描述显式纠正。

| 项 | 说明 |
|----|------|
| 名称 | PM 需求前置闭环 |
| 核心职责 | 需求状态扩档、产物版本层、发布事务、blob 生命周期保护、会话材料按需拉取、发布/拉取 BFF 与 skill |
| 设计原则 | 不可变历史优先于存储回收；发布是一次数据库事务；SuDuo 给能力，skill 决定用法 |
| 需求来源 | `docs/02_需求设计/v2-PM需求前置闭环-需求.md` |
| 覆盖范围 | 需求 4.1–4.7 全部功能项 |
| 不覆盖 | 需求六章全部不做项；另见本文 §3.9 的范围收窄 |

---

## 二、方案与架构

```
                     远程 requirements-service（Postgres）
  ┌──────────────────────────────────────────────────────────────┐
  │  requirements ──┬── requirement_artifact_versions  ← 新增     │
  │                 │        │                                    │
  │                 │        └── requirement_artifact_version_files ← 新增
  │                 │                     │ FK                    │
  │                 ├── attachments ──────┘  （blob 单点归属）    │
  │                 ├── requirement_comments (+ artifact_version_id) ← 加列
  │                 └── requirement_publish_operations ← 新增（幂等）
  │                                                               │
  │  AttachmentStorage.reconcile(活跃键 ∪ 版本引用键)  ← 改语义   │
  └──────────────────────────────────────────────────────────────┘
                              ▲ HTTP + Bearer（BFF 服务端持有 token）
                              │
                     本机 BFF（client/server，SQLite）
  ┌──────────────────────────────────────────────────────────────┐
  │  /api/v2/... 代理 + 产物拉取落盘                              │
  │  LoopbackGuard：写请求强制同源 Origin（不放宽）               │
  │  material-service：manifest v3 = requirement-only（不预拉）   │
  └──────────────────────────────────────────────────────────────┘
                              ▲ curl（带 Origin 头）
                       会话中的 skill（发布 / 拉取）
```

| 关键原则 | 说明 |
|----------|------|
| blob 归属单点 | 物理文件永远只由 `attachments` 行持有；版本表只引用，不另立存储 |
| 引用即保护 | 被任一版本引用的 storage_key 不可物理删除，删除只影响活跃列表 |
| 发布 = 一次事务 | 版本、文件清单、发布评论、审计、版本号自增全在同一 Postgres 事务内 |
| 事件先落库后广播 | 沿用现状：repository 返回后才 `events.publish`（`server.ts:397-403`） |
| 能力与用法分离 | BFF 只提供发布/拉取能力，落盘位置与拉哪一版由 skill 决定 |

**与现有系统的关系**：

| 涉及模块 | 本设计如何动它 | 明确不碰 |
|----------|----------------|----------|
| `attachments` 表与上传链路 | 完全复用，不改上传接口与既有幂等 | 不改 storage_key 生成、不改扩展名白名单 |
| `AttachmentStorage` | 只改 `reconcile` 的活跃集合口径 | 不改 store/open/落盘安全校验 |
| `requirement_comments` | 加一列可空唯一外键 | 不加 UPDATE/DELETE，保持 append-only |
| `material-service` | 新增 v3 manifest 语义，去掉附件下载 | 不改受控落盘与路径安全校验 |
| 会话运行时协议 | 不动 | — |

---

## 三、关键决策与取舍

> 全部经 Codex 协商（`job_b0693f826f68`）压测，标 ✅ 者已由 Claude 独立读码复核。

### 3.1 产物版本文件表引用附件行（D1）

`requirement_artifact_version_files` 外键指向 `attachments(id)`，并冗余 `file_name / size_bytes / sha256 / storage_key` 四列作发布时刻快照。理由：`storage_key` 是 UUID 派生且 UNIQUE（`attachment-storage.ts:100`、`002_attachments.sql:4`），同一 blob 不可能被两行持有，因此「sha256 未变则复用」只能是复用同一条附件行。

✅ **随之必须新增一条不过滤软删的下载查询**：`getForDownload` 走 `getRow`，带 `deleted_at IS NULL`（`attachment-repository.ts:349-359`）。PM 删掉一个已发布文件后，沿用该查询会让版本文件 404。产物下载走独立查询，只校验「该文件属于该版本」。

### 3.2 发布 bump `requirement.version` + 新增 `artifact.published`（D2）

发布沿用附件增删的并发域：`SELECT … FOR UPDATE` + `incrementRequirementVersion`（`attachment-repository.ts:175-207`）。

✅ **但前端不是零改动**。`RequirementsWorkbench.tsx:506-540` 是 `requirement.changed` / `comment.created` / `attachment.changed` 的穷举 if-else-if 链，新事件类型会静默落空；`shouldApplyEvent` 也只在 `requirement.changed` 分支被调用。必须为 `artifact.published` 显式加分支，刷新看板卡版本、详情、产物区与评论流。

### 3.3 幂等落在发布命令层（D3）

新增 `requirement_publish_operations(requirement_id, operation_key)` 唯一键 + 请求摘要 + 响应重放。

✅ **不可照搬附件那套**：`server.ts:369-372` 的 `Idempotency-Key` 直接被当成 attachment id 使用（`attachmentOperationKey` 强制 UUID 格式），是一次性资源 ID 复用，不构成通用幂等机制。BFF 透传同一 `operation_key`。

### 3.4 显式版本校验（D3 附带）

发布接口接受 `expectedVersion`，不匹配即 409。

✅ **纠正需求 N9 对现状的描述**：需求写「沿用 expectedVersion + 行锁 + 幂等键」，但附件增删**根本没有 `expectedVersion` 入参**（`attachment-repository.ts:167-220, 271-285`），只有行锁与 bump。补齐附件侧该缺口列为实现前置，否则「发布与附件增删并发」这条风险的缓解措施是空的。

### 3.5 blob 生命周期保护（D4）

两处改动：`activeStorageKeys()` 改为「未删附件 ∪ 被任一版本文件引用」；`attachment-service.delete()` 在该 key 被版本引用时跳过 `storage.remove()`。上传失败路径清理的是尚未入库的新 key，不受此规则影响（`attachment-service.ts:80-96`）。经双方核查，无其他持久 blob 清理路径。

### 3.6 manifest v3 = requirement-only，SQLite 零迁移（D5）

✅ **推翻 Claude 原假设**：`ensureSnapshot` 恒写 `schemaVersion: 2`（`material-service.ts:159-174`），v1 只是读路径且**仅在远程附件确实为空时**才容许复用（`:252-258`）——「沿用 v1 的 `attachments: []`」方向搞反。

改为引入 `schemaVersion: 3`，语义为「requirement-only，材料未拉取」。`material_path` / `manifest_sha256` 照常写入，故 `v2_requirement_session_refs` 的 NOT NULL 约束不受影响，**client/server 的 SQLite 迁移链 `[1,2,10]` 无需变动**。

补强 Codex 未提及项：**v3 分支的 `verifySnapshot` 必须停止比对远程附件集合**，否则远程新增附件会让已有 v3 快照复用失败。同时 `requirement.md` 不再写「无附件」字样。

### 3.7 不放宽 LoopbackGuard（D6）

`loopback-guard.ts:10-13` 对所有写方法强制同源 `Origin`。skill 用 curl POST 必须自带 `-H 'Origin: http://127.0.0.1:<port>'`。这是 CSRF 防护，不为 skill 便利放宽。

**实施前置（必须实测，不得推定）**：`auto` 档为 `workspace-write` + `networkAccess:false`（`client/contracts/src/config.ts:25-27`）。codex 沙箱是否将 127.0.0.1 回环计入网络访问，官方文档未声明例外。实测方法见 §5.4。若不可达，官方 skill 需标注「至少 full 档」或提供替代路径。

### 3.8 容量上限是三个独立常量，不是一个（D8）

✅ **纠正需求 4.7**。三处语义各不相同：

| 位置 | 真实语义 | 本期处置 |
|---|---|---|
| `cloud/server/src/config.ts:4` | 服务端活跃附件硬上限（权威，409） | 20 → 100 |
| `RequirementsWorkbench.tsx:791` | 前端上传前预检（UX，可过期） | 跟随服务端值 |
| `material-service.ts:439` | 本机快照下载全集上限（防御远程，抛 502） | **不删除**，改名为「按需拉取单次文件数上限」并保留——去预拉后 skill 批量拉取仍需该保护 |

共享值新增 `cloud/contracts/src/limits.ts`，导出三个**分别命名**的常量，不合并为一个。

### 3.9 范围收窄：发布不支持「随本次发布上传」✅ 已拍板

需求 4.2 前置条件写「待发布文件已上传**或随本次发布上传**」，但需求六章又写「不做……批量预览与失败原子性属独立范围」。二者自相矛盾——「随发布上传」的全部复杂度正是失败原子性。

**决定（用户 2026-08-21 拍板，方案 A）：发布只接受已上传附件的 ID 列表。** 理由：① 用户原话只说「完整的发一版上去」，未要求单请求内既传又发；② 两步对 PM 完全不可见，skill 内部先调现成上传接口（自带幂等）再调发布；③ 单请求上传+发布会让事务横跨文件系统与数据库，需另建 staging 与失败回收，直接引入需求已排除的原子性问题与 blob 泄漏路径。

另定：发布时逐个校验附件的 `requirement_id` 与目标需求一致，跨需求附件 ID 一律 400。

落到 skill 上：PM 说一句「发上去」，skill 内部先逐个调既有上传接口（`POST /v2/requirements/:id/attachments`，`Idempotency-Key` 即 attachment id，天然可重试），全部成功后再调发布接口传入这批 ID。两步对 PM 不可见；中途失败时已上传的附件停留在活跃列表，重试复用同一批 `Idempotency-Key` 不会产生重复附件，也不会留下半个版本。

**同步修正需求文档**：需求 4.2 前置条件与六章边界的矛盾已按本决定消解，两处均已更新。

---

## 四、核心流程

**发布（单事务）**

```
skill/UI ─POST /v2/requirements/:id/artifact-versions
          {expectedVersion, operationKey, attachmentIds[], note?}
   │
   ├─ 幂等：命中 requirement_publish_operations → 重放原响应，结束
   ├─ BEGIN
   │   ├─ SELECT … FROM requirements WHERE id=$1 FOR UPDATE
   │   ├─ 校验 expectedVersion；校验每个 attachmentId 属本需求且未删
   │   ├─ version_number = MAX(version_number)+1
   │   ├─ INSERT requirement_artifact_versions
   │   ├─ INSERT requirement_artifact_version_files（快照四列）
   │   ├─ INSERT requirement_comments（artifact_version_id = 新版本；note 为空则系统生成）
   │   ├─ incrementRequirementVersion
   │   ├─ INSERT audit_logs（resource_type='artifact_version'）
   │   └─ INSERT requirement_publish_operations
   ├─ COMMIT
   └─ events.publish({type:'artifact.published', requirementVersion})
```

**拉取**：skill → BFF `POST /api/v2/artifact-versions/:versionId/fetch`（带 Origin）→ BFF 逐个取版本文件（走**不过滤软删**的查询）→ 受控落盘到 skill 指定的映射目录相对路径 → 返回落盘清单。

**blob 生命周期**：删除附件 → 软删行 + bump 版本 → 查该 storage_key 是否被版本引用 → 引用则保留 blob，否则物理删；服务启动 `reconcile(未删附件 ∪ 版本引用)`。

---

## 五、测试策略

| 层 | 必测项 |
|---|---|
| 迁移 | 全新库跑通全部迁移；已部署库增量应用 003 与 004 均不触发 checksum 校验；旧数据零变档 |
| 数据层 | 版本号并发自增无重复；`artifact_version_id` 唯一性；跨需求附件 ID 拒绝 |
| **回归·红线** | **删除已发布附件后，该版本文件仍可下载**（§3.1） |
| **回归·红线** | **服务重启 reconcile 后，被版本引用的 blob 仍存在**（§3.5） |
| 并发 | 发布与附件增删并发，expectedVersion 冲突返 409 且不产生半版本 |
| 幂等 | 同 operationKey 重复发布只产生一个版本与一条评论 |
| 前端 | `artifact.published` 到达后看板卡版本、详情、产物区、评论流均刷新 |
| 会话 | 创建会话不产生任何附件下载请求；v3 快照在远程新增附件后仍可复用 |
| 状态 | 看板七列；`draft` 仍为默认 |

**§5.4 `auto` 档 loopback 实测 —— 已实测，结论：不可达**（pr1 交付，2026-08-21）

判定口径原为「宿主机 200 且 auto 会话内无审批弹窗也得到 200」。实测结果不满足。

**结论：官方 skill 的最低可用档位是 `full`。**

### 测量方法

用 `codex sandbox` 子命令在指定沙箱策略下直接执行命令（不经 LLM 回合），
比「另起一个 auto 会话再肉眼看审批 UI」更精确、可复现。codex-cli 0.147.0。

```bash
codex sandbox -c sandbox_mode=<档> [-c sandbox_workspace_write.network_access=<bool>] -- \
  curl --noproxy '*' -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/healthz
```

### 实测矩阵

| # | 沙箱策略 | 对应档位 | curl exit | HTTP | 结果 |
|---|---|---|---|---|---|
| 基线 | 宿主机（无沙箱） | — | 0 | 200 | 可达（对照组，证明 BFF 本身正常） |
| A | `workspace-write`，network 默认 | **auto** | 7 | 000 | **不可达** |
| B | `workspace-write` + `network_access=false` | **auto** | 7 | 000 | **不可达** |
| C | `danger-full-access` | **full** | 0 | 200 | 可达 |
| D | `workspace-write` + `network_access=true` | （非标准档） | 0 | 200 | 可达 |
| E | `read-only` | **ask** | 7 | 000 | 不可达 |

失败文本一律为 `curl: (7) Failed to connect to 127.0.0.1 port 8787 after 0 ms: Couldn't connect to server`。

### 三条判定

1. **沙箱不对 127.0.0.1 开例外。** 「访问 127.0.0.1」被算作「访问网络」，官方文档未声明例外，实测证实按无例外处理。
2. **`network_access` 是唯一决定因素。** A/B（关网）不可达、D（开网）可达，其余条件不变——排除了「是 workspace-write 本身限制了连接」这一可能。
3. **不是审批拦截，是沙箱直接拒绝。** 没有任何审批弹窗，连接在 0 ms 内即失败。原判定口径里的「无审批弹窗也得到 200」隐含假设了「可能弹审批」，实际连这一步都到不了。

### 网络白名单：不存在

试过 `sandbox_workspace_write.allowed_domains` / `allow_loopback` / `network_allowlist`
三种键名，均无效（仍 exit 7）。codex 0.147.0 的沙箱网络是二元开关，
**无法做到「只放行 127.0.0.1 而不开全网」**。这条路堵死，因此不能靠给 auto 档
加 loopback 例外来兼顾安全与可用。

### 替代路径（供 pr7 与后续决策）

- **路径一（最小改动）**：skill 文档明确标注「需 `full` 档」，并在 skill 入口做档位预检，
  非 full 档时直接给出可读提示而不是让 curl 报连接失败。
  代价：PM 用发布/拉取 skill 就得开 `full`＝`danger-full-access` + 不询问，
  安全性代价由 PM 概括承受，与「PM 电脑上没有代码目录」的低风险场景尚可匹配，但需产品侧知情。
- **路径二（绕开沙箱）**：把发布做成需求页 UI 动作（浏览器直连 BFF，不经 codex 沙箱），
  skill 只负责生成/整理待发布文件，最后一步由 PM 在页面点确认。
  代价：不满足「PM 在会话里说一句『发上去』就完成」的原始诉求，交互被切成两段。

**Origin 必要性（同批实测，已确认）**：`loopback-guard` 对写方法强制同源。

| 请求 | 结果 |
|---|---|
| `POST` 不带 `Origin` | **403** `ORIGIN_REJECTED`「写请求必须携带同源 Origin」 |
| `POST` 带 `Origin: http://127.0.0.1:8787` | 非 403（404 路由不存在，说明已过关卡） |
| `POST` 带异源 `Origin: http://evil.example.com` | **403** |
| `GET` 不带 `Origin` | 非 403（读方法不校验） |

结论：skill 的所有写请求必须自带同源 `Origin` 头，这条不放宽。

### 对 pr7 交付形态的影响（验收要求显式标注）

pr7「官方发布 / 拉取 skill」的交付目标里写着「档位说明依 pr1 实测结论」，
本结论对 pr7 的影响如下：

| 方面 | 是否受影响 | 说明 |
|---|---|---|
| skill 数量与职责 | **不变** | 仍是发布、拉取两个 skill |
| skill 实现方式 | **不变** | 仍走 shell curl 调本机 BFF，仍必须带 `Origin` 头，仍不做内建 MCP server |
| 两步发布流程 | **不变** | 先逐个上传（`Idempotency-Key` 即 attachment id）再调发布传 attachmentIds |
| sha256 复用判定 | **不变** | 仍在 skill 侧做 |
| **档位说明** | **变** | 由「待实测」变为明确要求 `full` 档；`auto`/`ask` 档下 skill 不可用 |
| **失败处理** | **新增** | skill 入口应做档位预检，非 full 档给可读提示，而不是让 curl 抛 exit 7 连接失败 |

即：**pr7 的交付物形态不变，变的是档位说明与新增一条入口预检**。pr7 可照常实施。

需要产品侧知情的一点：PM 要用发布 skill，就得把会话开到 `full`
（`danger-full-access` + 不询问）。这在「PM 电脑上没有代码目录」的场景下风险可控，
但它是一个真实的安全性取舍，不是纯技术细节。

---

## 六、数据设计

**Postgres 新增迁移 003 与 004（两个文件）**（新增文件；不得修改 `001_initial.sql`——runner 按 sha256 校验已应用文件，改动会让已部署实例启动即抛「checksum 已漂移」，`migration-runner.ts:41-47`。此处纠正需求文档把 `[1,2,10]` 归给本链的事实错误，`[1,2,10]` 是 client/server 的 SQLite 链）：

| 变更 | 内容 |
|---|---|
| 放开 CHECK | `requirements_status_fixed` 加 `in_refinement` |
| 放开 CHECK | `audit_logs_resource_type_fixed` 加 `artifact_version`（需求文档漏项） |
| 新表 | `requirement_artifact_versions(id, requirement_id, version_number, published_by, published_at)`，`UNIQUE(requirement_id, version_number)` |
| 新表 | `requirement_artifact_version_files(id, version_id, attachment_id, file_name, size_bytes, sha256, storage_key)`，`UNIQUE(version_id, attachment_id)` |
| 新表 | `requirement_publish_operations(requirement_id, operation_key, request_digest, response_json, created_at)`，`UNIQUE(requirement_id, operation_key)` |
| 加列 | `requirement_comments.artifact_version_id uuid NULL UNIQUE REFERENCES requirement_artifact_versions(id)` |

**迁移号归属（以 dev_task 为执行准则）**：本节表格列出的是本需求的全部 schema 变更，
但它们**分两个迁移文件落地**，不是一个：

| 文件 | 归属 | 内容 |
|---|---|---|
| `003_requirement_status_in_refinement.sql` | pr2 | 放开 `requirements_status_fixed` 加 `in_refinement` |
| `004_requirement_artifact_versions.sql` | pr4 | 三张产物版本表、`requirement_comments.artifact_version_id` 加列、放开 `audit_logs_resource_type_fixed` 加 `artifact_version` |

拆开的理由是两片各自独立可验收、且 pr2 不依赖 pr4。两条 SQL 互不依赖，所以
003/004 乱序落地也安全；但迁移号必须预分配，两片各自新建文件，不抢号也不合并。

**SQLite（client/server）**：无迁移（§3.6）。

**契约**：`status.ts` 枚举与标签加 `in_refinement`「梳理中」；`collaboration.ts` 的 `REQUIREMENTS_EVENT_TYPES` 加 `artifact.published`；新增 `limits.ts` 与产物版本 DTO。

---

## 七、接口设计

| 端点 | 方法 | 说明 |
|---|---|---|
| `/v2/requirements/:requirementId/artifact-versions` | GET / POST | 列表 / 发布（`expectedVersion` + `operationKey` + `attachmentIds` + 可选 `note`） |
| `/v2/artifact-versions/:versionId` | GET | 版本详情与文件清单 |
| `/v2/artifact-versions/:versionId/files/:fileId/content` | GET | 下载版本文件（**不过滤软删**） |
| `/api/v2/…` 同名路径 | — | BFF 代理，沿用服务端持有的 token（`remote-client.ts:313-328`） |
| `/api/v2/artifact-versions/:versionId/fetch` | POST | 把该版拉到本机指定相对路径，返回落盘清单 |

---

## 八、文件变更清单

| 包 | 文件 | 动作 |
|---|---|---|
| contracts | `requirements-v2/status.ts`、`collaboration.ts`、新增 `limits.ts`、新增产物 DTO、`index.ts` | 改 / 增 |
| requirements-service | `migrations/003_requirement_status_in_refinement.sql`（pr2）、`migrations/004_requirement_artifact_versions.sql`（pr4） | 增 |
| requirements-service | 新增 artifact-version repository / service、`http/server.ts` 三路由 | 增 / 改 |
| requirements-service | `attachment-repository.ts`（activeStorageKeys 并集、版本文件下载查询、expectedVersion）、`attachment-service.ts`（删除跳过物理删）、`config.ts`（上限 100） | 改 |
| server (BFF) | `http/http-server.ts` 代理路由、`requirements-v2/remote-client.ts`、新增拉取落盘、`material-service.ts`（v3）、`requirements-v2-service.ts:307-323`（去预拉） | 改 / 增 |
| web | 看板加列、产物区与发布交互、发布评论卡片、`artifact.published` 事件分支、上限跟随 | 改 |
| skills | 发布 skill、拉取 skill（均带 `Origin` 头） | 增 |
| test | `web/test/requirements-board.test.ts:41-45`、`gate-c/steps/requirements-board.ts:10-14,51`、`requirements-service-fixture.ts:44-56` 六列断言 → 七列 | 改 |

---

## 九、依赖与配置

不引入新依赖。`REQUIREMENTS_MAX_ATTACHMENTS_PER_REQUIREMENT` 默认值 20 → 100，仍可环境变量覆盖。不新增认证机制。

---

## 十、迁移影响与风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 已发布文件复用普通下载查询而不可读 | **高** | §3.1 独立查询 + §5 红线回归 |
| `reconcile` 漏并集导致历史版本损坏 | **高** | §3.5 + §5 红线回归（重启后校验） |
| `artifact.published` 无前端分支，UI 陈旧 | 中 | §3.2 显式加分支 + §5 前端用例 |
| 附件侧 expectedVersion 缺口未补，N9 缓解落空 | 中 | §3.4 列为实现前置 |
| `auto` 档 loopback 不可达，skill 无法自动发布 | 中 | §5.4 实测前置，不可达则标注档位要求 |
| 修改 `001_initial.sql` 致已部署实例拒启 | 高 | §6 明确新增文件；理由已纠正为 checksum 校验 |

---

## 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-08-21 | v1.1 | §3.9 用户拍板方案 A（发布只接受已上传附件），补 skill 两步落法；同步修正需求 4.2 与六章的自相矛盾 |
| 2026-08-20 | v1.0 | 首版。经 Codex 协商 `job_b0693f826f68` 压测 D1–D8；纠正需求文档三处与代码现状不符的描述（迁移链归属、N9 现状、4.7 三处同一常量）；补需求文档漏项 `audit_logs` CHECK；提出 §3.9 范围收窄待拍板 |
