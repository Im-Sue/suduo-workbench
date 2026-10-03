---
doc_type: dev_task
task_id: subtask-bc7e58e94f84
title: pr4 远程服务端：产物版本表、发布事务与 blob 引用保护
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-pm-requirement-intake-001
section_id: pr4-artifact-version-service
order: 4
implementation_owner: ccb_codex
dependencies: [subtask-d91ec8487626]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-pm-requirement-intake-001.json
source_draft_hash: 5654ce687bb41fee3b28e53498d01f5fcb5d45a3044798f4fb1bdef682d17d88
created_at: 2026-08-21T17:19:54.263Z
updated_at: 2026-08-23T06:51:53.207036Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-pm-requirement-intake-001","branch":"ccb/req-suduo-v2-pm-requirement-intake-001"}
---

# pr4 远程服务端：产物版本表、发布事务与 blob 引用保护

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 迁移 004 三张新表与两处 CHECK、发布单事务（幂等/版本校验/发布评论/审计）、三条路由，以及两条红线：软删后版本文件仍可下载、reconcile 后版本引用 blob 不被清。 |
| 需求来源 | suduo-v2-pm-requirement-intake-001 |
| 本期范围 | pr4-artifact-version-service · pr4 远程服务端：产物版本表、发布事务与 blob 引用保护 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### pr4 远程服务端：产物版本表、发布事务与 blob 引用保护

#### 任务概述

这是整个需求的地基。做完之后，一次「发布」就等于**一次数据库事务**：把 PM 指定的一批已上传附件固化成一个不可变的版本，同时自动落一条发布评论说明这版是什么。

有两条**红线**必须在这一片里一起做完，不能留到以后：

- **软删挡下载**：现在取附件走的查询带 `deleted_at IS NULL`（`attachment-repository.ts:349-359` 的 `getRow`）。PM 删掉一个已发布过的文件，历史版本里那个文件就 404 了。
- **物理删毁历史**：删附件会立刻 `storage.remove()` 删掉真实文件（`attachment-service.ts:114-124`），服务重启的 `reconcile` 还会把所有不在活跃集合里的文件全清掉（`attachment-storage.ts:56-74`）。用户说「历史版本全留」，在当前存储行为下**根本不成立**。

这两条不是优化，是"不做就从第一天起功能就是坏的"。

#### 任务分解

**1. 迁移（新建 `migrations/004_requirement_artifact_versions.sql`；号已预留，不要改 001，也不要动 pr2 的 003）**

| 变更 | 内容 |
|---|---|
| 新表 | `requirement_artifact_versions(id, requirement_id, version_number, published_by, published_at)`，`UNIQUE(requirement_id, version_number)` |
| 新表 | `requirement_artifact_version_files(id, version_id, attachment_id, file_name, size_bytes, sha256, storage_key)`，`UNIQUE(version_id, attachment_id)` |
| 新表 | `requirement_publish_operations(requirement_id, operation_key, request_digest, response_json, created_at)`，`UNIQUE(requirement_id, operation_key)` |
| 加列 | `requirement_comments.artifact_version_id uuid NULL UNIQUE REFERENCES requirement_artifact_versions(id)` |
| 放开 CHECK | `audit_logs_resource_type_fixed`（`001_initial.sql:69-71`，现为四值）加 `artifact_version` |

文件表冗余 `file_name / size_bytes / sha256 / storage_key` 四列，是**发布那一刻的快照**：即使附件行后来被软删，版本里记的仍是当时的样子。物理文件的归属仍是单点——永远只由 `attachments` 行持有，版本表只引用、不另存。

**2. 契约**（`cloud/contracts/src/`）

