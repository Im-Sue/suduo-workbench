---
id: ADR-0003
title: 会话材料改为按需拉取，产物 blob 改为引用保护
doc_type: adr
status: accepted
supersedes: []
superseded_by:
date: 2026-08-20
---

# ADR-0003: 会话材料改为按需拉取，产物 blob 改为引用保护

> **状态**：accepted ｜ **拍板人**：用户（需求 `suduo-v2-pm-requirement-intake-001` 分析阶段已明确）

---

## 一、背景

T3 建立了「创建需求会话 = 把该需求当前全部活跃附件预拉成本机快照」的模型：`createRequirementSession` 先 `listAttachments`，校验 `requirementVersion` 一致后交给 `material-service.ensureSnapshot` 落盘（`requirements-v2-service.ts:307-323`）。同期 `AttachmentStorage` 建立了「活跃即全部」的存储不变量：删除附件立即 `storage.remove()`（`attachment-service.ts:114-122`），服务启动 `reconcile` 删除一切不在活跃集合内的对象（`attachment-storage.ts:56-74`）。

PM 需求前置闭环要引入「产物版本」——一次发布把一组文件固化为不可变的历史记录，且用户明确「历史版本全留」。这两条既有不变量与之直接冲突：

1. **预拉全量活跃附件让「发布」失去意义**。开发起会话拿到的是「已发布版 + 之后随手上传的未发布材料」的混合体，PM 郑重发布的那一版对交接方没有任何约束力。
2. **「活跃即全部」让「历史全留」无法成立**。PM 删掉一个已发布过的文件，blob 立即消失，历史版本损坏且不可恢复；即使删除时手下留情，服务重启的 `reconcile` 还会补刀。

这不是范围取舍，是设计不自洽——不改则产物版本功能从第一天起就是坏的。

---

## 二、决策

**推翻两条不变量，各换成一条新的。**

### 1. 会话材料：预拉快照 → 按需拉取

创建需求会话只带需求信息（标题、描述、状态、版本），**不下载任何附件**。开发在对话中自行决定要哪一版产物，由 skill 调本机 BFF 拉取并决定落盘位置。

manifest 引入 `schemaVersion: 3`，语义为「requirement-only，材料未拉取」。不复用 v1 的 `attachments: []`——v1 的语义是「远程确实没有附件」，是一条历史断言，复用会让「远程有附件但本次不拉」被误判为不一致（`material-service.ts:252-258`）。v3 分支的快照校验不再比对远程附件集合。

`material_path` / `manifest_sha256` 照常写入，故 `v2_requirement_session_refs` 的 NOT NULL 约束不受影响，**client/server 的 SQLite 迁移链 `[1,2,10]` 无需变动**。

### 2. blob 生命周期：活跃即全部 → 引用即保护

存储对象的存活条件由「归属一条未删除的附件行」放宽为「归属一条未删除的附件行**或**被任一产物版本引用」。

- `activeStorageKeys()` 返回二者并集；
- 删除附件时，若该 storage_key 被版本引用，只软删行、**不物理删 blob**；
- `reconcile` 的活跃集合同步取并集。

物理文件的归属仍是单点：永远只由 `attachments` 行持有，产物版本表只引用不另存。

---

## 三、否决的方案

| 方案 | 为什么没选 |
|------|------------|
| 会话绑定「最新已发布产物版本」预拉 | 协商初期方案。仍替用户预设了工作流，且开发只能拿最新版、无法指定要哪一版；用户明确「默认不拉任何材料，开发自己决定」 |
| 维持预拉全量活跃附件 | 「发布」退化成一次普通上传，对交接方无约束力，产物版本功能失去意义 |
| 复用 manifest v1 的 `attachments: []` 表达「未拉取」 | 方向搞反。v1 是「远程无附件」的历史断言，复用会污染既有校验语义（`material-service.ts:159-174, 252-258`） |
| 产物版本独立存储区，与附件分离 | 上传、下载、sha256 校验、受控落盘全要再造一遍；且 blob 出现两个归属点，生命周期更难保证 |
| 发布时把 blob 复制一份作为版本私有副本 | 存储翻倍；且「未变文件复用」失效，与用户「历史全留」的成本预期相悖 |
| 引用计数列 | 需在删除/发布/回滚多处维护，易漂移；直接按版本引用表查即可，无额外状态 |

---

## 四、影响

**好处**

- 「发布」成为对开发有约束力的交接边界，产物版本功能自洽。
- 历史版本在任何删除与重启序列下都不会损坏。
- 会话创建更快，且 SuDuo 不再替用户规定本机材料目录结构，与「SuDuo 提供能力和数据，skill 决定怎么用」的既定原则一致。

**代价 / 风险**

- 开发不拉材料就看不到任何内容，多一步交互——这是刻意的，用户明确接受。
- 存储只增不减：删除附件不再必然回收空间。本期不做清理策略（用户明确「需要清理后期再说」），容量增长靠 sha256 复用与上限收敛缓解。
- 产物文件的下载路径必须绕开「过滤软删」的既有查询（`attachment-repository.ts:349-359`），否则删掉已发布文件后版本文件 404。这是本决策引入的**必须配套项**，不是可选优化。
- 已有 v2 快照不受影响，继续按 v2 路径校验；无存量迁移。

**受影响**

`client/server/src/application/requirements-v2-service.ts`、`client/server/src/infrastructure/requirements-v2/material-service.ts`、`cloud/server/src/infrastructure/attachment-repository.ts`、`cloud/server/src/infrastructure/attachment-storage.ts`、`cloud/server/src/application/attachment-service.ts`。

---

## 五、关联

- 需求：`docs/02_需求设计/v2-PM需求前置闭环-需求.md`（4.4 / 4.5 / N3 / N7）
- 技术设计：`docs/03_开发计划/v2-PM需求前置闭环-技术设计.md`（§3.5 / §3.6）
- 协商：CCB `job_b0693f826f68`（slot3_codex），manifest v1 复用假设在该轮被反证
