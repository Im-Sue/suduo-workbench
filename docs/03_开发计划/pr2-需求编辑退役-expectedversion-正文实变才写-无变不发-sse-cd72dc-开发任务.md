---
doc_type: dev_task
task_id: subtask-09b88fcd72dc
title: PR2 · 需求编辑退役 expectedVersion + 正文实变才写 + 无变不发 SSE
status: done
current_node: archive
node_substate: archived
runtime_state: completed
review_status: passed
priority: high
requirement_id: suduo-v2-consistency-guard-retirement-001
section_id: pr2-requirement-edit-guard-retirement
order: 2
implementation_owner: ccb_codex
dependencies: [subtask-9c5e99684c48]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-consistency-guard-retirement-001.json
source_draft_hash: e28850e1cde166d3072c41284b6d9488827ccc4436d4c168fceb88e565240d46
created_at: 2026-09-06T05:15:51.836Z
updated_at: 2026-09-06T06:15:43.626Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-consistency-guard-retirement-001","branch":"ccb/req-suduo-v2-consistency-guard-retirement-001"}
---

# PR2 · 需求编辑退役 expectedVersion + 正文实变才写 + 无变不发 SSE

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 需求 PATCH 删 expectedVersion 必填入参与 409；UPDATE 加 (title, summary, status) IS DISTINCT FROM 条件，无实变则不写、不审计、不发 SSE、200 返回当前 DTO；不加 FOR UPDATE（用户拍板 A）；contracts / BFF / web 编辑侧同片；真实 PG 补并发同值只自增一次与后写生效用例；Gate-C req-conflict 改为非版本类真实失败。 |
| 需求来源 | suduo-v2-consistency-guard-retirement-001 |
| 本期范围 | pr2-requirement-edit-guard-retirement · PR2 · 需求编辑退役 expectedVersion + 正文实变才写 + 无变不发 SSE |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### PR2 · 需求编辑退役 expectedVersion + 正文实变才写 + 无变不发 SSE

#### 任务概述

**目标对齐**：今天改需求标题 / 描述 / 状态（包括看板拖卡片）必须带 `expectedVersion`（= 客户端告诉服务端「我看到的版本号」），对不上就 409「请刷新」，改的字白打。这一片把这个必填入参从契约、服务、BFF、web 全部删掉，后写生效；同时把「写」收紧为**只有正文真的变了才写**：`title` / `summary` / `status` 任一实际变化才 `version + 1`、刷 `updated_at`、写审计、发 SSE；值没变的 PATCH 什么都不动，直接 200 返回当前内容。做完后：拖卡片不再因为别人传了附件弹回原列；手滑连点两次保存不会留下两条审计。

| 项 | 说明 |
|----|------|
| 交付目标 | 需求 4.1 需求编辑不再拒绝 + 4.4 中「仅正文实变自增」「值未变的 PATCH 不产生写入痕迹」（N1 / N2 / N4 / N6 / N8） |
| 需求来源 | `docs/02_需求设计/v2-一致性守卫退役-需求.md` §4.1 / §4.4 |
| 技术来源 | 技术设计 三、关键决策（SQL 端实变判定、**用户拍板 A 不加锁**、无实变不发 SSE）、四、核心流程、十（编辑片） |
| 本期范围 | `updateRequirement` 仓储 / 服务 / PATCH 路由；contracts 请求类型与 schema；BFF 校验；web 编辑与拖拽；测试与 Gate-C 冲突步骤 |
| 不含范围 | 附件（PR1 已完成）、发布与 skill（PR3）、错误码（PR4）、`updateProject` |
| 分工 | ccb_codex 实施与验证 |

#### 任务分解

**1. requirements-service**

- [ ] **1.1 `updateRequirement` 改 SQL 实变条件**（`collaboration-repository.ts:483-520`）
  - 内容：删 `expectedVersion` 入参与两处 `versionConflict`；WHERE 改为 `id = $5 AND (title, summary, status) IS DISTINCT FROM (COALESCE($1, title), COALESCE($2, summary), COALESCE($3, status))`（`IS DISTINCT FROM` = Postgres 的「不相等」比较，NULL 也当可比较的值；三字段均 NOT NULL，不会出现 NULL 分支）；`rowCount = 0` → 返回 `{ requirement: before, changed: false }`，不写审计；`rowCount = 1` → `after = getRequirement()` → 现有审计（`requirement.updated` / `status_changed` 判定不变）→ `{ requirement: after, changed: true }`
  - **不加 `FOR UPDATE`，不改 `before` 的无锁预读**（用户拍板 A）。`versionConflict` import 保留（`updateProject` 用）
  - 依赖：无
