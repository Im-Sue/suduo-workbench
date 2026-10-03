---
doc_type: dev_task
task_id: subtask-fde4a3e2d79d
title: PR7 · 附件按需拉取到工作目录
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: medium
requirement_id: suduo-v2-session-context-closure-001
section_id: pr7-attachment-observe
order: 7
implementation_owner: ccb_codex
dependencies: [subtask-046836a24b79]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-session-context-closure-001.json
source_draft_hash: deabe84914ac5795702bb52bfccd903f733c1894cde344b500beca44462d83eb
created_at: 2026-08-30T06:39:07.359Z
updated_at: 2026-09-05T06:02:14.864Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-session-context-closure-001","branch":"ccb/req-suduo-v2-session-context-closure-001"}
---

# PR7 · 附件按需拉取到工作目录

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 补齐附件字节的落盘路径，让北极星句里的「要我拉下来吗」能真正兑现；产出 observed 材料标记。 |
| 需求来源 | suduo-v2-session-context-closure-001 |
| 本期范围 | pr7-attachment-observe · PR7 · 附件按需拉取到工作目录 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### PR7 · 附件按需拉取到工作目录

#### 任务概述

北极星句的最后半句是「**要我拉下来吗？**」。前面几片让模型能看到「有 1 个附件」，但**拉不下来**——现有 BFF 只有给 UI 用的流式下载和产物版本落盘，没有「把某个附件写到模型能读的位置」这条路径。

不补这片，闭环只完成一半。

#### 任务分解

**1. 附件落盘能力**

复用 `fetch-artifact-version` 已有的受控落盘模式（路径安全校验、sha256 校验、原子写）。落点与权限复用 PR1 的访问契约。

**2. observed 标记**

拉下来的附件属于「已观测」层——**已落盘但未纳入基线**。要记录来源、观测时刻、sha256、落盘路径，以及「未纳入基线」这个标记本身，让复盘时能区分「开发看过的」和「开发基线里的」。

**3. 与现状文件的关系**

现状文件里的附件清单要能反映哪些已拉取、哪些没有。

#### 验收标准

- [ ] 能把指定附件拉到模型可读位置，sha256 校验通过
- [ ] 落盘材料带 observed 标记，可与基线快照区分
- [ ] 现状文件反映拉取状态
- [ ] 拉取失败时按三态表达，不静默

#### 边界

- 不改远程服务
- 不做附件上传或删除
- 触发方式与评论提交一致：模型表达意图、用户确认、BFF 执行（见 PR8）

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-046836a24b79
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
| `workspace-write` 档下模型可自行读取或改写工作目录中的 observed 附件 | 用户确认后的附件字节无法再被技术隔离；不得将其视作可信指令或声称系统能阻止模型读取 | briefing 与确认卡均要求按不可信证据处理、不得自动打开或执行；这是沙箱能力边界，非本片可消除的风险 |

## Materialization Context

- Requirement: suduo-v2-session-context-closure-001
- Section: pr7-attachment-observe
- Owner: ccb_codex
- Priority: medium
- Dependencies: subtask-046836a24b79
