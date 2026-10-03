---
doc_type: dev_task
task_id: subtask-2d1dbf1f5480
title: PR3 · 产物发布退役 expectedVersion + 发布停增 + 整套 skill 去链
status: done
current_node: archive
node_substate: archived
runtime_state: completed
review_status: passed
priority: high
requirement_id: suduo-v2-consistency-guard-retirement-001
section_id: pr3-artifact-publish-guard-retirement
order: 3
implementation_owner: ccb_codex
dependencies: [subtask-9c5e99684c48, subtask-09b88fcd72dc]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-consistency-guard-retirement-001.json
source_draft_hash: e28850e1cde166d3072c41284b6d9488827ccc4436d4c168fceb88e565240d46
created_at: 2026-09-06T05:15:51.836Z
updated_at: 2026-09-06T06:39:38.079Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-consistency-guard-retirement-001","branch":"ccb/req-suduo-v2-consistency-guard-retirement-001"}
---

# PR3 · 产物发布退役 expectedVersion + 发布停增 + 整套 skill 去链

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 发布删版本比对，改用 touchRequirement 不再抬 version，幂等摘要去字段但存量行不动；contracts / BFF / web 发布侧同片；官方发布 skill 脚本与 SKILL.md 去掉版本串接（必须与发布校验退役同片）；系统架构.md:216 同步；改写 artifact-version-*、reference-protection、audit、BFF 发布透传、集成测试夹具（删自增）与 Gate-C 发布版本号断言。 |
| 需求来源 | suduo-v2-consistency-guard-retirement-001 |
| 本期范围 | pr3-artifact-publish-guard-retirement · PR3 · 产物发布退役 expectedVersion + 发布停增 + 整套 skill 去链 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### PR3 · 产物发布退役 expectedVersion + 发布停增 + 整套 skill 去链

#### 任务概述

**目标对齐**：今天发布产物版本要带 `expectedVersion`，对不上就 409；发布本身还会把需求版本号 +1，于是官方发布 skill 的脚本不得不「上传一个文件、拿响应里的版本号、再传下一个、最后用最新版本号发布」这样串接，否则第二个文件必撞 409。这一片把发布的版本校验删掉、发布不再抬版本（改用 PR1 的 `touchRequirement` 只刷最后更新时间），发布幂等摘要不再包含该字段，并把 skill 的串接补丁连同 `SKILL.md` 里的叙述一起去掉。做完后：PM 勾了哪些附件就发哪些，不提示差异；旧版 skill 副本带着旧字段照样发成功；新版 skill 不再关心版本号。

| 项 | 说明 |
|----|------|
| 交付目标 | 需求 4.3 产物发布不再拒绝 + 4.4 中「产物发布不再自增 version」+ 官方 skill / 接口文档同步（N1 / N2 / N3 / N6 / N8） |
| 需求来源 | `docs/02_需求设计/v2-一致性守卫退役-需求.md` §4.3 / §4.4 / 十三风险表第一行 |
| 技术来源 | 技术设计 三（响应字段全保留、摘要去字段存量不动）、四、八、十（发布片，**skill 去链必须与发布校验退役同片**） |
| 本期范围 | 发布服务 / 仓储；contracts 发布请求与 schema；BFF 校验；web 发布；skill 脚本与 SKILL.md；`系统架构.md:216`；发布相关测试、集成测试与 Gate-C 发布步骤 |
| 不含范围 | 附件（PR1）、需求编辑（PR2）、错误码（PR4）、幂等表本身的去留（另立需求） |
| 分工 | ccb_codex 实施与验证 |

#### 任务分解

**1. requirements-service**

- [ ] **1.1** `application/artifact-version-service.ts`：删 `:60-62` 版本比对；`:104-107` 改调 `touchRequirement`（PR1 的 `infrastructure/requirement-touch.ts`）；`:161` `normalizePublishRequest` 与 `:171` `publishRequestDigest` 去掉 `expectedVersion`（新摘要只哈希 `attachmentIds` + `note`；**存量摘要行不动、比较规则不放宽**）；`:47-59` `lockRequirement` 与幂等重放**不动**，命中重放直接返回存量响应且不 touch
  - 依赖：PR1 的 `touchRequirement`
- [ ] **1.2** `infrastructure/artifact-version-repository.ts:288-305` 删 `incrementRequirementVersion`；`lockRequirement` 不动。此后全仓不再存在任何 `version = version + 1` 的附件 / 发布写入
- [ ] **1.3** 发布审计 `createPublicationAudit` 里的 `requirementVersion` 与 SSE `artifact.published(requirementVersion)` 改为 touch 返回的当前版本（字段保留）

**2. contracts**

- [ ] **2.1** `requirements-v2/artifact-versions.ts:27` 删 `expectedVersion`；`requirements-v2/schemas.ts:91-100` `publishArtifactVersion` 删 `required` 项与属性（旧 body 靠 Ajv `removeAdditional` 剥离）
  - 依赖：无（改完 build contracts）

