---
doc_type: dev_task
task_id: subtask-8bc1f51bdfa3
title: PR8 · 默认落地页切换与交付闸门
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-overview-and-my-workbench-001
section_id: pr8-default-landing-and-delivery-gate
order: 8
implementation_owner: ccb_codex
dependencies: [subtask-ccadb260fea9, subtask-a6ed55d5509a]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-overview-and-my-workbench-001.json
source_draft_hash: f085302ae21d25ec6aa04855f88f18aadb68c0d1bf80e8028f3f28a645e51337
created_at: 2026-08-25T09:41:14.245Z
updated_at: 2026-08-26T07:45:49.568Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-overview-and-my-workbench-001","branch":"ccb/req-suduo-v2-overview-and-my-workbench-001"}
---

# PR8 · 默认落地页切换与交付闸门

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 把 / 切到工作台、看板迁 /requirements，保留旧深链语义，并以需求追踪矩阵逐条核对交付完整性。 |
| 需求来源 | suduo-v2-overview-and-my-workbench-001 |
| 本期范围 | pr8-default-landing-and-delivery-gate · PR8 · 默认落地页切换与交付闸门 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### PR8 · 默认落地页切换与交付闸门

#### 任务概述
两件事，都必须等前面全部完成才能做。

第一件是**切默认入口**：`/` 从需求看板改成我的工作台。放在最后是因为，只要工作台还没真正可用，把用户默认扔进去就是净损失。

第二件是**交付闸门**。本项目刚发生过一次事故：`suduo-v2-workbench-ui-refit-001` 拆了 14 片、片片全绿，归档前才发现三项需求原文要求的能力压根没交付——每一片都合法地把它记进「交接项」，然后链条末端没人接。**片片验收通过 ≠ 需求交付完整**，这是批次拆分的结构性盲区。这一片就是专门堵它的。

#### 任务分解

**1. 切换默认落地页与看板路径**（本片第二次、也是最后一次改 `RequirementsV2App.tsx`）：
- `pathOf("requirements")` 由 `/` 改为 `/requirements`
- `routeOf` 的兜底分支由「需求看板」改为「我的工作台」
- `/requirements` 新增为看板路径

**必须原样保留的语义**：
- `/?sessionId=xxx` → 会话页。这条既有分支是老链接进会话的入口，切默认路由时**最容易被顺手删掉**
- `/requirements/:id` 详情路由语义不变
- `/sessions`、`/settings` 不变

**2. 需求追踪矩阵** — 逐条列出需求文档的功能条款与业务规则，每条给出**它由哪一片交付、证据在哪**（测试用例名、页面路径或代码位置）。

  必须覆盖到条款级，至少包括：4.1.1–4.1.4 概览四区块、4.2.1–4.2.3 工作台三区块、4.3 导航与路由、R1–R11 十一条业务规则。

  **不接受「已完成」「已核对」这类无法证伪的结论**——每条要么有具体证据，要么明确写「未交付 + 原因 + 归属」。上次事故就是败在笼统结论上。

**3. 端到端验收**（需求关键路径实测，不是只跑单测）：
- `/` → 工作台、`/requirements` → 看板、`/requirements/:id` → 详情、`/?sessionId=` → 会话页
- 概览四区块的点击穿透：漏斗条 → 看板筛选、停滞榜 → 需求详情
- 工作台待我处理 → 会话审批现场
- 材料过期从发现到点进需求详情的完整路径
- 远程不可达时工作台的降级表现

#### 验收标准
- [ ] 四条路由语义全部实测通过，**`/?sessionId=` 必须仍进会话页**
- [ ] 需求追踪矩阵完成，每条功能条款与业务规则都有交付归属与可验证证据
- [ ] 矩阵中若有未交付项，已显式列出原因与后续归属，**不许静默略过**
- [ ] 端到端验收清单逐条实测并留下证据
- [ ] 全仓 typecheck、lint、测试通过

#### 边界
- **不新增功能**。发现缺口时先报告，由用户决定补做还是记账，不要自己顺手实现
- 不改需求看板与会话运行时的既有交互
- 不做部署发行相关内容（属主线需求 T5-3）

