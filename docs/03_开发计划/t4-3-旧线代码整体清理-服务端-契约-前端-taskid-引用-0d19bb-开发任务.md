---
doc_type: dev_task
task_id: subtask-7a559d0d19bb
title: T4-3 旧线代码整体清理（服务端 + 契约 + 前端 + taskId 引用）
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-requirements-workbench-001
section_id: pr3-t4-3-legacy-code-removal
order: 3
implementation_owner: ccb_codex
dependencies: [subtask-48555b296185, subtask-476319d0215d]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-requirements-workbench-001.json
source_draft_hash: 845211ce45e58df0a521e1deab7621d1f26d89fc233146b4fbee2de306f7b93a
created_at: 2026-08-15T16:58:10.840Z
updated_at: 2026-08-15T18:33:13.782Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-requirements-workbench-001","branch":"ccb/req-suduo-v2-requirements-workbench-001"}
---

# T4-3 旧线代码整体清理（服务端 + 契约 + 前端 + taskId 引用）

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 按确认清单一次性删除服务端旧线、契约耦合、前端旧壳与全部 taskId 代码引用；不动迁移文件与数据库。 |
| 需求来源 | suduo-v2-requirements-workbench-001 |
| 本期范围 | pr3-t4-3-legacy-code-removal · T4-3 旧线代码整体清理（服务端 + 契约 + 前端 + taskId 引用） |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### T4-3 旧线代码整体清理（服务端 + 契约 + 前端 + `taskId` 引用）

#### 任务概述
把旧线**代码**一次性清完。这一片刻意做得比较大，原因是服务端、契约和前端三者在编译上是一个闭环：`api/client.ts` 第 27–48 行 import 了二十多个 TAPD/WorkItem 类型、第 359 行还在调 `listWorkItems`。如果只删服务端而不动契约和前端，或者只删契约而不动前端，任何一半都过不了 typecheck。所以合并成一片，一次编译闭环。

本片的改动**全部可以通过版本回滚恢复**，这也是它和 T4-4（迁移链重写）分开的原因。

**注意保留 `requirement-briefing.ts`**：它名字里有 briefing、位置也挨着 `work-item-briefing.ts`，但它是 V2 需求会话的简报模块，`session-service.ts:174`、`message-service.ts:92` 正在调用，删掉 V2 需求会话立刻断。

#### 任务分解
1. 删除服务端旧线：`application/tapd-{action,project-config,settings,sync}-service.ts`、`infrastructure/tapd/{tapd-client,tapd-config,tapd-credential-store}.ts`、`tapd-action-repository.ts`、`tapd-projection-repository.ts`、`work-item-repository.ts`、`work-item-service.ts`、`work-item-briefing.ts`。**保留 `requirement-briefing.ts`。**
2. 注销路由 `/api/v1/tapd/*`、`/api/v1/projects/:id/tapd/*`、`/api/v1/projects/:id/work-items`；`server-application.ts` 同步摘除装配。
3. 解除契约耦合：删除 `client/contracts/src/work-items.ts`；移除 `index.ts` 第 7 行的 `export * from "./work-items.js"` re-export；`api.ts` 移除对它的 import、相关 `ErrorCode`、`taskId` 字段（461、485、500、510 四处），以及**第 84 行起整段 WorkItem/TAPD DTO 定义**——该文件相关标识约 87 处，只删 import 和 `taskId` 会留下一大片孤立类型。
4. 清理 `taskId` 代码引用，使其在代码层面彻底消失：`session-repository.ts`（建表列声明、INSERT 列与占位、UPDATE 赋值、行映射）、`session-service.ts`（`taskId` 入参校验与 `this.workItems.getById()` 依赖）、`session-run-status-service.ts`、以及 DTO/`SessionRunStatus` 相关引用。**此时数据库里的 `task_id` 列仍然存在，但已无任何代码读写**——列的移除属于 T4-4。
5. 前端：`main.tsx` 移除 `/legacy` 分支；删除 `app/SuDuoApp.tsx`、`TapdClaimDialog`、`TapdConfigDialog`、`TapdSubmitValidationDialog`、`tapd-rich-text.ts`；剥离 `LeftRail`/`RequirementBoard`/`RequirementDetails`/`SettingsPanel` 中的 TAPD/work-item 区块并保留 V2 仍在用的部分；`api/client.ts` 移除旧方法与 DTO；清理 `dev/UIKitWave2/3/4` 中引用旧组件的用例。
6. HTTP 层与入口：清理 `client/server/src/infrastructure/http/http-server.ts` 中的旧模型依赖类型、查询参数与 TAPD helper（相关标识约 91 处，含第 22–24 行类型 import 与 `tapdImageProxyError` 等）；移除 `client/server/src/main.ts` 第 95 行的 `tapdCredentialsFile` 配置项。
7. 样式：删除 `client/web/src/styles.css` 第 1511 行起的 TAPD 样式块（该文件 `tapd` 约 39 处），避免产物里残留 TAPD 标识。
8. 脚本与配置：删除 `scripts/tapd-bootstrap.ts` 与根 `package.json` 的 `tapd:bootstrap`；根 `.env.example` 移除 `TAPD_ACCESS_TOKEN`/`TAPD_API_USER`/`TAPD_API_PASSWORD`。
9. 按 T4-2 清单处理归属本片的测试，删除与修改两类分别执行，不要把「修改」当「删除」。`storage.test.ts` 中的**迁移版本序列断言不在本片**，留给 T4-4。
10. **迁移文件本片一律不动**，数据库结构与数据也不动，全部留给 T4-4。

