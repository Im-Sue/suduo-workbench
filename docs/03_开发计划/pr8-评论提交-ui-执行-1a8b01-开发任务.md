---
doc_type: dev_task
task_id: subtask-5a682b1a8b01
title: PR8 · 评论提交（UI 执行）
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: medium
requirement_id: suduo-v2-session-context-closure-001
section_id: pr8-comment-submit
order: 8
implementation_owner: ccb_codex
dependencies: [subtask-046836a24b79, subtask-8ac604665703]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-session-context-closure-001.json
source_draft_hash: deabe84914ac5795702bb52bfccd903f733c1894cde344b500beca44462d83eb
created_at: 2026-08-30T06:39:07.359Z
updated_at: 2026-09-05T06:50:26.177Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-session-context-closure-001","branch":"ccb/req-suduo-v2-session-context-closure-001"}
---

# PR8 · 评论提交（UI 执行）

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 模型写全文、用户点发送、BFF 执行；超时不重试而是自动查证并明确告知，避免重复发出不可撤回的评论。 |
| 需求来源 | suduo-v2-session-context-closure-001 |
| 本期范围 | pr8-comment-submit · PR8 · 评论提交（UI 执行） |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### PR8 · 评论提交（UI 执行）

#### 任务概述

让开发能在对话里直接回复 PM，不用切窗口手敲。

关键设计：**执行方是 UI/BFF，不是 Codex**。这样既不需要把会话开成 full 档（沙箱关网，Codex 发不出 HTTP），确认动作也天然显式——用户点的按钮。

#### 任务分解

**1. 流程**

```
模型写出完整评论文本（结构化建议）
  → UI 严格解析，解析失败就不出卡片
  → 用户看到全文后点发送
  → BFF 执行 POST /comments
  → 立即回显内容与评论 id
```

**2. 安全约束**

- 操作绑定**当前会话的 requirement**（从 session ref 派生），**不信任模型给出的 ID**
- 流式文本必须等 turn 完成后才解析，避免半截输出或历史重放出卡
- 模型**不得自主发起**，也**不得主动建议**发评论（防评论泛滥稀释信噪比）
- 另提供不依赖模型输出的通用入口作兜底

**3. 超时处理（重点）**

评论是 **append-only**——没有编辑和删除接口，发错了改不了删不掉，只能追加更正。而远程 POST **没有幂等机制**。所以：

- **不重试**（重试可能重复发出不可撤回的评论）
- 超时后自动 `GET listComments` **查证一次**，多数情况能收敛成确定答案
- 仍不确定则提示：「发送结果未确认，请在需求页核对是否已存在，**不要直接重发**」

最后这句措辞很重要：只说「结果未知」会让用户以为没发出去而手动重发，**系统避免的重复被用户制造出来**。

**4. 提交后收敛**

提交成功后立即触发一次现状收敛，让文件反映新评论。

#### 验收标准

- [ ] 解析失败不出卡片
- [ ] 卡片操作绑定会话自身的 requirement，篡改模型输出中的 ID 无效
- [ ] 半截流式输出不触发卡片
- [ ] 超时路径：恰好一次 POST + 一次查证，不产生重复评论
- [ ] 提示文案明确包含「不要直接重发」
- [ ] 提交成功后现状文件在合理延迟内反映该评论

#### 已知限制

远程无幂等，所以只能证明「本机恰好发了一次」，**不能证明端到端至多一次**。这是用户已知并接受的（拍板不改远程 API）。

#### 边界

- 不做评论编辑/删除（远程无此接口）
- 不改远程 API

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-046836a24b79, subtask-8ac604665703
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
- Section: pr8-comment-submit
- Owner: ccb_codex
- Priority: medium
- Dependencies: subtask-046836a24b79, subtask-8ac604665703
