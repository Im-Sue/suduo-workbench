---
doc_type: dev_task
task_id: subtask-e952a904cd0a
title: PR2 · 远程读模型端点（项目 stats 与批量取需求）
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-overview-and-my-workbench-001
section_id: pr2-remote-read-model-endpoints
order: 2
implementation_owner: ccb_codex
dependencies: [subtask-421fe619b9e0]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-overview-and-my-workbench-001.json
source_draft_hash: f085302ae21d25ec6aa04855f88f18aadb68c0d1bf80e8028f3f28a645e51337
created_at: 2026-08-25T09:41:14.245Z
updated_at: 2026-08-26T02:47:05.728Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-overview-and-my-workbench-001","branch":"ccb/req-suduo-v2-overview-and-my-workbench-001"}
---

# PR2 · 远程读模型端点（项目 stats 与批量取需求）

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 新增 /v2/projects/:id/stats 三段聚合与 /v2/requirements?ids= 批量查询，以及对应契约类型。 |
| 需求来源 | suduo-v2-overview-and-my-workbench-001 |
| 本期范围 | pr2-remote-read-model-endpoints · PR2 · 远程读模型端点（项目 stats 与批量取需求） |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### PR2 · 远程读模型端点（项目 stats 与批量取需求）

#### 任务概述
概览页要的三块数据——状态分布、停滞需求榜、按天流转量——都是 SQL 天生擅长的聚合。让前端拉全量分页自己算，需求上千条后首屏一定会塌，属于确定要还的技术债，所以直接下沉到远程服务算完。

另外补一个必需的缺口：本机工作台要跨库把「我的会话关联的需求」和远程需求本体对起来，而远程**目前没有按 id 批量取需求的接口**，只能按项目分页查。这一片把它加上。

#### 任务分解

**1. `GET /v2/projects/:projectId/stats?window=7d|30d&tz=<IANA>`**，一次返回三段：

- **状态分布**：七个状态各自的数量。**没有的状态要补零**，不能让前端猜——七档是 draft / in_refinement / ready_for_development / in_development / in_testing / completed / on_hold
- **停滞榜 topN**（默认 10）：按 `now - updatedAt` 倒序。**分级阈值在服务端算完再返回**，不要把阈值下发给前端：

  | 状态 | 提示 | 警示 |
  |---|---|---|
  | `in_development` / `in_testing` | 3 天 | 7 天 |
  | `in_refinement` / `ready_for_development` | 7 天 | 14 天 |
  | `draft` | 14 天 | 30 天 |
  | `on_hold` | 30 天 | — |
  | `completed` | 不计入 | 不计入 |

  每条带：需求 id、标题、状态、停滞天数、最后操作人

- **按天流转量**：统计窗口内 `requirement.status_changed` 的每日条数。**`tz` 必须由调用方传 IANA 时区名**，服务端用 `AT TIME ZONE` 分桶——否则按 UTC 分桶会让「今天」偏 8 小时。缺 `tz` 或非法值直接 400，**不要默默回落 UTC**

**2. `GET /v2/requirements?ids=a,b,c`**：批量取需求。上限 100，超出返回 400。**缺失的 id 静默跳过，不返回 404**（可能已删或调用方无权），由调用方自己比对哪些没拿到。

**3. contracts 类型**：在 `contracts/src/requirements-v2/` 下新增 stats 相关类型，通过子路径 barrel `requirements-v2/index.ts` 导出（**消费者走这个子路径，不是根 `src/index.ts`**）。

#### 验收标准
- [ ] `window` 与 `tz` 参数校验：非法值返回 400 且信息可读；`tz` 缺失不得回落 UTC
- [ ] 七档状态补零——造一个只有 2 种状态的项目，返回里另外 5 档为 0 而不是缺键
- [ ] 停滞分级三档边界各写一个用例（含 `completed` 不计入、`on_hold` 无警示档）
- [ ] 流转量按传入时区分桶正确：跨零点造数据，验证归属日期随 tz 变化
- [ ] 批量取需求：恰好 100 通过、101 返回 400、含不存在 id 时静默跳过且其余正常返回
- [ ] 三段聚合在真实 PostgreSQL 上有集成测试，不只是单测

#### 边界
- 不做跨项目的全局 stats（需求明确本期概览只在项目内）
- 不新增「查我创建的需求」端点与 `created_by` 索引——该来源已被砍掉
- 不碰本机 BFF 与前端
- 不改既有端点

#### 依赖
- **PR1**。流转量要按项目过滤审计，依赖 `audit_logs.project_id` 已就位并回填完成
- 两片都要改 `collaboration-repository.ts`、`collaboration-service.ts`、`http/server.ts`、contracts——**必须串行，不得与 PR1 并行**

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-421fe619b9e0
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-08-25 | 物化任务文档 | 无 | 等待 dispatch 派工 |

## 五、验收标准

- [ ] 完成 `spec_section_md` 定义的实现范围。
- [ ] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [ ] 完成必要验证，并在回执中说明测试命令与结果。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## Materialization Context

- Requirement: suduo-v2-overview-and-my-workbench-001
- Section: pr2-remote-read-model-endpoints
- Owner: ccb_codex
- Priority: high
- Dependencies: subtask-421fe619b9e0