- 新增 `limits.ts`，导出**三个分别命名**的常量，**不要合并成一个**——它们语义不同：服务端活跃附件硬上限（权威，409）/ 前端上传前预检（UX，可过期）/ 本机按需拉取单次文件数上限（防御远程，502）。
- 新增产物版本 DTO 与请求 schema。
- `collaboration.ts:88-93` 的 `REQUIREMENTS_EVENT_TYPES` 加 `artifact.published`。
- **`collaboration.ts:8-13` 的 `CommentDto` 加可空 `artifactVersionId`**——不加的话前端拿不到关联，pr6 的发布评论卡片没法渲染。
- **`collaboration.ts:23-28` 的 `AUDIT_RESOURCE_TYPES` 加 `artifact_version`，`:33-45` 的 `AUDIT_ACTIONS` 加发布动作**。只放开数据库 CHECK 是**不够**的，契约这层也是硬编码联合类型，漏了会在审计查询处编译不过或类型不匹配。
- `index.ts` 补导出。

**3. 发布事务**（新建 artifact-version repository + service）

```
POST /v2/requirements/:id/artifact-versions
     {expectedVersion, operationKey, attachmentIds[], note?}
  ├─ 幂等命中 requirement_publish_operations → 直接重放原响应，结束
  ├─ BEGIN
  │   ├─ SELECT … FROM requirements WHERE id=$1 FOR UPDATE
  │   ├─ 校验 expectedVersion（不匹配 409）
  │   ├─ 逐个校验 attachmentId 属本需求且未软删（跨需求一律 400）
  │   ├─ version_number = MAX(version_number)+1
  │   ├─ INSERT 版本行 → INSERT 文件清单（快照四列）
  │   ├─ INSERT 发布评论（artifact_version_id = 新版本；note 为空则系统生成一句）
  │   ├─ incrementRequirementVersion
  │   ├─ INSERT 审计（resource_type='artifact_version'）
  │   └─ INSERT requirement_publish_operations
  ├─ COMMIT
  └─ events.publish({type:'artifact.published', requirementVersion})
```

发布沿用附件增删的并发域（`attachment-repository.ts:175-207` 的 `FOR UPDATE` + `incrementRequirementVersion`）。事件**先落库后广播**，沿用现状（`server.ts:397-403`）。

幂等**不能照搬附件那套**：`server.ts:369-372` 的 `Idempotency-Key` 是直接拿来当 attachment id 用的（`attachmentOperationKey` 强制 UUID 格式），那是"一次性资源 ID 复用"，不是通用幂等机制。

**4. 三条路由**（`http/server.ts`）：版本列表 / 发布、版本详情与文件清单、版本文件下载。下载走**不过滤软删**的独立查询，只校验"这个文件属于这个版本"。

**5. blob 引用保护**

- `attachment-repository.ts:306` 的 `activeStorageKeys()` 改为并集：**未删附件 ∪ 被任一版本文件引用的 key**。
- `attachment-service.ts:114-124` 的 `delete()`：该 key 被版本引用时**跳过** `storage.remove()`，只软删行、照常 bump 版本。
- **不要误伤上传失败清理**（`attachment-service.ts:80-96`）：它删的是还没入库的新 key，不可能被任何版本引用，必须保持照删，否则会漏存储。这是第三条会物理删文件的路径，改动时要一并确认。

**6. 评论读取链路**：`collaboration-repository.ts:49-55` 的 `CommentRow` 与对应 SELECT / 映射补上 `artifact_version_id`，否则评论列表接口取不出来，契约加了字段也是空的。

**7. 装配**：`application.ts:13-39` 注入新 service 并传给 `buildHttpServer`；同步修 `application.test.ts`、`http-server.test.ts` 里的依赖对象与 mock。

**8. 容量上限**：`config.ts:4` 的 `MAX_ATTACHMENTS_PER_REQUIREMENT` 20 → 100（仍可环境变量覆盖）；单个产物版本文件数上限 50。

#### 验收标准

**红线（两条都必须有自动化用例，不能只靠手测）**

- [x] **删掉一个已发布的附件之后，该版本里的这个文件仍然下得下来。**
- [x] **服务重启跑完 `reconcile` 之后，被版本引用的文件仍然存在。**

