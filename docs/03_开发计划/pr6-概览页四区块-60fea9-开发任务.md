---
doc_type: dev_task
task_id: subtask-ccadb260fea9
title: PR6 · 概览页四区块
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-overview-and-my-workbench-001
section_id: pr6-overview-page
order: 6
implementation_owner: ccb_codex
dependencies: [subtask-23f1fc238b1a]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-overview-and-my-workbench-001.json
source_draft_hash: f085302ae21d25ec6aa04855f88f18aadb68c0d1bf80e8028f3f28a645e51337
created_at: 2026-08-25T09:41:14.245Z
updated_at: 2026-08-26T07:08:01.964Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-overview-and-my-workbench-001","branch":"ccb/req-suduo-v2-overview-and-my-workbench-001"}
---

# PR6 · 概览页四区块

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 实现状态漏斗条、停滞需求榜、动态时间线、流转量迷你图，跟随顶栏项目并接远程 SSE 刷新。 |
| 需求来源 | suduo-v2-overview-and-my-workbench-001 |
| 本期范围 | pr6-overview-page · PR6 · 概览页四区块 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### PR6 · 概览页四区块

#### 任务概述
把概览页从占位填成真页面。四个区块回答同一个问题的四个侧面：**这个项目现在堵在哪**。

有一条贯穿全片的红线：**每个区块都必须能点穿到处理现场**，不做纯展示卡片。否则这页会变成「看一眼就再不打开」的死页面。

#### 任务分解

**1. 状态漏斗条** — 一条横向分段条。六个流水线状态（草稿 → 梳理中 → 待开发 → 开发中 → 测试中 → 已完成）按顺序排，`on_hold`（暂缓）**拆到右侧单列**——它不在流水线上，混进漏斗会让读数失真。

  段宽即信息：最宽的那段就是堵点。点任一段 → 用 PR5 的 `pathOf` 生成带 `?status=` 的看板路径并跳转，看板据此只显示该状态一列。**本片只负责生成正确路径并跳转；筛选行为本身由 PR5 实现，本片不碰看板组件**。
  实现用 **flex + 百分比宽度，纯 CSS**，不引图表库。每段 `role="img"` + `aria-label`。

**2. 停滞需求榜** — 每行：需求标题 + 状态徽章 + 停滞天数 + 最后操作人，点击进需求详情。阈值分级由服务端算好下发，前端只渲染提示 / 警示两档视觉。

  文案用**「最后更新」**，不要写「最后状态变更」——已查证附件增删与产物发布也会刷新 `updatedAt`，写成「状态变更」是错的。

**3. 最近动态时间线** — 按「人 + 时间窗」合并显示（如 `张三 14:20 更新了 3 条需求`），可展开看细节。**状态变更事件要视觉突出**，用 `before/after` 渲染成 `待开发 → 开发中`。

  **合并规则定死**：同一操作人 + 同一 action 类型 + 相邻两条间隔 ≤ **15 分钟** 才合并成一行；超过 15 分钟断开另起一行。**状态变更事件永不参与合并**，每条独立成行——否则与上面「状态变更要视觉突出」自相矛盾。合并行的时间取该组**最早**一条。

  为什么要合并：每条审计单独一行，评论和附件事件会刷屏，把真正代表流程推进的状态变更淹没。共 12 种 action（含 `artifact_version.published`），都要能正确渲染。

**4. 流转量迷你图** — 按天统计状态变更数，支持 7 天 / 30 天切换。**内联 SVG `<rect>`**（约 30 行），配 sr-only 数据表供读屏。次要模块，位置靠下。

**5. 数据接线** — 进页面加载 stats 与首屏审计；用 PR5 的 SSE hook 订阅 `requirement.changed` 增量刷新。**跟随顶栏项目切换**：切项目要换数据。调用时传浏览器的 IANA 时区名给 `tz`。

**6. 空态**（需求 R9）— 无停滞需求显示「没有停滞需求」而非空白；新项目零需求时漏斗条显示引导而非零值图表。

#### 验收标准
- [ ] 切换顶栏项目，四个区块数据全部跟着换
- [ ] SSE 到达时刷新，且断线能重连（用 PR5 的 hook，不自己再写一份）
- [ ] 漏斗条点击 → 地址栏变成 `/requirements?status=<该状态>`，且看板只显示该状态一列；停滞榜点击 → 进需求详情
- [ ] 七档状态全 0 或部分为 0 时渲染正常，不出现除零或塌陷
- [ ] 时间线 12 种 action 均可渲染；状态变更显示 `前 → 后`，且每条独立成行不被合并
- [ ] 合并规则可证伪：同人同 action 间隔 14 分钟 → 合并成一行；间隔 16 分钟 → 断成两行；合并行展开后的条目数与原始审计条数相等
- [ ] 迷你图 7 天 / 30 天切换正确；跨零点数据归属日期符合本地时区
- [ ] 空态文案按 R9 落地，不是空白
- [ ] 无障碍：分段条每段有 `aria-label`，迷你图有 sr-only 数据表

#### 边界
- **禁止修改 `RequirementsV2App.tsx` 与 `api/client.ts`**——PR5 已定稿，改了会和 PR7 冲突
- 不引图表库、不加任何新依赖
- 不做跨项目概览
- 不做逾期率、进度百分比、燃尽图、速率预测——依赖字段不存在，硬做就是编数字
- **禁止修改 `RequirementsWorkbench.tsx`**——看板筛选由 PR5 实现，本片只经 PR5 的路由协议跳转

#### 依赖
- **PR5**。可与 PR7 并行

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-23f1fc238b1a
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

> 来源：batch 前置协商 `job_0b09b882cf21`（slot1_codex，consult 模式）。

### 1 · 漏斗点击验收按 PR5 的前向兼容协议执行

PR5 已增补看板筛选 URL 协议：无筛选 `pathOf("requirements")` 返回 `/`，**带筛选返回 `/requirements?status=<状态>`**，且 `routeOf` 双路径识别。因此本片验收「地址栏变成 `/requirements?status=<该状态>`」在本片交付当时即应原样成立，不接受降格为 `/?status=`。本片仍只负责调用 `pathOf` 生成路径并跳转，不碰看板组件与路由文件。

### 2 · 「12 种 action 均可渲染」需 DOM 级证据

纯函数测试只能证明 12 个 action 都映射到非空展示模型，**不能证明 JSX 没漏渲染**。本片验收须同时给出两层证据：

- 纯函数层：合并规则与展示模型映射的全量穷举测试（含 14 分钟合并 / 16 分钟断开 / 合并行展开条目数守恒）
- DOM 层：复用 PR5 建立的 jsdom + `react-dom/client` 最小挂载设施，断言 12 个 action 的 DOM 均实际出现

**不引入 `@testing-library/react`**；`vitest.config.ts` 由 PR5 改完，本片直接复用，不再改配置。

## Materialization Context

- Requirement: suduo-v2-overview-and-my-workbench-001
- Section: pr6-overview-page
- Owner: ccb_codex
- Priority: high
- Dependencies: subtask-23f1fc238b1a