#### 依赖
- **PR6 与 PR7 都完成**。默认入口和交付矩阵都要求两个页面已真正可用

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-ccadb260fea9, subtask-a6ed55d5509a
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

## 七、需求追踪矩阵

> 证据路径均相对仓库根。`Gate C` 是浏览器端到端证据；其执行状态单列记录，不能用单元测试替代。

| 需求条款 | 交付归属 | 实现位置 | 可定位证据 | 交付状态 |
|---|---|---|---|---|
| 4.1.1 状态漏斗条 | PR2 / PR4 / PR6 | `project-stats` 远程读模型、`OverviewStatusFunnel.tsx` | `project-stats.test.ts` 状态补零；`overview-mode.test.tsx`「在 DOM 中渲染 12 种审计 action、状态流转和可访问图形」断言漏斗与状态筛选穿透；Gate C `overview-workbench` | 已实现；Gate C 待环境复验 |
| 4.1.2 停滞需求榜 | PR2 / PR4 / PR6 | `project-stats`、`OverviewStaleRequirements.tsx` | `project-stats.test.ts` 分级阈值与时区；`overview-mode.test.tsx` 断言停滞榜点击进入详情；Gate C `overview-workbench` | 已实现；Gate C 待环境复验 |
| 4.1.3 最近动态时间线 | PR1 / PR2 / PR4 / PR6 | `audit_logs.project_id`、`OverviewTimeline.tsx` | `migration-runner.test.ts`「回填五种历史审计记录」；`audit-project-id.test.ts`「九个写入调用点」；`overview-timeline.test.ts` 与 `overview-mode.test.tsx` | 已实现；Gate C 待环境复验 |
| 4.1.4 流转量迷你图 | PR2 / PR4 / PR6 | stats transitions、`OverviewTransitionChart.tsx` | `project-stats.test.ts` 时区/DST 流转聚合；`overview-mode.test.tsx` 断言 7 天/30 天切换 | 已实现；Gate C 待环境复验 |
| 4.2.1 待我处理 | PR3 / PR4 / PR7 | `my-workbench-service.ts`、`MyWorkbenchMode.tsx` | `my-workbench-service.test.ts`「按最旧快照…按待审批、失败、映射失效排序」；`my-workbench-mode.test.tsx` 三类跳转；Gate C `overview-workbench` 创建真实待审批后从工作台跳回审批卡 | 已实现；Gate C 待环境复验 |
| 4.2.2 我在做的需求与材料过期 | PR2 / PR3 / PR4 / PR7 | 批量需求接口、`MyWorkbenchService.buildRequirements`、`MyWorkbenchMode.tsx` | `my-workbench-data.test.ts` 批量请求；`my-workbench-service.test.ts` 最旧快照/分块降级；`my-workbench-mode.test.tsx` 漂移、仅版本变化、快照不可读；Gate C 冻结快照后修改远程标题 | 已实现；Gate C 待环境复验 |
| 4.2.3 我的会话 | PR3 / PR4 / PR7 | `SessionRepository.listActiveByLastActivity`、`MyWorkbenchMode.tsx` | `my-workbench-data.test.ts`「跨项目 ref 全量读取与活跃会话时间排序正确」；`my-workbench-mode.test.tsx` 会话倒序及点击 | 已实现；Gate C 待环境复验 |
| 4.3 导航与路由 | PR5 / PR8 | `AppNav.tsx`、`RequirementsV2App.tsx` | `requirements-routes.test.ts` 根路径、`/?sessionId=`、`/requirements` 与详情路径；Gate C `overview-workbench` 四条真实路由 | 已实现；Gate C 待环境复验 |
| R1 只用真实数据口径 | PR2 / PR6 | `stats.ts` / `project-stats`、概览四组件 | `ProjectStatsResponse` 仅状态分布/停滞/流转；`project-stats.test.ts` 覆盖三段数据，无截止/工时类字段或指标 | 已实现 |
| R2 停滞阈值分级 | PR2 | `collaboration-repository.ts` 的 stats 查询 | `project-stats.test.ts` 分别覆盖流水线、草稿、暂缓、完成排除及 topN | 已实现 |
| R3 以 `updatedAt` 判定停滞 | PR2 | stats 停滞查询 | `project-stats.test.ts` 使用需求更新时间构造停滞；`OverviewStaleRequirements.tsx` 文案为“最后更新” | 已实现 |
| R4 内容比对而非 version | PR3 / PR4 / PR7 | `my-workbench-service.ts#hasContentDrift` | `my-workbench-service.test.ts` 最旧快照；`my-workbench-mode.test.tsx` 断言仅版本变化不提示；Gate C 冻结快照后改标题 | 已实现；Gate C 待环境复验 |
| R5 待办优先级 | PR4 / PR7 | `actionPriority`、`sortWorkbenchActions` | `my-workbench-service.test.ts` 与 `my-workbench-mode.test.tsx` 均断言待审批 > 失败 > 映射 | 已实现 |
| R6 只计活跃会话且同需求去重 | PR3 / PR4 | `SessionRepository.listActiveByLastActivity`、`MyWorkbenchService` 分组 | `my-workbench-data.test.ts` 活跃跨项目读取；`my-workbench-service.test.ts` 分组与展示模型 | 已实现 |
| R7 概览随项目、工作台跨项目 | PR5 / PR6 / PR7 | `OverviewMode(projectId)`、`MyWorkbenchMode` 无项目入参 | `overview-mode.test.tsx` 项目切换重载；`my-workbench-mode.test.tsx`「项目切换不重新拉取或改变跨项目工作台内容」 | 已实现 |
| R8 浏览器仅经 BFF | PR3 / PR4 / PR5 | `client/web/src/api/client.ts` 的 `/api/v2/*`；BFF remote client | `api-client.test.ts`、`http.test.ts`「工作台路由恒 200，stats 的 tz 与 audit 的 projectId 均原样透传」 | 已实现 |
| R9 有意义空态 | PR6 / PR7 | 概览四组件、`MyWorkbenchMode.tsx` | `overview-mode.test.tsx` 零需求/无停滞；`my-workbench-mode.test.tsx` 待办与本机会话空态文案 | 已实现 |
| R10 分块降级 | PR4 / PR7 | `WorkbenchSection` envelope、`MyWorkbenchMode.tsx` | `my-workbench-service.test.ts`「远程失败只让“我在做”降级」；`my-workbench-mode.test.tsx` 独立错误/重试；Gate C 远程故障开关 | 已实现；Gate C 待环境复验 |
| R11 可见性感知轮询 | PR7 | `workbench-polling.ts`、`MyWorkbenchMode.tsx` effect cleanup | `workbench-polling.test.ts` fake timer；`my-workbench-mode.test.tsx` 隐藏/恢复、手动刷新、真实 unmount 后 `vi.getTimerCount() === 0` | 已实现 |

