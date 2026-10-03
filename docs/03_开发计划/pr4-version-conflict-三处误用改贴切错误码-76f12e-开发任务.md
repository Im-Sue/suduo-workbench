---
doc_type: dev_task
task_id: subtask-ee194976f12e
title: PR4 · VERSION_CONFLICT 三处误用改贴切错误码
status: done
current_node: archive
node_substate: archived
runtime_state: completed
review_status: passed
priority: medium
requirement_id: suduo-v2-consistency-guard-retirement-001
section_id: pr4-version-conflict-code-cleanup
order: 4
implementation_owner: ccb_codex
dependencies: []
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-consistency-guard-retirement-001.json
source_draft_hash: e28850e1cde166d3072c41284b6d9488827ccc4436d4c168fceb88e565240d46
created_at: 2026-09-06T05:15:51.836Z
updated_at: 2026-09-06T06:48:34.067Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-consistency-guard-retirement-001","branch":"ccb/req-suduo-v2-consistency-guard-retirement-001"}
---

# PR4 · VERSION_CONFLICT 三处误用改贴切错误码

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | BFF requirements-v2-service.ts :238/:658 改 SESSION_NOT_ACTIVE、:662 改 SESSION_PROJECT_MISMATCH，只改码不改 409 / 文案 / 行为；contracts ErrorCode 与 web classify.ts 登记两码为 stale_state；补 observed-attachment-service 非活动会话与项目错配两例。无语义依赖，但共改 requirements-v2-service.ts，同一 worktree 内不与其它片同时在途。 |
| 需求来源 | suduo-v2-consistency-guard-retirement-001 |
| 本期范围 | pr4-version-conflict-code-cleanup · PR4 · VERSION_CONFLICT 三处误用改贴切错误码 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### PR4 · VERSION_CONFLICT 三处误用改贴切错误码

#### 任务概述

**目标对齐**：BFF 里有三处 409 借用了「版本冲突」这个错误码去表达别的意思：会话不是活动状态就不许提交评论 / 拉取附件（两处），会话绑定的本机项目和远程需求对不上（一处）。版本校验退役之后，还留着一个叫「版本冲突」的码去表达这些前置条件，会持续误导读代码和读错误的人。这一片**只改错误码的名字**：三处检查本身、409 状态码、中文文案、行为一个都不变；同时把两个新码登记到契约和前端错误分类表里，让前端把它们归为「状态已变化」而不是「版本冲突」。

| 项 | 说明 |
|----|------|
| 交付目标 | 需求 4.5 `VERSION_CONFLICT` 错误码收口（Claude 主动新增项，已过 ADR-0004 三问：无仲裁者、纯命名清理、不改行为） |
| 需求来源 | `docs/02_需求设计/v2-一致性守卫退役-需求.md` §4.5 |
| 技术来源 | 技术设计 三、关键决策「错误码命名」（`SESSION_NOT_ACTIVE` 由 ADR-0004 §3 点名；`:662` 比的是本机项目映射故用 `SESSION_PROJECT_MISMATCH`）、十（错误码片） |
| 本期范围 | BFF 三处错误码；contracts `ErrorCode`；web `classify.ts`；对应测试 |
| 不含范围 | BFF 其余约 60 处 `VERSION_CONFLICT`；`VERSION_CONFLICT` 本身的删除；任何文案变更 |
| 分工 | ccb_codex 实施与验证 |

#### 任务分解

- [ ] **1. BFF** `client/server/src/application/requirements-v2-service.ts`：`:238`「只有活动需求会话可以提交评论」与 `:658`「只有活动需求会话可以拉取附件」改为 `SESSION_NOT_ACTIVE`；`:662`「会话与远程需求映射不一致」改为 `SESSION_PROJECT_MISMATCH`。状态码 409、文案、检查顺序、行为全部不变（`:238` 拦的是 AI 往共享需求提交评论，是 ADR-0004 红线，**只改码不改行为**）
  - 依赖：2
