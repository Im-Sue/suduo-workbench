---
doc_type: dev_task
task_id: subtask-476319d0215d
title: T4-2 精确清理清单与 .tapd.yaml 逐项确认
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-requirements-workbench-001
section_id: pr2-t4-2-cleanup-manifest-and-user-confirm
order: 2
implementation_owner: ccb_codex
dependencies: []
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-requirements-workbench-001.json
source_draft_hash: 845211ce45e58df0a521e1deab7621d1f26d89fc233146b4fbee2de306f7b93a
created_at: 2026-08-15T16:58:10.840Z
updated_at: 2026-08-15T17:38:33.846Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-requirements-workbench-001","branch":"ccb/req-suduo-v2-requirements-workbench-001"}
---

# T4-2 精确清理清单与 .tapd.yaml 逐项确认

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 逐项点名清理目标与保留目标，并就用户项目目录内的 .tapd.yaml 取得逐项确认；本片不删任何东西。 |
| 需求来源 | suduo-v2-requirements-workbench-001 |
| 本期范围 | pr2-t4-2-cleanup-manifest-and-user-confirm · T4-2 精确清理清单与 .tapd.yaml 逐项确认 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### T4-2 精确清理清单与 `.tapd.yaml` 逐项确认

#### 任务概述
T4 验收要求「清理目标与保留范围有记录且经确认」。本片产出一份可以逐条核对的清单，供 T4-3、T4-4 照着执行。**任何无法精确解析到具体文件/路由/表/列的目标，一律不进清单。**

这份清单的另一半价值是**点名保留项**。草案上一版就差点把 `requirement-briefing.ts` 当旧线删掉，而它其实是 V2 需求会话的简报模块，`session-service.ts:174` 和 `message-service.ts:92` 都在调用——删了 V2 就断。保留清单和删除清单一样重要。

按技术设计 v1.8 的 D4，旧库与旧数据不保留、不做升级迁移，因此本片**不含**数据备份方案、恢复演练、确认令牌和清单哈希——这些门在 D4 之后已没有对象。唯一保留的用户确认门是 `.tapd.yaml`，因为它在用户自己的项目仓库里，属于用户源码，误删不可逆且影响外溢。

#### 任务分解
1. 逐项点名删除目标（禁止通配符、禁止按目录批量）：
   - 服务端：`application/tapd-{action,project-config,settings,sync}-service.ts`、`infrastructure/tapd/{tapd-client,tapd-config,tapd-credential-store}.ts`；
   - 仓储：`tapd-action-repository.ts`、`tapd-projection-repository.ts`、`work-item-repository.ts`；
   - 服务：`work-item-service.ts`、`work-item-briefing.ts`；
   - 路由：`/api/v1/tapd/*`、`/api/v1/projects/:id/tapd/*`、`/api/v1/projects/:id/work-items`；
   - 契约：`client/contracts/src/work-items.ts`、`index.ts` 第 7 行的 `export * from "./work-items.js"` re-export，以及 `api.ts` 中**整段** WorkItem/TAPD DTO 定义（该文件 `WorkItem`/`Tapd` 标识共约 87 处，从第 9–10 行的类型 import 到第 84 行起的 DTO 块，不止 import、`ErrorCode` 和四处 `taskId`）；
   - 前端：`app/SuDuoApp.tsx`、`TapdClaimDialog`、`TapdConfigDialog`、`TapdSubmitValidationDialog`、`tapd-rich-text.ts`，以及 `LeftRail`/`RequirementBoard`/`RequirementDetails`/`SettingsPanel` 中的 TAPD/work-item 区块、`api/client.ts` 旧方法、`dev/UIKitWave2/3/4` 相关用例；
   - HTTP 层：`client/server/src/infrastructure/http/http-server.ts` 中的旧模型依赖类型、查询参数与 TAPD helper（该文件相关标识约 91 处，含第 22–24 行类型 import 与 `tapdImageProxyError` 等 helper）；
   - 服务入口：`client/server/src/main.ts` 第 95 行的 `tapdCredentialsFile`；
   - 样式：`client/web/src/styles.css` 第 1511 行起的 TAPD 样式块（该文件 `tapd` 出现约 39 处）；
   - 脚本与配置：`scripts/tapd-bootstrap.ts`、根 `package.json` 的 `tapd:bootstrap`、根 `.env.example` 的 `TAPD_*`；
   - 本机文件：`tapd-credentials.json`。
2. 逐项点名**保留目标**，至少含：`application/requirement-briefing.ts`（V2 需求会话简报）、`/api/v1` 的 sessions/approvals/files/settings/skills、`006` 引入的 `sessions.purpose`、`009` 的 `v2_project_workspace_mappings` 与 `v2_requirement_session_refs`。
3. 测试清单区分**删除**与**修改**两类，分别列出文件名，并标注每一项归属 T4-3 还是 T4-4：
   - 删除：纯 TAPD/work-item 测试（归 T4-3）；
   - 修改（归 T4-3）：`http.test`、`client/contracts/test/contracts.test.ts`、`client/web/test/session-status.test.ts`（第 11、26 行两处 `taskId: null` 随 DTO 调整）、`client/server/test/storage.test.ts` 中的旧模型断言；
   - 修改（归 **T4-4**）：`client/server/test/storage.test.ts` 中的迁移版本序列断言（第 31、102、143、176、239 行等硬编码 `[1,2,3,4,5,6,7,8]` 一类期望值）——它们随迁移链收敛而变，不属于代码清理片。
   清单须给出「删 N 个 / 改 M 个」的确切数字与文件名，不得用「14 项（含三者）」这类混淆写法。
