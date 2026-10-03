---
doc_type: dev_task
task_id: subtask-23f1fc238b1a
title: PR5 · Web 壳层与路由骨架
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-overview-and-my-workbench-001
section_id: pr5-web-shell-and-routes
order: 5
implementation_owner: ccb_codex
dependencies: [subtask-f9475ab9b719]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-overview-and-my-workbench-001.json
source_draft_hash: f085302ae21d25ec6aa04855f88f18aadb68c0d1bf80e8028f3f28a645e51337
created_at: 2026-08-25T09:41:14.245Z
updated_at: 2026-08-26T06:46:39.962Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-overview-and-my-workbench-001","branch":"ccb/req-suduo-v2-overview-and-my-workbench-001"}
---

# PR5 · Web 壳层与路由骨架

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 加两个导航项与两条路由、api client 三方法与共享 SSE hook，两个页面先以占位形态可达；不切默认落地页。 |
| 需求来源 | suduo-v2-overview-and-my-workbench-001 |
| 本期范围 | pr5-web-shell-and-routes · PR5 · Web 壳层与路由骨架 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### PR5 · Web 壳层与路由骨架

#### 任务概述
这一片是为后面两个页面**一次性把壳搭好**：导航能点、路由能进、接口能调。搭好之后，概览页和工作台页就能各写各的、互不打架。

关键约定：**`RequirementsV2App.tsx`、`api/client.ts` 与 `RequirementsWorkbench.tsx` 由本片独占**。PR6 和 PR7 只写自己的组件，一行都不许改这三个文件——否则两片并行必然冲突。

同样重要的是**本片不切默认落地页**。`/` 继续落到需求看板，因为此刻两个新页面还只是占位，把用户默认扔进一个空壳页是净损失。默认入口切换留到 PR8，等两个页面都真能用了再切。

#### 任务分解

**1. `RequirementsTopBar.tsx`** — `RequirementsWorkbenchMode` 类型加 `"overview"` 与 `"my"`。

**2. `AppNav.tsx`** — 新增两个导航项，**排在「需求」「会话」之前**。折叠态必须带 tooltip 与 `aria-label`，与现有 `NavItem` 约定一致。仅在 `shellReady`（已配置且已登录）时显示。

**3. `RequirementsV2App.tsx`** — `routeOf` 认识 `/overview` 与 `/my`，`pathOf` 能生成这两个路径，渲染分支接上两个新页面组件。

  **必须原样保留** `/?sessionId=...` → 会话页 这条既有分支（当前在 `routeOf` 里），它是老链接进会话的入口。
  **本片 `pathOf("requirements")` 仍返回 `/`**，默认落地行为不变。

  **另需建立看板状态筛选的路由协议**——PR6 的漏斗点击要落到这里，而本片是唯一有权改这两个文件的片：`routeOf` 解析看板路径上的 `?status=<RequirementStatus>`，非法值按无筛选处理；返回结构增加 `statusFilter: RequirementStatus | null`；`pathOf` 接受可选 status 并生成带该查询参数的路径。解析结果以 prop 传给 `RequirementsWorkbench`。

**4. 两个占位页** `OverviewMode.tsx` 与 `MyWorkbenchMode.tsx` — 可导航到，显示**明确的「该页面正在建设中」占位**，不是空白页。PR6 / PR7 会把它们填满。

**5. `api/client.ts`** — 一次性加齐三个方法：`getProjectStats`、`getMyWorkbench`、以及既有 audit 调用支持传 `projectId`。三个都只调 `/api/v2/*`，**不得直连远程服务**。

**6. 新增 `components/requirements-v2/use-requirements-event-stream.ts`** — 远程 SSE 重连 hook，供概览页用。仅新页面使用，不改既有 SSE 消费方。

**7. `RequirementsWorkbench.tsx` 加状态筛选**（1221 行文件，**只加不改**）— 新增 `initialStatusFilter?: RequirementStatus` prop 与对应筛选 state。有筛选时**只渲染该状态一列**，其余各列隐藏，看板顶部显示「筛选：<状态名> ✕ 清除」标识；点清除回到全部列并同步清掉 URL 上的 `status`。

  **事实修正（2026-08-26，review 核验）**：原文写「其余五列 / 回到六列」有误。`requirements-board.ts:16` 的 `BOARD_COLUMNS = REQUIREMENT_STATUSES` 实际是**七列**（草稿 / 梳理中 / 待开发 / 开发中 / 测试中 / 已完成 / 暂缓）。实现按代码现实交付七列，验收以七列为准。无 `status` 参数时渲染与既有交互**与改动前完全一致**。