- [ ] **2. contracts** `client/contracts/src/api.ts:9-23` `ErrorCode` 联合类型加 `"SESSION_NOT_ACTIVE"` 与 `"SESSION_PROJECT_MISMATCH"`；`VERSION_CONFLICT` **保留**（其它路径仍用）；`requirements-v2/errors.ts` 不动
- [ ] **3. web** `client/web/src/feedback/classify.ts:3-31` `CODE_KINDS` 加两码 → `"stale_state"`（不加则按 `STATUS_KINDS[409]` 兜底成 `version_conflict`，正是要退役的反馈语义）；`:9` 的 `VERSION_CONFLICT: "version_conflict"` 保留
  - 依赖：2
- [ ] **4. 测试**
  - `client/server/test/requirements-v2-comment-submit.test.ts:31` 断言改为 `SESSION_NOT_ACTIVE`，行为断言（不调远端）不变
  - `client/server/test/observed-attachment-service.test.ts`（今天 `:73-78` 固定 active 且项目匹配，`:658` / `:662` **零覆盖**）：新增两例——会话非 active → 409 `SESSION_NOT_ACTIVE`、文案「只有活动需求会话可以拉取附件」、不发起下载；`session.projectId !== project.id` → 409 `SESSION_PROJECT_MISMATCH`、文案「会话与远程需求映射不一致」、不发起下载
  - `client/web/test/feedback-classify.test.ts:25-40` 表加两行 `{ status: 409, code: <新码>, kind: "stale_state" }`；`VERSION_CONFLICT → version_conflict` 一行保留
  - web 侧无按 `VERSION_CONFLICT` 字面分流评论提交 / 附件拉取失败的分支（`ObservedAttachmentActions.tsx:48` 统一 `onError`），无需改 UI

#### 验收标准

- [ ] `grep -n "VERSION_CONFLICT" client/server/src/application/requirements-v2-service.ts` 零命中；`git diff` 中该文件只有三行错误码字符串变化
- [ ] 两个新码存在于 `ErrorCode` 与 `CODE_KINDS`；`pnpm --filter @suduo/client-contracts build` 后 server / web typecheck 通过
- [ ] 三处检查的 409、文案、行为不变（4 中四条用例通过）；非活动会话提交评论仍不调远端
- [ ] `VERSION_CONFLICT` 仍存在于 `api.ts` / `errors.ts` / `classify.ts:9` / `remote-client.ts:656`；BFF 其余 `VERSION_CONFLICT` 命中数与改前一致（回执给出前后 grep 计数）
- [ ] 四个包测试 + `typecheck` + `lint` 全绿
- [ ] 回执逐条确认「全片共享约束」1-8 未动，并显式回答「本片未引入新的拒绝式守卫」（`:238` 是 ADR-0004 红线的 append-only 对外写入确认门；`:658` / `:662` 是既有非版本类前置检查，需求 4.5 只改码不改行为；三处都只改码）

#### 边界

- 不删 `VERSION_CONFLICT`、不动其余约 60 处、不改任何用户可见文案
- 不碰 PR1-PR3 的任何文件区域；本片与前三片无语义依赖，但共改 `requirements-v2-service.ts`，**同一 worktree 内不得与其它片同时在途**
- 不给 `SESSION_NOT_ACTIVE` / `SESSION_PROJECT_MISMATCH` 加新的前端提示或跳转

#### 风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 执行者顺手把其它「像误用」的 `VERSION_CONFLICT` 一起改了 | 中 | 范围写死三处；回执给前后计数 |
| 新码未登记 `CODE_KINDS`，前端把它当版本冲突自动刷新 | 中 | 3 + 验收第 2 条 |

## 三、执行顺序 / 里程碑

- 前置依赖: 无
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-09-06 | 物化任务文档 | 无 | 等待 dispatch 派工 |
| 2026-09-06 | 派工 slot2_codex（job_3795439b736b）；实施完成，提交 `3596bcd` | 无 | 进入审查 |
| 2026-09-06 | 审查通过并归档：Claude 独立复跑四包 + typecheck + lint 一次全绿（rs 14/55、server 43/202、web 34/161），并按提交级 git show 核实目标文件只有三行字符串变化 | 无 | 批次收尾 |

## 五、验收标准

- [ ] 完成 `spec_section_md` 定义的实现范围。
- [ ] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [ ] 完成必要验证，并在回执中说明测试命令与结果。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## Materialization Context

- Requirement: suduo-v2-consistency-guard-retirement-001
- Section: pr4-version-conflict-code-cleanup
- Owner: ccb_codex
- Priority: medium
- Dependencies: none