**其余**

- [x] 全新库跑通全部迁移；已部署库增量应用 004 不触发 checksum 校验失败。
- [x] 并发发布同一需求，`version_number` 不重复、不跳号。
- [x] 同一个 `operationKey` 重复发布：只产生**一个**版本和**一条**评论，第二次重放原响应。
- [x] 传入别的需求的 attachmentId → 400；传入已软删的 attachmentId → 400。
- [x] 传过期 `expectedVersion` → 409，且**不产生半个版本**（版本、文件、评论、审计一个都不能留下）。
- [x] PM 没写说明时，仍然自动落一条系统生成的发布评论，时间线不断。
- [x] 上传失败清理路径不回归——未入库的新 key 仍然被删掉，不因引用保护而漏存。
- [x] 评论列表接口能返回 `artifactVersionId`。
- [x] 审计能查到 `artifact_version` 类型的记录（数据库 CHECK 与契约联合类型两侧都通）。
- [x] 活跃附件上限生效为 100；单版本文件数超过 50 被拒。
- [x] build / typecheck / lint 通过。

#### 边界

只做**远端 requirements-service** 这一侧。不碰本机 BFF、不碰前端、不写 skill。

不做产物历史清理策略（本期全留，容量策略后续再议）。**不做「随本次发布上传」**——发布是纯数据库事务，只接受**已上传**附件的 ID，不在同一请求内接收文件字节（技术设计 §3.9，用户 2026-08-21 拍板方案 A）。不做主文档标记、不加 `change_note` 字段（变更说明靠评论承载，评论 append-only 保证不可篡改）、不让版本快照标题与描述（业务规则 N6，标题描述与产物解耦）。不改状态枚举（归 pr2）。

#### 依赖与顺序提示

依赖 **pr3**：两片都改 `attachment-repository.ts` 与 `attachment-service.ts`，必须串行，pr3 先合。

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-d91ec8487626
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-08-21 | 物化任务文档 | 无 | 等待 dispatch 派工 |
| 2026-08-23 | 分 4 块交付，全部验收通过 | 整片单轮派工三次被模型网关掐断（stream disconnected），改为分块小 turn 推进 | 归档 |

## 五、验收标准

- [x] 完成 `spec_section_md` 定义的实现范围。
- [x] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [x] 完成必要验证，并在回执中说明测试命令与结果。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## Materialization Context

- Requirement: suduo-v2-pm-requirement-intake-001
- Section: pr4-artifact-version-service
- Owner: ccb_codex
- Priority: high
- Dependencies: subtask-d91ec8487626

## 七、验收证据

5 个提交（分块推进）：

| 提交 | 内容 |
|---|---|
| `b93a7c7` | 产物版本仓储 + 发布事务 service + 6 项 PG 单测 |
| `b77837a` | 四条 HTTP 路由（列表 / 发布 / 详情 / 版本文件下载）+ 应用装配 |
| `caebfa2` | 两条红线的引用保护与用例 |
| `a88e010` | 收尾验收补齐（迁移、并发、上限 100、审计、评论关联） |
| `f114d44` | 返工：补 `AUDIT_TEXTS` 缺键 |

004 sha256 `7a8a2fae7d968d8ea57926db60773a8374d17d0e15fcac1822350e2e7ac76019`。

### 两条红线

| 红线 | 用例 | 断言 |
|---|---|---|
| 软删挡下载 | `红线一：软删已发布附件后，版本文件仍可下载且字节一致` | 真实上传→发布→软删→经版本快照打开存储对象，**字节完全相同** |
| 物理删毁历史 | `红线二：软删后重启运行 reconcile，版本引用的 blob 仍存在` | 关闭服务→重建实例→`initialize()` 走真实 reconcile→blob 与引用 key 均保留 |

