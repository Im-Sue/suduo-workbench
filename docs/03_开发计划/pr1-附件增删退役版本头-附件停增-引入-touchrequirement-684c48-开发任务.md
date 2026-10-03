---
doc_type: dev_task
task_id: subtask-9c5e99684c48
title: PR1 · 附件增删退役版本头 + 附件停增（引入 touchRequirement）
status: done
current_node: archive
node_substate: archived
runtime_state: completed
review_status: passed
priority: high
requirement_id: suduo-v2-consistency-guard-retirement-001
section_id: pr1-attachment-guard-retirement
order: 1
implementation_owner: ccb_codex
dependencies: []
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-consistency-guard-retirement-001.json
source_draft_hash: e28850e1cde166d3072c41284b6d9488827ccc4436d4c168fceb88e565240d46
created_at: 2026-09-06T05:15:51.836Z
updated_at: 2026-09-06T05:58:40.331Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-consistency-guard-retirement-001","branch":"ccb/req-suduo-v2-consistency-guard-retirement-001"}
---

# PR1 · 附件增删退役版本头 + 附件停增（引入 touchRequirement）

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 删掉附件上传 / 删除的 X-Requirement-Expected-Version 校验（契约常量、rs、BFF、web 同片），附件操作改为只刷 updated_at / updated_by 不抬 version；web 去掉多文件上传的版本串接但保留逐个上传、首败即停与单项重试；改写 attachment-*、audit、BFF http.test 与 Gate-C 附件删除步骤。 |
| 需求来源 | suduo-v2-consistency-guard-retirement-001 |
| 本期范围 | pr1-attachment-guard-retirement · PR1 · 附件增删退役版本头 + 附件停增（引入 touchRequirement） |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### PR1 · 附件增删退役版本头 + 附件停增（引入 touchRequirement）

#### 任务概述

**目标对齐**：今天上传或删除附件时，客户端会带一个「我看到的需求版本号」（`X-Requirement-Expected-Version` 头，下文简称版本头），服务端对不上就 409 拒绝；而这个版本号又会被别人的附件操作、正文编辑、产物发布一起抬高，所以多文件上传必须拿上一次响应的版本号串接下一次，PM 改描述时有人传了个附件保存就失败。这一片把附件路径上的版本头彻底删掉（契约、服务、BFF、web 全部同片），并让附件操作**不再抬版本号**，只刷新「最后更新时间 / 更新人」。做完后：传附件、删附件不再因为别人动了需求而失败；旧版发布 skill 副本带着旧版本头照样能用。

| 项 | 说明 |
|----|------|
| 交付目标 | 需求 4.2 附件增删不再拒绝 + 4.4 中「附件增删不再自增 version」（N1 / N2 / N3 / N6 / N8） |
| 需求来源 | `docs/02_需求设计/v2-一致性守卫退役-需求.md` §4.2 / §4.4 |
| 技术来源 | `docs/03_开发计划/v2-一致性守卫退役-技术设计.md` 二、三、四、八、十（附件片） |
| 本期范围 | requirements-service 附件仓储 / 服务 / HTTP；contracts 版本头常量；BFF 附件代理；web 上传 / 删除；对应测试与 Gate-C 附件步骤 |
| 不含范围 | 需求编辑（PR2）、产物发布与 skill（PR3）、错误码（PR4） |
| 分工 | ccb_codex 实施与验证 |

#### 任务分解

**1. requirements-service（远程真相层）**

- [ ] **1.1 新建 `touchRequirement`**（= 只刷新 `updated_at` / `updated_by`、不动 `version`、返回当前版本的写入）
  - 内容：`[NEW] cloud/server/src/infrastructure/requirement-touch.ts`，签名 `touchRequirement(executor, requirementId, actorId): Promise<number>`；SQL `UPDATE requirements SET updated_by=$1, updated_at=now() WHERE id=$2 RETURNING version`；无行抛 `notFound("需求")`
  - 产出：单一共享 helper（PR3 复用，届时删除发布侧那份 `incrementRequirementVersion`）
  - 依赖：无
- [ ] **1.2 附件仓储去版本校验、改停增**
  - 内容：`attachment-repository.ts:172-182`（create）与 `:282-294`（delete）删 `expectedVersion` 参数与 `versionConflict` 分支；`:211` / `:300` 改调 `touchRequirement`；删本地 `incrementRequirementVersion`（`:419-437`）。`FOR UPDATE` 行锁与附件上限检查**原样保留**
  - 产出：附件审计 `after.version` 记录的是操作时的当前正文版本（不再 +1）
  - 依赖：1.1