**3. BFF**

- [ ] **3.1** `requirements-v2-service.ts:298` 删 `validateExpectedVersion`；其余手工校验（`operationKey` / `attachmentIds`）保留
  - 依赖：2.1

**4. web**

- [ ] **4.1** `requirements-artifacts.ts:27, 33` builder 删字段；`RequirementsWorkbench.tsx:949-972` 删 `expectedVersion` 常量与请求字段、删 `:966` 的 `version_conflict` 分支（发布失败只 `reportError`，不自动刷新）；`:614-615` 的 `artifact.published` 处理逻辑不变，把注释「发布同时 bump 需求版本」改为「发布只刷更新时间，仍整组回查」
  - 依赖：2.1

**5. 官方发布 skill 与文档**

- [ ] **5.1** `client/server/defaults/codex/skills/suduo-publish-artifact-version/scripts/publish-artifact-version.mjs`：删 `:35` 初始化、`:64` 请求头、`:79` 续接、`:89` body 字段。`:31` / `:73` 对响应 `requirementVersion` 的校验可保留（字段仍在）也可删；上传仍逐个进行，按 SHA-256 复用、`Idempotency-Key`、`Origin`、档位前置全部不动
- [ ] **5.2** `SKILL.md:28` 删「每次上传使用响应中的 `requirementVersion` 续接下一次 expectedVersion」整句；`:30` 删「409 版本冲突」字样，其余排障指引保留
- [ ] **5.3** `docs/01_架构设计/v2-系统架构.md:216`「每次写操作 `version` 递增」→「仅正文（title / summary / status）实变递增；附件增删与产物发布只刷 `updated_at`」。`:215` 项目 PATCH 的乐观锁描述不动

**6. 测试**

- [ ] **6.1** `artifact-version-service.test.ts`：`:64, 72, 135, 186, 193, 212, 239` 去字段、`requirementVersion` 期望改为发布前后不变；删 `:154-164`「过期 expectedVersion 返回 409」；`:305-325` `publishWithVersionRetry` 重试环删掉，`:253`「并行发布」用例直接调 `publish`（六路并发仍要求版本号连续不重复）；补：摘要不含 `expectedVersion`；同 key 同 `attachmentIds + note` 重放返回存量响应且 `updated_at` 不变（不 touch）；同 key 异请求仍 `VALIDATION_ERROR`
- [ ] **6.2** `artifact-version-http.test.ts`：`:94-100, 156, 209, 222, 264` 去字段；`:141-147` `requirementVersion` 期望改为不变；`:181-192` 409 用例改为「body 带过期 `expectedVersion` 与不带该字段的发布**均 201**」（同时钉住 `removeAdditional`）
- [ ] **6.3** `artifact-reference-protection.test.ts:88, 112` 与 `audit-project-id.test.ts:311-335, 421` 去字段；`:322` `requirementVersion = currentVersion + 1` 改为不变；审计 `artifact_version.published.after.requirementVersion` 为当前正文版本
- [ ] **6.4** BFF `http.test.ts:475-500`「代理产物版本列表、发布…原样透传发布字段」：新 body（无字段）与旧 body（带 `expectedVersion: 7`）经 BFF 都 **201**，远端收到 body 原样透传
- [ ] **6.5** `official-artifact-skills.test.ts`：删 `:50` `expectedVersions` 序列断言；夹具 `:236-238` / `:267-268` 不再校验版本，**删 `:256` / `:287` 的 `state.version += 1`**（否则夹具仍在模拟旧语义）；新增断言「新脚本上传不带 `x-requirement-expected-version` 头、发布 body 不含 `expectedVersion`」；保留一条**旧客户端消费序列**用例（按旧脚本行为：从列表响应取版本 → 上传带头 → 从上传响应取 `requirementVersion` 续接 → 发布带 body 字段）打新夹具仍全程成功——它证明的是响应形状仍能被旧消费方消费，不是 Ajv（Ajv 由 6.2 / 6.4 证明）
- [ ] **6.6** web：`requirements-artifacts.test.ts:67-78` builder 用例去字段；`requirements-feedback.test.tsx:306-320`「发布版本冲突…并刷新」改为「发布失败（如 409 非版本类 / 503）只产出对应反馈，**不**触发 `listRequirements` / `getRequirement` 自动刷新」；`:294` 发布成功用例不变
- [ ] **6.7** 补「同正文版本的发布 SSE 仍触发刷新」：`artifact.published` 事件的 `requirementVersion` 等于本地 `version` 时，`refresh()` 与 `openDetail()` 仍被调用（`Workbench:614` 不走 `shouldApplyEvent` 去重，此项是回归钉，不改算法）
- [ ] **6.8** Gate-C：`requirements-service-fixture.ts:289-294` 发布路由删版本校验、**删 `:326` 发布后的 `requirement.version += 1`**；`steps/requirements-board.ts:228` 卡片版本断言由 `"2"` 改为 `"1"`、`:235` 文案 `v2` → `v1`、`:267` 由 `v3` 改为 `v2`（新流程：v1 → 发布仍 v1 → 带外正文 PATCH → v2 → 删附件成功 → 详情 v2）

