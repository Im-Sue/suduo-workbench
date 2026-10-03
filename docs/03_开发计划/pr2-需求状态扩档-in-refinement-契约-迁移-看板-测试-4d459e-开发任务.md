---
doc_type: dev_task
task_id: subtask-dbc8e64d459e
title: pr2 需求状态扩档 in_refinement（契约 · 迁移 · 看板 · 测试）
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-pm-requirement-intake-001
section_id: pr2-status-in-refinement
order: 2
implementation_owner: ccb_codex
dependencies: []
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-pm-requirement-intake-001.json
source_draft_hash: 5654ce687bb41fee3b28e53498d01f5fcb5d45a3044798f4fb1bdef682d17d88
created_at: 2026-08-21T17:19:54.263Z
updated_at: 2026-08-23T04:30:36.171193Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-pm-requirement-intake-001","branch":"ccb/req-suduo-v2-pm-requirement-intake-001"}
---

# pr2 需求状态扩档 in_refinement（契约 · 迁移 · 看板 · 测试）

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 在 draft 与 ready_for_development 之间插入 in_refinement「梳理中」：契约枚举与标签、迁移 003 放开 CHECK、前端标签与七列布局复核、六列断言改七列。 |
| 需求来源 | suduo-v2-pm-requirement-intake-001 |
| 本期范围 | pr2-status-in-refinement · pr2 需求状态扩档 in_refinement（契约 · 迁移 · 看板 · 测试） |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### pr2 需求状态扩档 in_refinement（契约 · 迁移 · 看板 · 测试）

#### 任务概述

看板现在六列，`草稿` 这一列里同时装着「昨天随手记的一句话」和「就差定稿了」。这两种东西对开发的意义完全不同，但卡片长得一样。这片在 `草稿` 与 `待开发` 之间插一列 **`梳理中`（`in_refinement`）**，让"PM 在认真搞这个，你可以提前扫一眼但先别动手"变成看板上看得见的信号。

改动面比想象中小：看板列顺序**直接等于**状态枚举（`requirements-board.ts:16` 的 `BOARD_COLUMNS = REQUIREMENT_STATUSES`），所以枚举里加一档，列就自动出现，不用改看板的渲染逻辑。真正要手动补的只有中文标签、数据库约束和布局复核。

#### 任务分解

1. **契约**：`cloud/contracts/src/status.ts` 的 `REQUIREMENT_STATUSES` 在 `draft` 与 `ready_for_development` **之间**插入 `in_refinement`（**声明顺序即看板列序，不能追加到数组末尾**）；`REQUIREMENT_STATUS_LABELS` 加 `in_refinement: "梳理中"`。`schemas.ts` 引用的是同一个常量（`schemas.ts:4,62,77,102`），会自动跟随，不用改。

2. **迁移**：新建 `cloud/server/migrations/003_requirement_status_in_refinement.sql`，放开 `requirements_status_fixed` CHECK（`001_initial.sql:38-47`）加入 `in_refinement`。
   - **迁移号 003 已为本片预留**，pr4 用 004，两片各自新建文件，不要抢号也不要合并。
   - **绝对不能改 `001_initial.sql`**：runner 对已应用文件做 sha256 校验，改了会让已部署实例启动即抛「checksum 已漂移」（`migration-runner.ts:41-47`）。

3. **前端标签**：`client/web/src/components/requirements-v2/requirements-board.ts:19` 的 `STATUS_LABEL` 补一条。这是与 contracts 重复的第二份映射，类型是 `Record<RequirementStatus,string>`，不补会直接编译不过——**这是好事，它是漏改的保险丝**，不要为了省事把它改成宽松类型。

4. **七列布局复核（用自动断言，不靠肉眼）**：`RequirementsBoard.tsx` 的列布局是按「六列等宽」调过的（每列 `min-w-[188px]`，窄屏才回退横向滚动，理由写在该文件头部注释里：旧版六列合计约 1370px 被塞进约 780px 左栏，只看得到 3.5 列）。加到七列后必须补一条**固定 viewport 下断言列容器 `scrollWidth <= clientWidth`** 的用例（选一个明确的基准宽度写进用例，不要用"常见宽度"这种没法复现的说法）；人工看一眼只作补充，不作为验收依据。同时把 `RequirementsBoard.tsx` 里写死的"六列"文案与注释改掉。

5. **测试改断言**：
   - `client/web/test/requirements-board.test.ts:42-44`：长度 6→7，末位断言随之调整。
   - `client/server/test/gate-c/steps/requirements-board.ts:10-14,51`：注释与断言里的"六列"。
   - `client/server/test/gate-c/requirements-service-fixture.ts:41-56`：夹具补一条 `in_refinement` 数据，保证新列不是假空（该夹具刻意用分布不均的数据来暴露"单游标拉一页再前端 filter"的假空问题，新列要延续这个用意）。