- [ ] **1.2** `collaboration-service.ts:97-110`：不再透传 `expectedVersion`；返回 `{ requirement, changed }`
- [ ] **1.3** `http/server.ts:401-420` PATCH 路由：`changed === false` 时**不** `events.publish`，仍 200 返回 DTO；`changed === true` 照发 `requirement.changed(version)`
  - 依赖：1.2

**2. contracts**

- [ ] **2.1** `requirements-v2/requirements.ts:37` 删 `expectedVersion`
- [ ] **2.2** `requirements-v2/schemas.ts:67-82` `updateRequirement` 删 `required: ["expectedVersion"]` 与属性；`additionalProperties: false` 保持，靠 Fastify 默认 Ajv `removeAdditional`（= 请求体里没在 schema 声明的字段直接剥掉、不报错）容忍旧客户端。`updateProject`（`:47-57`）**不动**
  - 依赖：无（改完 `pnpm --filter @suduo/client-contracts build`）

**3. BFF**

- [ ] **3.1** `requirements-v2-service.ts:208` 删 `validateExpectedVersion(input.expectedVersion)`；`:185`（项目）与 `:784-792` 函数本体**保留**
  - 依赖：2.1

**4. web**

- [ ] **4.1** `RequirementsWorkbench.tsx`：删 `:132` `requirementEditVersion` 状态及其 `:777-790` 读写；删 `:282-285`（拖拽）、`:786`（编辑保存）、`:812-815`（详情改状态）三处 `expectedVersion:`。拖拽 catch（`:288-300`，任何失败都回查真实状态落位）与 `changeStatus` 回滚**保留**；`:746` 项目编辑**不动**
  - 依赖：2.1

**5. 测试**

- [ ] **5.1** `audit-project-id.test.ts:205` / `:221` 删 `expectedVersion`；`requirement.updated` / `requirement.status_changed` 仍各 +1
- [ ] **5.2** requirements-service 真实 PG 新增（可放 `audit-project-id.test` 或新文件）：
  - 三字段各改一处 → 各 +1、各一条审计
  - 三字段同值 PATCH → `version` / `updated_at` / `updated_by` 不变、无审计行、`changed = false`、HTTP 200 且返回当前 DTO
  - **并发同值 PATCH 只自增一次**：两条独立连接（`database.ts:26` 每事务独立取连接）+ 测试侧屏障让两笔都完成预读 `before` 后再执行 UPDATE → 最终 `version` 只 +1、审计只 1 条。屏障做法：在测试侧包装事务 client / executor，首个 SELECT 完成后等待「两笔都已预读」的 Promise 再放行后续 UPDATE，不加任何生产钩子。**不要用 sleep，不要加生产锁；不要求两份响应都等于最终 DTO**（第二笔按设计返回预读 `before`）
  - **后写生效（异字段合并）**：客户端 A 与 B 同读 v1，A 改 `title`、B 改 `summary`，都不带版本 → 都 200；最终行同时含 A 的 title 与 B 的 summary，`version = 3`，两条 `requirement.updated` 审计（`before` 归属偏差属已接受残余，不断言 `before`）
  - **后写生效（同字段覆盖）**：A 与 B 同读 v1，A 把 `title` 改为「甲」并完成，B 再把 `title` 改为「乙」，都不带版本 → 都 200；最终 `title = 乙`、`version = 3`、两条 `requirement.updated` 审计。只有这一例才证明「后写覆盖」，上一例只证明异字段合并，两例都保留
  - HTTP 层：body 带 `expectedVersion` 的 PATCH 返回 200（钉住 `removeAdditional`，防未来有人改 Ajv 选项）