- [ ] **1.3 附件服务去入参**
  - 内容：`attachment-service.ts:42, 68, 74, 126-128` 删 `expectedVersion`；删 `:74` 对 `VERSION_CONFLICT` 的特判分支。上传失败后的存储清理与幂等重放逻辑保留
  - 依赖：1.2
- [ ] **1.4 HTTP 层删版本头解析**
  - 内容：`http/server.ts:27` 删常量 import，`:496-498` / `:557-558` 删两处调用，`:638-652` 删 `optionalExpectedVersion()`。旧客户端仍带该头 → 直接忽略
  - 依赖：1.3

**2. contracts**

- [ ] **2.1** `cloud/contracts/src/collaboration.ts:87` 删 `REQUIREMENTS_V2_EXPECTED_VERSION_HEADER`；`:93` / `:118` 的 `requirementVersion` 注释改为「操作完成时的当前正文版本」。**字段本身保留**
  - 依赖：无（先改契约再 `pnpm --filter @suduo/client-contracts build`）

**3. BFF（client/server）**

- [ ] **3.1** `application/requirements-v2-service.ts:321` / `:418`：`uploadAttachment` / `deleteAttachment` 入参删 `expectedVersion`
- [ ] **3.2** `infrastructure/http/http-server.ts:36` 删 import；`:1016-1019` / `:1063-1066` 删两处 `optionalHeader("expectedVersion", …)`；`:1154` 泛型收窄为 `"contentLength" | "attachmentSize"`
- [ ] **3.3** `infrastructure/requirements-v2/remote-client.ts:31, 286, 303-305, 396, 404-406` 删透传。BFF 从此**不再向远端转发**版本头
  - 依赖：2.1

**4. web（client/web）**

- [ ] **4.1** `api/client.ts:68` 删 import；`:376-382` / `:786-803` 上传删 `expectedVersion` 形参与 `setRequestHeader`；`:389-394` 删除删参数与 header
- [ ] **4.2** `RequirementsWorkbench.tsx`
  - `uploadOne`（`:854-890`）：删 `expectedVersion` 形参；删 `:867-871` 只改本地 `version` 的 `setSelected`（`:866` 成功后移除上传任务的 `setUploadJobs` **保留**）；删 `:883` 的 `version_conflict` 分支；**返回值改为 `boolean`（成功 true / 失败 false）**，不要直接删返回值
  - `uploadSelectedFiles`（`:892-917`）：删 `:912` / `:916` 串接变量；**保留逐个 `await` 的 for 循环与 `:915` 首败即停**（改为 `if (!ok) return;`）
  - `:1036` 单项重试 `onRetryUpload` 改为 `void uploadOne(job)`，行为不变
  - `deleteAttachment`（`:919-947`）：删 `selected.version` 实参；删 `:925-929` 本地 `version` 更新；删 `:937` 分支。失败只 `reportError`
  - 依赖：4.1

**5. 测试**

- [ ] **5.1** `cloud/server/test/attachment-repository.test.ts:49-83`「版本过期时在持锁后回滚」：改写为「create / delete 不再有版本参数；`touchRequirement` 的 SQL 不含 `version + 1`；上限 409 与持锁回滚仍成立」
- [ ] **5.2** `attachment-service.test.ts:53-59` 作废「explicit version is stale」；`:79` 的 `service.delete(ACTOR_ID, ATTACHMENT_ID, 20)` 去第三参。**不要为了测「带旧版本仍成功」往已删参数的 service 签名里重新塞字段**——该证明放 HTTP 层（5.4）
- [ ] **5.3** `audit-project-id.test.ts:294-295` 删版本头；附件 created / deleted 步骤的 `version` 期望改为「等于操作前的 `requirement.version`」；`artifact-reference-protection.test.ts:96` / `:119` 删 `attachments.delete` 第三参（`:88` / `:112` 发布字段留给 PR3）
- [ ] **5.4** requirements-service HTTP 层新增（真实 PG，可放 `audit-project-id.test` 或新文件）：上传与删除各带一个**过期**的 `X-Requirement-Expected-Version` 头 → 仍 201 / 200，响应 `requirementVersion` 等于当前正文版本
- [ ] **5.5** `client/server/test/http.test.ts:396-465`「附件版本头经 BFF 透传…」改写：连续三次上传 + 一次删除全部成功；断言 `state.expectedVersionHeaders` **全为 `null`**（BFF 不再转发，即便客户端带了旧头）；删 stale-409 段；夹具远端 `:1360-1420` 删按头 409 的分支与 `requirementVersion += 1`
- [ ] **5.6** Gate-C：`steps/requirements-board.ts:237-270` 改为「带外正文 PATCH 抬版本后，主窗口删附件**仍成功**：确认对话框仍弹出并点确认 → 详情回查到 v3 且『待删除材料.txt』消失」，删除 `version_conflict` 反馈的等待；`requirements-service-fixture.ts:361-373` 删除路由不再校验版本头，并**删 `:371` 的 `requirement.version += 1`**（响应 `requirementVersion` 返回未自增的当前版本；不删则删附件后夹具变 v4，与本步「详情 v3」冲突。夹具版本链：PR1 / PR2 期间 v1 → 发布 v2 → 带外 PATCH v3 → 删附件仍 v3；PR3 删发布自增后为 v1 → 发布仍 v1 → 带外 PATCH v2 → 删附件仍 v2）。`:242` 带外 PATCH 的 `expectedVersion: 2` **本片保留**（夹具 PATCH 归 PR2）

