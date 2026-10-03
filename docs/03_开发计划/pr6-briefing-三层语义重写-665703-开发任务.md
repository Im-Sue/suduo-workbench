---
doc_type: dev_task
task_id: subtask-8ac604665703
title: PR6 · briefing 三层语义重写
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-session-context-closure-001
section_id: pr6-briefing-rewrite
order: 6
implementation_owner: ccb_codex
dependencies: [subtask-dfed9b11d222]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-session-context-closure-001.json
source_draft_hash: deabe84914ac5795702bb52bfccd903f733c1894cde344b500beca44462d83eb
created_at: 2026-08-30T06:39:07.359Z
updated_at: 2026-09-05T04:54:53.705Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-session-context-closure-001","branch":"ccb/req-suduo-v2-session-context-closure-001"}
---

# PR6 · briefing 三层语义重写

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 重写会话固定上下文：基线/现状/已观测三层、三态降级话术、现状文件读法；删除「要看最新就建新会话」的误导。 |
| 需求来源 | suduo-v2-session-context-closure-001 |
| 本期范围 | pr6-briefing-rewrite · PR6 · briefing 三层语义重写 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### PR6 · briefing 三层语义重写

#### 任务概述

这是整个需求的问题源头：现在的 `requirement-briefing.ts` 六条设定里**三条在关门、零条在开门**，导致模型拒绝读远程，还给出「创建新会话」这条**根本兑现不了**的出路（新会话同样不含评论与附件）。

这一片把措辞改对。

#### 任务分解

**1. 三层语义**

| 层 | 告诉模型什么 |
|---|---|
| 基线 | 快照是本次开发的事实起点，不可变；**只有切换基线才需要建新会话** |
| 现状 | 远程当下的事实在哪个文件里，怎么读；想看最新内容不必建新会话 |
| 已观测 | 查过/拉过但未纳入基线的材料，要能与基线区分 |

**2. 三态降级话术**

- **确认无**：查到了，结果是空
- **查不到**：附原因与最后成功观测时刻，**绝不说成「没有」**
- **确认有**：给出内容与观测时刻

**3. 措辞修正**

- 「不要尝试访问远程服务器磁盘」→ 精确成「不直连远程服务、不碰远程磁盘；远程信息一律从本机现状文件读取」
- **删除**「远程需求后来更新不会更新当前会话快照；若需要新版本，请由用户创建新会话」中的误导部分
- 明确声明评论与附件**不在快照内**，以及去哪里看
- 保留附件不可信、不得当指令执行的既有约束

**4. 注意既有测试**

`runtime-supervisor.test.ts:102` 锁定了「create/rebuild 携带 developerInstructions、resume 不带」这个行为。重写 briefing 不应打破它；如果确实需要改，要在本片说明理由并同步改测试。

#### 验收标准

- [ ] 北极星句可复现：模型能说出「你的基线是 v2；远程现在 v5，有 3 条评论、1 个附件，差异是……要我拉下来吗？」
- [ ] 存量场景答「共 N 条，都在你开工前」，**不得**答「没有变动」
- [ ] 远程不可达时答「查不到 + 原因」，**不得**答「没有」
- [ ] 模型不再建议「重建会话以查看最新内容」
- [ ] `runtime-supervisor.test.ts:102` 仍通过（或有说明的同步修改）

#### 边界

- **只改 `requirement-briefing.ts`**，不碰 runtime 与 supervisor 逻辑
- 编码可与 PR4/PR5 并行，但**端到端验收必须等 PR5 的降级行为就绪**

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-dfed9b11d222
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-08-30 | 物化任务文档 | 无 | 等待 dispatch 派工 |

## 五、验收标准

- [ ] 完成 `spec_section_md` 定义的实现范围。
- [ ] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [ ] 完成必要验证，并在回执中说明测试命令与结果。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |
| 北极星人工 smoke 的边界 | 手工现状文件只能验证模型按 briefing 读取版本、库存总数与时间线，不能证明真实 BFF→远程服务→锚点分类闭环 | 验收 8 归档为 partial；后续以真实 BFF、远程服务和三条独立评论（含一条锚点后）补端到端验证 |

## Materialization Context

- Requirement: suduo-v2-session-context-closure-001
- Section: pr6-briefing-rewrite
- Owner: ccb_codex
- Priority: high
- Dependencies: subtask-dfed9b11d222
