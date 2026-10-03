---
doc_type: dev_task
task_id: subtask-181ffe3de1e7
title: PR2 · 审计完备性（远程服务端）
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-session-context-closure-001
section_id: pr2-audit-completeness
order: 2
implementation_owner: ccb_codex
dependencies: []
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-session-context-closure-001.json
source_draft_hash: deabe84914ac5795702bb52bfccd903f733c1894cde344b500beca44462d83eb
created_at: 2026-08-30T06:39:07.359Z
updated_at: 2026-08-30T07:56:15.050Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-session-context-closure-001","branch":"ccb/req-suduo-v2-session-context-closure-001"}
---

# PR2 · 审计完备性（远程服务端）

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 补齐漏写的审计、把三条独立写入实现收口为一条、加端点级契约测试防未来静默漏写。 |
| 需求来源 | suduo-v2-session-context-closure-001 |
| 本期范围 | pr2-audit-completeness · PR2 · 审计完备性（远程服务端） |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### PR2 · 审计完备性（远程服务端）

#### 任务概述

整套方案把**审计日志当作判断「需求有没有变动」的唯一信号**。地基不牢，上层全是假的：审计漏写不会报错，只会让模型自信地说「我查过了，没变」——这跟我们要修的 bug 完全同构，而且更隐蔽。

核查已发现一处真实漏写，以及一个会持续制造漏写的结构问题。

#### 任务分解

**1. 补漏写**

`artifact-version-repository.ts:247` 的 `createPublishComment()` 在产物发布时自动创建一条评论写进 `requirement_comments`，但**不写 `comment.created` 审计**。同文件的产物发布本身写了 `artifact_version.published`，唯独这条评论漏了。

影响分级：不影响「有没有变动」的判断（发布事件本身会触发信号），但会让重建出的评论列表少一条。

**2. 三条写入实现收口为一条**

审计写入目前有**三份各自独立的实现**：

| 位置 | 形态 |
|---|---|
| `collaboration-repository.ts:716` | 类私有方法 |
| `attachment-repository.ts:450` | 模块内本地函数 |
| `artifact-version-repository.ts:303` | 裸 `INSERT INTO audit_logs` |

三份实现是漏写的温床——新增路径时很容易照着最近的那份抄，或者干脆忘了。收口成一个共享入口。

**3. 端点级契约测试**

现有 `audit-project-id.test.ts` 已用真实 PG 覆盖 9 类动作，但**没能发现上面那条漏写**。补齐缺口场景：`project.archived` / `project.restored` / `requirement.status_changed` / 发布自动创建的评论，约 4–6 个场景。

原则：**每个变更类 API 调用后，断言审计有对应新增**。这样将来新增写路径时忘了写审计，测试会红。

#### 验收标准

- [ ] 产物发布后，`requirement_comments` 新增的那条评论有对应 `comment.created` 审计
- [ ] 三处审计写入走同一入口，无裸 SQL 残留
- [ ] 契约测试覆盖 `AUDIT_ACTIONS` 全部动作
- [ ] 故意删掉任一处审计写入，对应契约测试必须失败

#### 边界

- **只动 `cloud/server`**，不碰本机 BFF 与前端
- 不加查询参数、不加索引、不加评论幂等（用户已拍板不改远程 API 形态）
- 本片跨远程服务端，需独立部署验证，与其余各片验证方式不同

## 三、执行顺序 / 里程碑

- 前置依赖: 无
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
- Section: pr2-audit-completeness
- Owner: ccb_codex
- Priority: high
- Dependencies: none
