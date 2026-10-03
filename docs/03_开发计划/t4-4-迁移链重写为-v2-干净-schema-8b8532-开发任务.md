---
doc_type: dev_task
task_id: subtask-731acb8b8532
title: T4-4 迁移链重写为 V2 干净 schema
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-requirements-workbench-001
section_id: pr4-t4-4-migration-chain-rewrite
order: 4
implementation_owner: ccb_codex
dependencies: [subtask-7a559d0d19bb]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-requirements-workbench-001.json
source_draft_hash: 845211ce45e58df0a521e1deab7621d1f26d89fc233146b4fbee2de306f7b93a
created_at: 2026-08-15T16:58:10.840Z
updated_at: 2026-08-15T18:41:02.981Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-requirements-workbench-001","branch":"ccb/req-suduo-v2-requirements-workbench-001"}
---

# T4-4 迁移链重写为 V2 干净 schema

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 把本机 SQLite 迁移链收敛为只服务 V2 的干净 schema，并清理旧凭证文件与已勾选的 .tapd.yaml。 |
| 需求来源 | suduo-v2-requirements-workbench-001 |
| 本期范围 | pr4-t4-4-migration-chain-rewrite · T4-4 迁移链重写为 V2 干净 schema |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### T4-4 迁移链重写为 V2 干净 schema

#### 任务概述
技术设计 v1.8 的 D4 定了「旧库与旧数据一律不保留，不做升级迁移」，本机 SQLite 就是可丢弃的运行态。这解除了兼容既有库的义务，于是迁移链可以**直接收敛**，不用像原方案那样整表重建 `sessions` 再逐字段搬数据，也不用额外加一层收口迁移。

因为不保留旧数据，这一片不再是「高风险不可逆」操作：没有备份恢复、没有行数一致性校验、没有确认令牌。代价已在 D4 记录——本机已配的项目目录映射和已同步的需求材料快照会清空，需要重新配置与同步。

**必须排在 T4-3 之后**：`task_id` 列一旦从 schema 消失，而代码里还有 INSERT 引用它，服务会直接起不来。

#### 任务分解
1. 迁移链收敛到目标形态：
   - `001`/`002` 保留（`projects`、`sessions`、`session_threads`、`events`、`approvals`、`idempotency_records` 都是 V2 在用）；
   - `003`～`009` 整体退出（`003` 建 `work_items` 并给 `sessions` 加 `task_id` 外键，`004`/`005` 建三张 `tapd_*` 表，`007`/`008` 只服务旧投影，`009` 的内容并入新文件）；
   - 新增 `010_v2_clean_local_state.sql`，合并 `006` 的 `sessions.purpose` 列与 `009` 的 `v2_project_workspace_mappings`、`v2_requirement_session_refs`。
2. **版本号必须用 `010`，不得复用 `003` 或 `009`**：`migration-runner.ts` 是按 version 号判断是否已应用（`applied.has(migration.version)` 命中即 `continue`），且允许非连续版本。若复用旧号，任何已记录过该版本的既有库会**静默跳过**新 SQL，落得一个既无旧表也无新表的坏库。`migration-runner.ts` 注册序列改为 `[1, 2, 10]`。
3. 旧库拒绝策略：启动时若检测到 `schema_migrations` 存在 `[1, 2, 10]` 之外的记录，**直接拒绝启动**并提示按 D4 删库重建；不要试图自动兼容或自动清理。仅在提交说明里提示是不够的——必须是运行时硬失败。
4. 更新 `client/server/test/storage.test.ts` 的迁移版本序列断言（第 31、102、143、176、239 行等硬编码期望值），使其匹配新的 `[1, 2, 10]`；本片只改迁移序列相关断言，旧模型断言已由 T4-3 处理。
5. 删除本机 `tapd-credentials.json` 文件（其配置项 `tapdCredentialsFile` 已由 T4-3 从 `main.ts` 移除）。
6. 按 T4-2 的用户逐项勾选结果处理各 `requirements/.tapd.yaml`；**未勾选的一律不动**。
7. 不提供既有库升级路径；在提交说明中写明旧库需按 D4 重建。

#### 验收标准
- 全新库跑完整迁移链成功，`appliedVersions` 为 `[1, 2, 10]`，且结果 schema 中无 `work_items`、无 `tapd_*` 三张表、无 `sessions.task_id`。
- 拿一个已跑到旧 `009` 的库启动，服务**拒绝启动**并给出「按 D4 删库重建」的明确提示，而不是静默跳过或半迁移。
- `storage.test.ts` 迁移序列断言已更新并通过。
- `sessions.purpose` 与 `009` 的两张 V2 表存在且可用。
- `PRAGMA foreign_key_check` 通过。
- 在全新库上 V2 核心链路可运行：登录、项目、需求、附件、SSE、目录映射、需求会话、项目会话。
- `tapd-credentials.json` 已删除；仅逐项勾选过的 `.tapd.yaml` 被处理，其余原样保留。
- build / typecheck / lint 通过。