- [ ] **5.3** `http-server.test.ts`（mock 服务）：`updateRequirement` 返回 `changed: false` 时 `RequirementsEventHub.publish` **调用次数为零**；`changed: true` 时发一次
- [ ] **5.4** BFF `client/server/test/http.test.ts` **新增**需求 PATCH 透传用例（今天不存在）：新 body（不带字段）与旧 body（带 `expectedVersion`）经 BFF 到夹具远端都 200，远端收到的 body 原样透传
- [ ] **5.5** Gate-C：`requirements-service-fixture.ts:96-97` `req-conflict` 改名为真实失败夹具、`:399-412` 该需求的 PATCH 改回 **`503 DEPENDENCY_UNAVAILABLE`**（只此一路，GET 继续成功；**不要**启用全局 `remoteFailure`）；`steps/requirements-board.ts:135-152` 注释与断言改为「PATCH 真实失败时，卡片按回查真实状态落 in_testing，不回弹 draft、不留 completed」；`:242` 带外 PATCH 去掉 `expectedVersion: 2`
- [ ] **5.6** web：`requirements-board.test.ts` 的 `shouldApplyEvent` 用例不变（去重算法不动）

#### 验收标准

- [ ] **生产代码**中需求编辑相关的 `expectedVersion`（`updateRequirement` 仓储 / 服务 / 路由、`UpdateRequirementRequest`、`schemas.updateRequirement`、BFF `:208`、web 三处）零命中，剩余命中只属项目编辑与发布（发布归 PR3）；**测试代码**中需求编辑路径的该字面只允许作为旧客户端兼容输入（5.2 HTTP 层旧 body、5.4 BFF 旧 body）出现——回执逐项列出用途；不得残留任何版本校验逻辑
- [ ] 改 `title` / `summary` / `status` 任一 → `version + 1`、`updated_at` 刷新、审计一条、SSE 一次；同值 PATCH → 三者皆无、200 返回当前 DTO
- [ ] 并发同值 PATCH 最终只 +1（5.2）；后写生效两例（异字段合并、同字段覆盖）通过（5.2）
- [ ] 旧 body 带 `expectedVersion` 的 PATCH 经 requirements-service 200（Ajv 剥离），经 BFF 200（5.4）
- [ ] 看板：拖卡片后落目标列；PATCH 真实失败（非版本类）时按回查真实状态落位（Gate-C 5.5）
- [ ] `git grep -n "FOR UPDATE" cloud/server/src/infrastructure/collaboration-repository.ts` 零命中（用户拍板 A）
- [ ] 四个包测试 + `typecheck` + `lint` 全绿；Gate-C 能跑则跑，跑不了回执写明
- [ ] 回执逐条确认「全片共享约束」1-8 未动，并显式回答「本片未引入新的拒绝式守卫」（SQL 实变检测是检测，不是拒绝）

#### 边界

- 不碰附件路径（PR1 已完成，勿回改）；不碰 `artifact-version-*` / `schemas.publishArtifactVersion` / skill（PR3）；不碰错误码（PR4）
- 不加锁、不做应用层三字段比对替代 SQL 条件（设计三已否决：两请求同读同写时第二笔仍会自增）
- 无变 PATCH 不发 SSE 是**不发**，不是发一个同版本事件靠前端丢弃

#### 风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 并发测试写不出来时执行者「顺手」加 `FOR UPDATE` 让断言好写 | 高 | 用户拍板 A 明令禁止；验收含 grep 零命中 |
| 审计 `before` 无锁预读在交错窗口可能把他人字段记进本人条目 | 低 | 已接受残余（对方条目仍完整，人可对照恢复）；测试不断言 `before` |
| `req-conflict` 夹具若改成全局远端故障，回查 GET 也失败，step 断言失效 | 中 | 5.5 明写只让该需求的 PATCH 503 |

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-9c5e99684c48
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-09-06 | 物化任务文档 | 无 | 等待 dispatch 派工 |
| 2026-09-06 | 派工 slot2_codex（job_c3686535640a）；实施完成，提交 `6b10424` | 无 | 进入审查 |
| 2026-09-06 | 审查通过并归档：Claude 独立复跑四包 + typecheck + lint（requirements-service 首轮 PG ECONNRESET，重跑 14 文件/55 测试全绿），并回读 SQL、屏障实现与 Gate-C diff | Gate-C 按用户拍板延后至 PR3 后统一跑 | PR3 派工 |

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
- Section: pr2-requirement-edit-guard-retirement
- Owner: ccb_codex
- Priority: high
- Dependencies: subtask-9c5e99684c48