实现：`retainedStorageKeys()` = 活跃附件 ∪ 版本引用 storage_key 的并集，喂给 `reconcile`；
`delete()` 在物理删前查引用，被引用则跳过物理删但记录仍软删。
`getVersionFileForDownload` 只读版本文件快照表、**不关联 attachments**，
未放宽既有 `getForDownload→getRow` 的 `deleted_at IS NULL`。

**保护未过宽**（执行方自行补充，评审确认必要）：
`physically removes a soft-deleted blob that no artifact version references` —— 
只证明「该留的留住」不够，还须证明「该删的没被误留」，否则磁盘无限膨胀。

**不回归**：`keeps deleting an uncommitted storage key when the metadata write fails` —— 
上传失败清理路径（`attachment-service.ts:80-96`）删的是未入库的新 key，不受引用保护影响。

### 其余 11 条

| # | 验收项 | 证据 |
|---|---|---|
| 1 | 全新库 + 已部署库增量 004 无 checksum 漂移 | 本块新增 `migration-runner.test.ts`：001→004 全量、001/002/003 后增量 004 |
| 2 | 并发发布 version_number 不重不跳 | `并行发布同一需求时版本号连续且不重复`，6 个并发最终为 `1..6` |
| 3 | 同 operationKey 只产生一个版本一条评论并重放 | `相同 operationKey 和请求摘要重放原响应且不新增记录` |
| 4 | 跨需求 / 已软删 attachmentId → 400 | `跨需求和已软删 attachmentId 都以 400 拒绝` |
| 5 | 过期 expectedVersion → 409 且不留半个版本 | `过期 expectedVersion 返回 409 且没有留下半个版本`——**断言版本/文件/评论/审计/操作记录五张表均为 0**，非仅状态码 |
| 6 | 无说明时自动落系统发布评论 | `未填写说明时仍落系统生成的发布评论` |
| 7 | 上传失败清理路径不回归 | 见上「不回归」 |
| 8 | 评论列表返回 `artifactVersionId` | 本块 HTTP 断言 |
| 9 | 审计查得到 `artifact_version` | HTTP 断言 `artifact_version` / `artifact_version.published`；契约联合类型由 typecheck 覆盖 |
| 10 | 活跃上限 100、单版本超 50 被拒 | `config.ts` 引用 `REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT` 常量（非字面量）；「第 100 个允许、第 101 个拒绝」用例；`单版本超过 50 个文件时拒绝且不创建记录` |
| 11 | build / typecheck / lint | 全绿 |

### 最终验证（控制器独立复跑，非采信回执）
`pnpm typecheck` 四包全 Done；`pnpm lint` exit 0；`pnpm test` **48 files / 237 tests 全通过**。

### 过程记录：两处需要留痕的事

**一、单轮派工三次失败，根因是模型网关而非实现。**
pane 内留有 `stream disconnected before completion: Transport error: network`。
与 `gate_c_blocked_by_gateway`（模型网关无法维持长流式 turn）同源。pr4 是最大片，
最易触发。改为 4 块小 turn 后一次通过。**后续大片应默认分块派工。**

**二、执行方只跑本包测试导致漏网，已立规矩。**
`a88e010` 后 `client/web` typecheck 红：contracts 新增 `artifact_version.published`，
而 `requirements-detail.ts:34` 的 `Record<AuditAction,string>` 穷举映射缺键（TS2741）。
该映射的注释原本就写明「契约新增动作时此处编译期即报缺键」——**保险丝按设计起火**。
`f114d44` 补齐。已要求后续所有片交付前一律在**工作区根目录**跑
`pnpm typecheck && pnpm lint && pnpm test`，只跑本包不算数。

**边界例外（仅此一处）**：pr4 边界为「不碰前端」，返工补 `AUDIT_TEXTS` 一个键属
pr4 自身契约改动强制导致的编译中断，不修会让 pr5/pr6/pr7 全在红基线上验证。
未做任何产物区 UI 或发布交互（仍属 pr6）。