#### 验收标准

- [x] 全新库跑通全部迁移；**已部署库**增量应用 003 不触发 checksum 校验失败。
- [x] 存量需求**零变档**——没有任何一条需求因为这次迁移改变了状态。
- [x] 看板显示七列，顺序为 草稿 / 梳理中 / 待开发 / 开发中 / 测试中 / 已完成 / 暂缓；`draft` 仍是新建默认值。
- [x] 有一条自动用例：在选定的基准 viewport 下，看板列容器 `scrollWidth <= clientWidth`（即七列不触发横向滚动）。若该宽度下必须滚动，则改为断言触发滚动的宽度阈值并把阈值写进用例。
- [x] 状态可以任意切进切出 `in_refinement`，**不做任何守卫**（业务规则 N1）。
- [x] gate-c 看板用例通过，`in_refinement` 列能加载出夹具那条数据。
- [x] build / typecheck / lint 通过。

#### 边界

不做状态守卫、不做权限、不做看板列折叠或排序默认值。**不动 `audit_logs_resource_type_fixed` CHECK**（那条归 pr4）。不碰产物版本相关的任何表、接口与界面。不改 `summary` 字段语义——标题描述与 PRD 解耦这条（业务规则 N6）本片不触碰。

**文件归属（同波次防踩，必须遵守）**：本片**只允许**改 `cloud/contracts/src/status.ts`、`cloud/server/migrations/003_*.sql`、`client/web/src/components/requirements-v2/requirements-board.ts`、`client/web/src/components/requirements-v2/RequirementsBoard.tsx` 与列出的三个测试文件。

**严禁触碰 `RequirementsWorkbench.tsx`** —— 同波次的 pr3 持有该文件（`:771-815` 的上传/删除调用）。该文件里还有 6 处写死的"六列"陈述（`:47`、`:49`、`:142`、`:185`、`:719`、`:753`），**不要顺手改**，已交由 pr6 在第 4 波清理。看到它们请忽略。

## 三、执行顺序 / 里程碑

- 前置依赖: 无
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-08-21 | 物化任务文档 | 无 | 等待 dispatch 派工 |
| 2026-08-22 | 实施完成，7 条验收全过 | Gate-C 看板步骤排在 assistant-approval 之后，被该步的模型网关问题挡住，取不到几何值 | 临时前移看板步骤取证后还原（不入提交）；归档 |

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
- Section: pr2-status-in-refinement
- Owner: ccb_codex
- Priority: high
- Dependencies: none

## 七、验收证据

提交 `5c36534`（分支 ccb/req-suduo-v2-pm-requirement-intake-001）。Node v24.10.0。

| # | 验收项 | 证据 |
|---|---|---|
| 1 | 迁移 | 临时库 `suduo_mig_test_fresh_*` / `suduo_mig_test_incremental_*` 分别跑全量与 001/002 增量到 003，checksum 一致；跑完 DROP。迁移 sha256 `7447e0df…29ed3`。未触碰 `suduo_requirements` |
| 2 | 存量零变档 | `statusesPreserved: true` |
| 3 | 七列且 `draft` 仍为默认 | 列序断言七项全等；web 单测 |
| 4 | 七列不触发横向滚动 | **Gate-C 真浏览器 1440×900：`clientWidth=1392` `scrollWidth=1392`**（截图 `06-requirements-board.png`） |
| 5 | 可切进切出，无守卫 | 临时库实测 `enteredAndExitedRefinement: true` + web 单测 |
| 6 | Gate-C 夹具加载新列 | `in_refinement` 列加载出夹具卡 1 张；拖拽与冲突分支同步通过（`07-board-conflict-resolved.png`） |
| 7 | build / typecheck / lint | 全绿；test 214 passed / 43 files |

**取证方式说明**：`requirementsBoardStep` 在步骤表中排第 8 位，其前的
`assistantApprovalStep`（第 2 位）因模型网关撑不住长流式 turn 而超时，
而 `runGateCSteps` 是顺序 `await`、任一步抛错整链中断——看板证据因此取不到。
看板步骤只做 `goto("/")` + 断言，不依赖任何会话状态，故**临时**将其前移到
`v2UserPathStep` 之后取证，取到后已 `git checkout` 还原，该改动不在提交内。

**遗留（非本片范围）**：`assistant-approval` 及其后的会话类断言仍被模型网关阻塞，
与既有记录 `gate_c_blocked_by_gateway` 一致，判定 outside_batch_scope。