#### 验收标准

- [ ] 全仓 `grep -rn "expectedVersion" apps packages --include=*.ts --include=*.tsx --include=*.mjs --include=*.md | grep -v /dist/`：**生产代码**（含 skill 脚本与 SKILL.md）只剩项目编辑相关命中（`collaboration-repository.ts` `updateProject`、BFF `:185` 与 `validateExpectedVersion` 本体、contracts `projects.ts` / `schemas.updateProject`、web `Workbench:746`）；**测试代码**只允许项目编辑步骤（`audit-project-id.test`）、旧客户端兼容输入（6.2 / 6.4 旧 body、6.5 旧客户端消费序列）与「不再发送」断言（6.5）——回执分生产 / 测试两栏列出全部剩余命中及用途；不得残留任何版本校验或版本串接逻辑
- [ ] 发布后 `requirements.version` 不变、`updated_at` / `updated_by` 刷新；审计 `artifact_version.published` 与 `comment.created` 照写；SSE `artifact.published` 照发
- [ ] 带过期 / 缺省 `expectedVersion` 的发布均 201（6.2 / 6.4）；旧客户端消费序列全程成功（6.5）
- [ ] 同 `operationKey` 重放不新增记录、不 touch；同 key 异请求仍 `VALIDATION_ERROR`；六路并行发布版本号连续不重复（`lockRequirement` 未动）
- [ ] 新脚本不再发送版本头与 body 字段；`SKILL.md` 不再出现「续接」「409 版本冲突」；`系统架构.md:216` 已改
- [ ] 专项回归：`artifact-reference-protection.test` 两条红线全绿；历史版本全留以既有列表用例为证（`artifact-version-http.test.ts:89`，两版后列表为 `[2, 1]`）；「发布后不可修改」以静态审查为证——`http/server.ts:324-380` 产物版本只有列表 / 发布 / 详情 / 下载四条路由、仓储无修改 / 删除写路径，回执注明「静态验证」，**不为此新增任何生产守卫**；发布失败不提示差异、不自动刷新
- [ ] 四个包测试 + `typecheck` + `lint` 全绿；Gate-C 能跑则跑，跑不了回执写明
- [ ] 回执逐条确认「全片共享约束」1-8 未动，并显式回答「本片未引入新的拒绝式守卫」

#### 边界

- 不清理存量幂等摘要行、不放宽摘要比较、不迁移（升级前 `operationKey` 升级后重试落既有 `VALIDATION_ERROR` 是已知不可达边界：web 与 skill 每次发布都生成新 UUID）
- 不删 `PublishArtifactVersionResult.requirementVersion` / SSE 字段；不改 `lockRequirement`
- skill 只删串接与字段，不重构脚本；不改用户机器上 `~/.codex/skills` 的已安装副本
- 不碰 `updateProject` 相关任何 `expectedVersion`

#### 风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 本片文件最多（5 个 rs 测试 + 集成测试 + Gate-C + skill），最易失控 | 中 | 出现「改 SSE 去重 / 补锁 / 迁移摘要 / 重建测试框架」倾向即停手回抛 |
| 夹具残留 `version += 1` 让集成测试继续模拟旧语义 | 中 | 6.5 / 6.8 明列删除行 |
| skill 去链早于发布校验退役会断 | 高 | 同片落地，本片硬约束 |
| 用户机器上的旧 skill 副本 | 无 | 响应字段保留 + 头忽略 + body 剥离，6.5 覆盖 |

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-9c5e99684c48, subtask-09b88fcd72dc
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-09-06 | 物化任务文档 | 无 | 等待 dispatch 派工 |
| 2026-09-06 | 派工 slot2_codex（job_a8a6afa0eccd）；实施完成，提交 `679a168` | Gate-C 跑了但卡在 doctor 前置未通过 | 进入审查 |
| 2026-09-06 | 审查通过并归档：Claude 独立复跑四包 + typecheck + lint（requirements-service 首轮 audit-project-id hook 超时，重跑 14/55 全绿），回读发布链、skill、Gate-C 与架构文档 diff | **Gate-C 未覆盖**：Codex CLI 在本机无 OpenAI 凭据（doctor `network.websocket_reachability` 401 + DNS 失败），业务步骤未启动 | PR4 派工 |

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
- Section: pr3-artifact-publish-guard-retirement
- Owner: ccb_codex
- Priority: high
- Dependencies: subtask-9c5e99684c48, subtask-09b88fcd72dc