### 未交付项与验收缺口

- 产品功能条款未交付：**0 项**。
- 验收缺口：**1 项**——`pnpm gate:c` 的浏览器端到端步骤未跑完。

**精确诊断（2026-08-26 coordinator 实跑三轮后更新，取代此前「Node 版本 + ABI 死锁」的粗略归因）**：

环境阻塞已逐层排除，`doctor` 现已 **overall PASS**（24 项检查，仅 3 个 npm 全局安装路径的无害 warn）：

| # | 卡点 | 处理 | 状态 |
|---|---|---|---|
| 1 | Node 版本（doctor 要求 >=24.10，PATH 默认 v22.20.0） | 改用 nvm `v24.10.0`（与用户常驻 SuDuo 服务同版本） | 已解 |
| 2 | 缺 `SUDUO_CODEX_HOME` | 从 `slot1_codex` 的 provider-state 复制隔离副本，避免污染活跃 agent | 已解 |
| 3 | `better-sqlite3` ABI 不匹配（worktree 的 prebuild 为 Node 22 编译，`NODE_MODULE_VERSION 127`） | `prebuild-install --runtime node --target 24.10.0` 换装 | 已解 |
| 4 | doctor 报端口 8787 占用 | 非真阻塞——直跑 `client/scripts/doctor.ts` 才用默认端口；Gate C 自身传 `--port <空闲端口>` | 不成立 |
| 5 | Playwright 浏览器找不到 | CCB 将 `HOME` 改写至 provider-state，浏览器实际在 `/home/sue/.cache/ms-playwright`；设 `PLAYWRIGHT_BROWSERS_PATH` 指回 | 已解 |