#### 验收标准

- [ ] 全仓 `grep -rn "REQUIREMENTS_V2_EXPECTED_VERSION_HEADER" apps packages --include=*.ts --include=*.tsx | grep -v /dist/` 零命中；**生产代码**中字面 `X-Requirement-Expected-Version` 只剩官方 skill 脚本（PR3 处理）；**测试代码**中该字面只允许作为旧客户端兼容输入（5.4 / 5.5）或「不再转发」断言出现，加上 `official-artifact-skills.test` 夹具（PR3 处理）——回执逐项列出每处用途；生产与测试都不得残留任何版本校验或版本串接逻辑
- [ ] 附件上传 / 删除后 `requirements.version` 不变、`updated_at` / `updated_by` 刷新；审计 `attachment.created` / `attachment.deleted` 正常写入且 `version` 为当前正文版本
- [ ] 带过期版本头的上传 / 删除经 requirements-service 仍 201 / 200（5.4）；经 BFF 时头不被转发（5.5）
- [ ] 附件上限 409 `ATTACHMENT_INVALID`、`FOR UPDATE` 持锁回滚、幂等重放三项行为与今天一致
- [ ] web：多文件上传仍逐个进行，首个失败后停止后续上传，失败项可单独重试；上传 / 删除失败只上报错误，不做任何自动刷新或提示
- [ ] 专项回归：删附件确认对话框仍在（Gate-C 5.6 覆盖）；`artifact-reference-protection.test` 两条红线全绿；产物版本文件在附件软删后仍可下载
- [ ] 四个包测试 + `typecheck` + `lint` 全绿；Gate-C 能跑则跑，跑不了回执写明
- [ ] 回执逐条确认「全片共享约束」1-8 未动，并显式回答「本片未引入新的拒绝式守卫」

#### 边界

- 不碰 `collaboration-repository.ts` / `collaboration-service.ts` / `schemas.ts`（PR2）；不碰 `artifact-version-*` / skill / `系统架构.md`（PR3）；不碰错误码（PR4）
- 发布路径本片仍校验 `expectedVersion`，旧 skill 副本靠响应字段保留继续可用——这是设计好的中间态，不要顺手改发布
- 不把上传改成并行、不加自动重试、不加任何锁或版本复核

#### 风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 直接删掉 `uploadOne` 返回值会静默丢掉「首败即停」 | 中 | 4.2 明写改为布尔返回并保留循环语义 |
| 执行者为了测旧头往 service 签名回塞参数 | 低 | 5.2 明令禁止，证明放 HTTP 层 |
| 顺手把附件 `FOR UPDATE` 当守卫删掉 | 高 | 它保证附件上限原子性，与版本校验不是一类东西；需求六、边界明确保留，共享约束 1 |

## 三、执行顺序 / 里程碑

- 前置依赖: 无
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-09-06 | 物化任务文档 | 无 | 等待 dispatch 派工 |
| 2026-09-06 | 派工 slot2_codex（job_6c59f49ceb8e）；实施完成，提交 `fb911cf8` | 首轮 PG `ECONNRESET`，重跑通过 | 进入审查 |
| 2026-09-06 | 审查通过并归档：Claude 独立复跑四包测试 + typecheck + lint 全绿，并回读 diff 核实边界 | Gate-C 按用户拍板延后至 PR3 后统一跑 | PR2 派工 |

## 五、验收标准

- [ ] 完成 `spec_section_md` 定义的实现范围。
- [ ] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [ ] 完成必要验证，并在回执中说明测试命令与结果。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## Materialization Context

- Requirement: suduo-v2-consistency-guard-retirement-001
- Section: pr1-attachment-guard-retirement
- Owner: ccb_codex
- Priority: high
- Dependencies: none