#### 验收标准
- [ ] 点击两个导航项能进对应页面，地址栏是 `/overview` 与 `/my`；直接输入这两个 URL 也能进
- [ ] 折叠态导航有 tooltip 与 `aria-label`
- [ ] **`/` 仍落到需求看板**（本片不切换），且 `/?sessionId=xxx` 仍进会话页
- [ ] `/requirements/:id` 详情语义不变
- [ ] 两个新页面显示占位文案，**不是空白页**
- [ ] 未登录 / 未配置时两个导航项不显示，与既有导航项行为一致
- [ ] api client 三个方法有类型且能跑通（可对着 PR4 的端点手测一次）
- [ ] 直接访问 `/requirements?status=in_development`：看板只渲染「开发中」一列，顶部有可清除的筛选标识
- [ ] 点「✕ 清除」：恢复全部七列，且 URL 上的 `status` 同步清掉
- [ ] `status` 传非法值或完全不传：看板行为与改动前完全一致（七列全在）
- [ ] 拖拽改状态、详情抽屉、评论、附件等看板既有交互，在筛选态与非筛选态下均不回归

#### 边界
- **不切默认落地页，不迁移看板路径**——属 PR8
- 不写概览页与工作台页的任何业务区块——属 PR6 / PR7
- `RequirementsWorkbench`（1221 行）**只加状态筛选入口**，不动拖拽、详情抽屉、评论、附件等既有交互；不改 `SessionRuntime`
- 不引入图表库或任何新依赖

#### 依赖
- **PR4**。api client 要对着已经存在的 BFF 端点与契约类型写

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-f9475ab9b719
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

## 协商增补

> 来源：batch 前置协商 `job_0b09b882cf21`（slot1_codex，consult 模式）。以下两项为本片**新增交付内容**，理由与原 spec 边界不冲突。

### 增补 1 · 看板筛选 URL 前向兼容协议（必做）

本片验收第 75 行已要求「直接访问 `/requirements?status=in_development`」可用，但本片同时规定无筛选的 `pathOf("requirements")` 仍返回 `/`。两者必须同时成立，因此路由协议定为：

- `pathOf("requirements")` 无筛选 → `/`（默认落地行为不变，仍归 PR8 切换）
- `pathOf("requirements", status)` 带筛选 → `/requirements?status=<RequirementStatus>`
- `routeOf` **同时识别** `/` 与 `/requirements` 两条看板路径，两者都解析 `?status=`

这样 PR6 的漏斗点击验收（「地址栏变成 `/requirements?status=`」）在 PR6 交付当时即可原样通过，PR8 只需切换无筛选默认路径。**不建立此协议，PR6 会因字面验收不达标被拒收。**

### 增补 2 · 前端 DOM 级测试设施（必做）

PR6/PR7 有多条验收需要 DOM 级证据（12 种 action 均可渲染、DOM 中可断言文案、真实卸载后无残留定时器），而现状 `client/web/test/` 13 个测试全是 node 环境纯逻辑测试。本片作为「一次性把壳搭好」的片，负责建立设施，PR6/PR7 直接复用：

- `client/web/vitest.config.ts`：`include` 增加 `test/**/*.test.tsx`；用 **`environmentMatchGlobs`**（或 per-file `@vitest-environment jsdom` 注释）**只让 `*.test.tsx` 走 jsdom**
- **禁止全局切 jsdom** —— 既有 13 个测试必须保持 node 环境零变化，切换后必须全绿
- 挂载用 `react-dom/client` 手写最小渲染断言，**不引入 `@testing-library/react`**
- `jsdom` 已在 `client/web` devDependencies，`react-dom` 是生产依赖；本项**不构成引入新依赖**，不违反本片「不引入图表库或任何新依赖」边界

设施归本片（而非 PR6）的理由：归 PR6 会让 PR7 隐式依赖 PR6，破坏 spec 明确的 PR6 ∥ PR7 独立性。

## Materialization Context

- Requirement: suduo-v2-overview-and-my-workbench-001
- Section: pr5-web-shell-and-routes
- Owner: ccb_codex
- Priority: high
- Dependencies: subtask-f9475ab9b719
