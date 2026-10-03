---
doc_type: dev_task
task_id: subtask-3e14b22d7e7c
title: PR4 · 现状文件生命周期与会话状态注册
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: medium
requirement_id: suduo-v2-session-context-closure-001
section_id: pr4-observation-lifecycle
order: 4
implementation_owner: ccb_codex
dependencies: [subtask-dfed9b11d222]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-session-context-closure-001.json
source_draft_hash: deabe84914ac5795702bb52bfccd903f733c1894cde344b500beca44462d83eb
created_at: 2026-08-30T06:39:07.359Z
updated_at: 2026-08-30T10:58:56.981Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-session-context-closure-001","branch":"ccb/req-suduo-v2-session-context-closure-001"}
---

# PR4 · 现状文件生命周期与会话状态注册

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 建立活跃会话注册表与状态转移挂钩，按会话状态管理文件；archived 保留 30 天后清理，deleted 即时删。 |
| 需求来源 | suduo-v2-session-context-closure-001 |
| 本期范围 | pr4-observation-lifecycle · PR4 · 现状文件生命周期与会话状态注册 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### PR4 · 现状文件生命周期与会话状态注册

#### 任务概述

这一片管两件事：**哪些会话需要刷新**（注册表），以及**文件什么时候该删**（保留期）。

它排在持续刷新（PR5）之前，是因为 PR5 的「会话激活时收敛」需要知道当前有哪些活跃会话——这个注册表得先有。

#### 任务分解

**1. 活跃会话注册表**

- 会话进入 `active` → 注册
- 离开 `active` → 注销
- BFF 重启后从数据库恢复注册表（否则重启前建的会话再也不会刷新）

**2. 按会话状态管理文件**

| 会话状态 | 现状文件 |
|---|---|
| `active` | 持续刷新 |
| `archived` | 停止刷新，**保留**，超 30 天清理 |
| `deleted` | 立即删除 |
| `error` | 不刷新 |

`archived` 不能一归档就删——它可以恢复成 `active`（`session-service.ts:279-282` 会重建 thread），恢复后要能继续用。`deleted` 是软删、session ref 仍保留，但文件应即时清理。

**3. TTL 清理**

`archived` 超过保留期（默认 30 天，可配置）自动清理。清理动作要能被重启打断后继续。

#### 验收标准

- [ ] 会话状态流转对应文件行为，逐档验证
- [ ] `archived` → `active` 恢复后能继续刷新
- [ ] `deleted` 后文件立即消失
- [ ] BFF 重启后，重启前创建的活跃会话仍在注册表中
- [ ] 超 TTL 的 archived 文件被清理，未超的保留

#### 边界

- 不做 SSE 与刷新逻辑本身（PR5）
- 不改会话状态机语义，只挂钩已有转移

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

## Materialization Context

- Requirement: suduo-v2-session-context-closure-001
- Section: pr4-observation-lifecycle
- Owner: ccb_codex
- Priority: medium
- Dependencies: subtask-dfed9b11d222