#### 边界
不提供既有库升级迁移（D4）；不触碰用户源码（已勾选的 `.tapd.yaml` 除外）；不触碰 Codex 配置。

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-7a559d0d19bb
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-08-15 | 物化任务文档 | 无 | 等待 dispatch 派工 |
| 2026-08-15 | 派工 ccb_codex（job_7901690ab6f5），迁移链收敛为 `[1,2,10]`、实现旧库拒绝启动、修复迁移断言，提交 `ca7c87a` | 无 | 进入 review |
| 2026-08-15 | Review 一次通过：全新库独立复验、测试 18/18 全绿复跑、旧库拒绝逻辑逐行核对、本机库未被触碰确认 | 无 | 归档 |

## 五、验收标准

- [x] 完成 `spec_section_md` 定义的实现范围。
- [x] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [x] 完成必要验证，并在回执中说明测试命令与结果。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## 七、归档记录（2026-08-15）

**交付物**（提交 `ca7c87a`）：删除迁移 `003`–`008`；`009_v2_requirements_local_state.sql` 收敛为 `010_v2_clean_local_state.sql`（git 识别为重命名 + 新增 `purpose`）；改写 `migration-runner.ts` 与 `storage.test.ts`。提交说明已注明「D4 旧库需删库重建」。

**Claude 独立复验证据**：

| 核验项 | 方法 | 结果 |
|---|---|---|
| 迁移链形态 | `ls migrations/` | 仅剩 `001` / `002` / `010`，003–009 全部退出 |
| 版本号未复用 | 读 `migration-runner.ts` 注册项 | version 1、2、10，未复用 `003`/`009` |
| 全新库结果 | 独立脚本建空库跑完整链（`node:sqlite`） | `appliedVersions=[1,2,10]`；禁止表残留 `[]`；`sessions.task_id` 不存在；`sessions.purpose` 存在；两张 V2 表存在；`PRAGMA foreign_key_check` PASS |
| 最终表清单 | 对比旧库 | 相比旧库正好少了 `work_items` 与 `tapd_items`/`tapd_sync_state`/`tapd_action_records` 四张表，其余不变 |
| 旧库拒绝正确性 | 逐行读 `migration-runner.ts:65-71` | 用 `!V2_MIGRATION_VERSIONS.has(version)` 过滤（非硬编码特定版本，任何非 {1,2,10} 均拒）；`throw` 位于迁移循环**之前**，应用任何新 SQL 前即失败 |
| 回归测试真实性 | 读 `storage.test.ts:72-74` | 新增 `expect(() => runMigrations(database)).toThrow("检测到旧数据库迁移版本 [9]；按 D4 删除本机数据库后重建。")`，是行为测试而非仅改断言 |
| 测试全绿 | 独立复跑 `pnpm --filter @suduo/client-server run test` | **18/18 文件、78/78 用例通过**；T4-3 遗留的 pre-existing failure 已修复（77→78 且由 1 failed 转全过） |
| TAPD 残留 | 源码全量扫描 | **从 T4-3 后的 12 处清零至 0** |
| 三件套 | build / typecheck / lint | 全部通过 |
| 本机库未被触碰 | 文件时间戳 + 版本读取 | 时间戳仍为执行前的 12:11，版本仍 `1..9`；执行方遵守了「不删本机库」禁令 |
| 边界 | diff `cloud/server`、`client/web/src/app` | 空输出 |

**`010_v2_clean_local_state.sql` 内容**：合并原 `006` 的 `sessions.purpose` 列（含 CHECK 约束）与原 `009` 的 `v2_project_workspace_mappings`、`v2_requirement_session_refs` 两表及其两个索引。因新链自 `001`/`002` 起建库，天然不含 work-items、TAPD 表与 `sessions.task_id`，无需额外删除动作。

**旧库拒绝**：实现于 `client/server/src/infrastructure/db/migration-runner.ts`，读取 `schema_migrations` 之后、执行任何迁移之前。错误信息原文：`检测到旧数据库迁移版本 [x]；按 D4 删除本机数据库后重建。`

**两项条件目标的实际处置**：
- `.tapd.yaml`：**零实例，无待办**（依据 T4-2 扫描结论）。未扫描其他目录，未改任何用户文件。
- `tapd-credentials.json`：存在性检查结果 `NOT_EXISTS`，如实记录，**未伪造为已删除**。

**用户须知的操作影响**：本片合入后，任何记录过 `003`–`009` 的本机库启动时将硬失败。用户当前本机库 `/home/sue/.local/share/suduo/suduo.sqlite` 正是此类（版本 `1..9`），需按 D4 删除后重建。经 T4-2 核查，该库 `projects`/`sessions`/`work_items` 均为 0 行，删除无数据损失；D4 所述「映射重配、材料重同步」代价实际为零。删库动作属用户决定，本片按边界未执行。

**残留风险**：
- 未进行真实服务登录与 V2 端到端人工回归（需完整环境），顺延 T5-3。
- 提交 message 带 `unverified` 标记，成因与处置同 T4-2 归档记录。

**后续事项**：T4 全部四片已完成，旧线清理闭环。T5-2 可基于本片的迁移链最终形态编写本机侧配置与回滚说明。无未闭环待用户拍板项。

## Materialization Context

- Requirement: suduo-v2-requirements-workbench-001
- Section: pr4-t4-4-migration-chain-rewrite
- Owner: ccb_codex
- Priority: high
- Dependencies: subtask-7a559d0d19bb