4. 扫描并**逐个实例列出**用户项目目录内 `requirements/.tapd.yaml` 的绝对路径，标注所属项目，供用户逐项勾选；未勾选的一律不动。

#### 验收标准
- 清单无通配符，每项可直接定位到具体文件、路由、表或列。
- 清单已覆盖易漏点：`contracts/index.ts` re-export、`api.ts` 整段 DTO、`http-server.ts`、`main.ts` 的 `tapdCredentialsFile`、`styles.css` 样式块。
- 每个测试项均已标注归属 T4-3 或 T4-4。
- 保留清单已列出且明确包含 `requirement-briefing.ts`。
- 测试清单区分删除与修改，数字与文件名一一对应且可核对。
- `.tapd.yaml` 实例已逐项列出绝对路径，并已取得用户逐项勾选结果。
- 仓库代码与数据零改动。

#### 边界
只出清单和确认结果，不执行任何删除，不改任何代码。

## 三、执行顺序 / 里程碑

- 前置依赖: 无
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-08-15 | 物化任务文档 | 无 | 等待 dispatch 派工 |
| 2026-08-15 | 派工 ccb_codex（job_ec4719ee812a），产出 `docs/03_开发计划/t4-旧线清理清单.md`（提交 `a6a391c`） | `.tapd.yaml` 扫描结果为零实例 | 进入 review |
| 2026-08-15 | Review 判定返工（job_8207cee6db89）：修正两处 styles.css 行号越界，并为全部行号项补语义锚点（提交 `26c348c`） | 清单原用绝对行号，执行中会漂移 | 复验通过，归档 |

## 五、验收标准

- [x] 完成 `spec_section_md` 定义的实现范围。
- [x] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [x] 完成必要验证，并在回执中说明测试命令与结果。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## 七、归档记录（2026-08-15）

**交付物**：`docs/03_开发计划/t4-旧线清理清单.md`（worktree 分支 `ccb/req-suduo-v2-requirements-workbench-001`，提交 `a6a391c` → `26c348c`）。删除项 73、保留项 11、测试删 14 改 4（5 条互不重叠修改责任）。

**Claude 独立复验证据**（不依赖执行方自述）：

| 核验项 | 方法 | 结果 |
|---|---|---|
| 路由完整性 | 从 `http-server.ts` 独立提取 tapd/work-item 路由字面量比对 | 14 个唯一路径 / 18 条方法级路由，与清单零差异 |
| 测试清单 | 逐个 `test -f` + 反向 `ls` 查多余 | 14 个全部存在，无遗漏无多余 |
| 三张 tapd 表名 | `node:sqlite` 读实际 schema | `tapd_items`/`tapd_sync_state`/`tapd_action_records`，清单点名精确 |
| 保留项 | `requirement-briefing.ts` 存在性 + 调用点 | 在位，`session-service.ts:174`/`message-service.ts:92` |
| 行号边界 | 逐条 `sed`/`awk` 核对上下文 | 发现 2 处越界（已返工修正），其余 6 类全部正确 |
| `.tapd.yaml` 扫描源 | `node:sqlite` 带 WAL 读 `projects` 表 | 0 行，结论成立 |

**Review 发现并已修正**：① `styles.css` 两处范围终点落在 `@media` 内部（650–771→649–774；1511–1558→1511–1559），机械执行会留孤儿代码；② 全部行号项缺语义锚点——T4-3 在同一文件删多处时行号必然漂移，已改为「语义锚点定位、行号仅交叉验证」，补 8 条目 21 个锚点。

**关键结论（影响后续子任务）**：`.tapd.yaml` **零实例**。依据：`/home/sue/.local/share/suduo/suduo.sqlite` 的 `projects` 表 0 行，无目录可拼接扫描路径。故技术设计 D3 的用户逐项确认门**在本项目实际数据上无对象**，T4-4 第 6 条随之无待办。同库 `sessions`/`work_items` 亦为 0 行，D4 所述「映射重配、材料重同步」代价实际为零。

**残留风险**：
- 扫描口径限定为 `projects` 表已登记目录（防全盘扫描）。若存在手动 `pnpm tapd:bootstrap` 生成、从未登记的 `.tapd.yaml`，本次未覆盖；安全默认为不动，无误删风险。
- `tapd-credentials.json` 当前不存在，清单记为存在性检查项而非删除项，T4-4 执行时需重新检查该路径。
- 两次提交的 message 带 `unverified` 标记：执行契约据 dev_task spec 是否含 fenced 验证块静态判定，本片为纯文档交付且验证已在 dispatch brief 中给出并执行，另经上述独立复验，不构成实际未验证。

**后续事项**：清单已就绪，可直接作为 T4-3、T4-4 的执行输入，无未闭环待用户拍板项。

## Materialization Context

- Requirement: suduo-v2-requirements-workbench-001
- Section: pr2-t4-2-cleanup-manifest-and-user-confirm
- Owner: ccb_codex
- Priority: high
- Dependencies: none