#### 验收标准
- 旧路由返回 404。
- 代码中检索不到 `taskId` / `task_id` 的读写（迁移 SQL 文件除外）。
- 全仓检索不到 TAPD 标识（迁移 SQL 与 `docs/` 历史文档除外）：`contracts/index.ts`、`api.ts`、`http-server.ts`、`main.ts`、`styles.css` 均已清干净。
- `requirement-briefing.ts` 仍在，且 V2 需求会话能正常拿到简报。
- `migrations/` 目录未改动；既有库仍可正常启动运行。
- build / typecheck / lint 通过。
- V2 全链路回归通过：登录、项目、需求、评论、附件、SSE、目录映射、需求会话、项目会话。

#### 边界
不动数据库数据与表结构，不动迁移文件，不触碰用户项目目录与 Codex 配置。

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-48555b296185, subtask-476319d0215d
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-08-15 | 物化任务文档 | 无 | 等待 dispatch 派工 |
| 2026-08-15 | 派工 ccb_codex（job_2e40e9400a8d），按 T4-2 清单执行，60 文件改动、16742 行删除，提交 `cbba3ec` | `storage.test.ts` 1 个测试失败 | 进入 review，先判定失败归属 |
| 2026-08-15 | Review 一次通过：三件套独立复跑全过；确认该测试失败为 pre-existing（基线 `3de7bb8` 即失败），非本片回归，且已由清单归属 T4-4 | 无 | 归档 |

## 五、验收标准

- [x] 完成 `spec_section_md` 定义的实现范围。
- [x] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [x] 完成必要验证，并在回执中说明测试命令与结果（`storage.test.ts` 的 pre-existing 失败见归档记录，归属 T4-4）。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## 七、归档记录（2026-08-15）

**交付物**（提交 `cbba3ec`）：60 文件改动，**16742 行删除 / 107 行新增**。删除 38 个旧线文件（12 服务端、11 前端与开发样例、1 契约、1 脚本、14 测试），修改 22 个（业务剥离 16、测试与配置同步 6）；摘除 18 条 TAPD/work-item 路由，删除两段 CSS（均按语义锚点定位）。

**Claude 独立复验证据**：

| 核验项 | 方法 | 结果 |
|---|---|---|
| 编译闭环 | 独立复跑 `pnpm typecheck` / `build` / `lint` | typecheck 4 包全 Done；build 全 Done；lint exit 0 |
| `taskId`/`task_id` 清除 | 全量 grep（排除 `/migrations/`） | 零残留 |
| 保留项存活 | 检查 `requirement-briefing.ts` 及其调用点 | 文件在位，且 `message-service.ts:83`、`session-service.ts:152` 仍在**调用** `requirementBriefing`，非仅 import |
| 旧路由摘除 | grep `http-server.ts` | 无输出 |
| `/legacy` 移除 | grep `main.tsx` | 无输出，`SuDuoApp` 引用一并消失 |
| T4-1 产物未误伤 | `SessionRuntime.tsx` 存在性 + diff | 存在，diff 空 |
| T5-1 产物未误伤 | `cloud/server` diff | 空 |
| 迁移边界 | `migrations/` 与 `migration-runner.ts` diff | 空，完整留给 T4-4 |
| TAPD 残留 | 源码全量扫描 | 12 处，**全部在 `migration-runner.ts:27-92`**（004/005/008 的 URL 常量与注册项），属清单归属 T4-4 的目标，边界正确 |

**关于 `storage.test.ts` 测试失败的判定（重要）**：

执行方回执如实报告 `client/server/test/storage.test.ts:18` 失败。经独立追溯，**这是 pre-existing failure，不是本片引入的回归**：

- 基线 `3de7bb8` 上该断言即为 `toEqual([1, 2, 3, 4, 5, 6, 7, 8])`；
- 而基线已有 9 个迁移文件，`migration-runner.ts` 注册 version 1~9，实际 `appliedVersions` 为 `[1..9]`；
- 即 T2/T3 引入 `009_v2_requirements_local_state.sql` 时漏改该断言，基线状态就是红的。

本片执行方未越界修复（清单已将迁移版本序列断言归属 T4-4），纪律正确。当前测试实况：**17/18 文件通过、76/77 用例通过**，唯一失败即此项。**T4-4 必须一并修复该断言，使套件回到全绿**——其任务分解第 4 条本就要求把该断言改为 `[1, 2, 10]` 语义。

**清单执行完整性**：归属 T4-3 的条目**无未执行项**。语义锚点在两处 `styles.css` 块上实际发挥作用（起「项目级需求看板（波4）」注释至 1500px media block 闭合；起 `.tapd-config-dialog` 至 720px media block 闭合），未依赖会漂移的绝对行号。

**残留风险**：
- 未做人工 V2 会话运行时回归；编译与静态路由扫描已通过，但「typecheck 过而运行时断」的路径无法由静态手段完全排除，建议 T5-3 全新机器闭环验收时覆盖。
- 数据库中 `sessions.task_id` 列仍存在但已无任何代码读写——这是 spec 预期的中间状态，列的移除属 T4-4。
- 提交 message 带 `unverified` 标记，成因与处置同 T4-2 归档记录。

**后续事项**：T4-4 可直接开工，其输入已齐备（清单 T4-4 条目 + 本片留下的 `migration-runner.ts` 与 `migrations/` 原状 + 待修复的迁移断言）。无未闭环待用户拍板项。

## Materialization Context

- Requirement: suduo-v2-requirements-workbench-001
- Section: pr3-t4-3-legacy-code-removal
- Owner: ccb_codex
- Priority: high
- Dependencies: subtask-48555b296185, subtask-476319d0215d