**仍未跑通的真实卡点**：首个 UI 步骤 `v2-user-path` 在「保存并继续」映射对话框后等待 `getByTestId('session-title')` 超时 30s，即**真实 Codex 会话未能创建**。属 Codex 运行时 / 凭证环境，**与本需求 8 片代码无关**——已核验 `RequirementsV2App.openSession` 使用硬编码 `/sessions?` 路径、不经 `pathOf`，且其最后一次改动在 PR5 (`5b653bc`) 而非 PR8。

**无法只跑新增步骤**：`gateCSteps` 注册表不支持按 step 过滤，且 `overviewWorkbenchStep` 位列 `v2UserPathStep` 之后并依赖其建立的会话上下文。

**复跑命令**（Codex 会话环境修复后）：

```bash
cd <worktree>
export PATH=/home/sue/.nvm/versions/node/v24.10.0/bin:$PATH
export SUDUO_CODEX_HOME=<可用 codex home>
export PLAYWRIGHT_BROWSERS_PATH=/home/sue/.cache/ms-playwright
pnpm gate:c
```

## 协商增补

> 来源：batch 前置协商 `job_0b09b882cf21`（slot1_codex，consult 模式）+ coordinator 扩查。

### 1 · 切默认路由会打破既有 Gate C 步骤（硬回归，必须同步修）

`/` 的兜底由需求看板改为工作台后，Gate C 中**全部 6 处**依赖 `/` 落到看板的调用点会失效（它们后面都跟着 `getByTestId("requirements-board").waitFor()`）：

| # | 文件 | 行 | 形态 |
|---|---|---|---|
| 1 | `client/server/test/gate-c/steps/requirements-board.ts` | 48 | `page.goto(origin + "/")` |
| 2 | `client/server/test/gate-c/steps/requirements-board.ts` | 184 | `publisher.goto(origin + "/")` |
| 3 | `client/server/test/gate-c/steps/settings-codex.ts` | 103 | `pushState({}, "", "/")` + 等看板 |
| 4 | `client/server/test/gate-c/steps/settings-shell.ts` | 64 | 同上 |
| 5 | `client/server/test/gate-c/steps/mcp-settings.ts` | 85 | 同上 |
| 6 | `client/server/test/gate-c/steps/sessions-rail.ts` | 81 | 同上 |

六处全部改走 `/requirements`。**漏改任一处，Gate C 会在本片之后整条挂掉。**

### 2 · 端到端「实测」走 Gate C 扩展，不接受手工点

原样 `pnpm gate:c` 不足以覆盖新增页面——现有 fixture 没有 stats、批量 requirements、overview/workbench 步骤。本片须：

- 扩展 `startRequirementsServiceFixture`：补 `stats`、批量 `requirements?ids=`、审计 `projectId` 过滤，以及**远程失败开关**（用于验证工作台降级）
- 在 `gateCSteps` 注册表新增隔离的 overview / workbench step，覆盖：默认路由四条语义、漏斗条→看板筛选穿透、停滞榜→需求详情穿透、材料漂移提示、远程不可达时的分块降级
- 环境前提已核实：Playwright 浏览器缓存与依赖齐备，远程 fixture 是内存 HTTP 服务**不依赖 Docker**（本机无 docker 命令）

扩展测试夹具与步骤属于**验收实现**，不算本片「不新增功能」边界所禁止的产品功能。

## Materialization Context

- Requirement: suduo-v2-overview-and-my-workbench-001
- Section: pr8-default-landing-and-delivery-gate
- Owner: ccb_codex
- Priority: high
- Dependencies: subtask-ccadb260fea9, subtask-a6ed55d5509a
