---
doc_type: dev_task
task_id: subtask-bc0dfe7de7c5
title: pr7 官方发布 / 拉取 skill
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: medium
requirement_id: suduo-v2-pm-requirement-intake-001
section_id: pr7-official-publish-fetch-skills
order: 7
implementation_owner: ccb_codex
dependencies: [subtask-ff50bd246828, subtask-7f83290ffa2d]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-pm-requirement-intake-001.json
source_draft_hash: 5654ce687bb41fee3b28e53498d01f5fcb5d45a3044798f4fb1bdef682d17d88
created_at: 2026-08-21T17:19:54.263Z
updated_at: 2026-08-23T15:26:36.808769Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-pm-requirement-intake-001","branch":"ccb/req-suduo-v2-pm-requirement-intake-001"}
---

# pr7 官方发布 / 拉取 skill

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 两个开箱 skill：发布（先逐个上传再调发布传 attachmentIds）与拉取（按版本拉到指定位置），curl 一律带 Origin 头；档位说明依 pr1 实测结论。 |
| 需求来源 | suduo-v2-pm-requirement-intake-001 |
| 本期范围 | pr7-official-publish-fetch-skills · pr7 官方发布 / 拉取 skill |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### pr7 官方发布 / 拉取 skill

#### 任务概述

PM 在会话里说一句「发上去」，AI 就该把 PRD 那几个文件发成一个新版本；开发说一句「拉已发布的 v2」，AI 就该把那一版的文件放到该放的地方。这片交付两个开箱可用的 skill，把这两句话变成实际动作。

三条关键前提（都不是这片能改的，只能遵守）：

- **不做内建 MCP server**。产物由 skill 与对话控制。skill 调本机 BFF 走的是普通 shell 命令，本来就在现有审批链路里；做成 MCP 反而会注册进用户共享的 `CODEX_HOME` 全局配置（`mcp-service.ts:430` 的 `codex mcp add`），让**所有**会话——包括开发的会话——都看得见这些写工具，而现有三档审批并不覆盖 MCP 写操作。
- **写请求必须自带 Origin 头**。`loopback-guard` 对写方法强制同源，curl POST 不带 `Origin` 会直接 403。这是 CSRF 防护，不放宽。
- **发布是两步**：skill 内部先逐个调既有上传接口（`POST /v2/requirements/:id/attachments`，`Idempotency-Key` 即 attachment id，天然可重试），全部成功后再调发布接口传这批 ID。这两步对 PM 完全不可见。中途失败时已上传的附件停在活跃列表，重试复用同一批 `Idempotency-Key` 不会产生重复附件，也不会留下半个版本。

#### 任务分解

1. **发布 skill**：接收一组本机文件路径与可选变更说明 → 先做 sha256 复用判定 → 逐个上传 → 全部成功后调发布 → 把结果讲清楚（发布了第几版、包含几个文件）。

   **1a. sha256 复用必须在 skill 侧做，服务端不会帮你去重。** 存储的 key 是 `randomUUID()` 派生的（`attachment-storage.ts:100-101`），**不是内容寻址**，服务端也没有任何按 sha256 查重的逻辑。所以"未变文件不重复上传"这条只能这样落：
   ```
   列出该需求的活跃附件（带 sha256）
     └─ 逐个算本机文件的 sha256
          ├─ 命中已有附件 → 直接复用那个 attachment ID，跳过上传
          └─ 未命中        → 才上传
   ```

   **1b. 每次上传后必须用响应里的新版本续接。** 每次附件增删都会递增需求版本（`attachment-repository.ts:207`、`:285`），所以**不能拿同一个 `expectedVersion` 连传 N 个文件**——第 2 个就会 409。做法：用上一次上传响应里返回的 `requirementVersion` 作为下一次的 `expectedVersion`（该响应字段由 pr3 补上），最后一次的版本再传给发布接口。
2. **拉取 skill**：接收需求 ID、版本号（或「最新已发布」）与落点 → 调 `POST /api/v2/artifact-versions/:versionId/fetch` → 报告落盘清单。
3. **两个 skill 的 curl 一律带** `-H 'Origin: http://127.0.0.1:<port>'`。
4. **档位说明**：按 **pr1 的实测结论**，在 skill 文档里写清最低可用档位；若 auto 档不可达，明确写出来并给出替代做法（例如改用需求页 UI 发布）。
5. **失败可读**：上传中途失败、版本冲突 409、文件数超限，三种情况都要给出人能看懂的提示和下一步建议，不要把原始 HTTP 错误直接吐给用户。

#### 验收标准

> 本片验收**全部走 API / BFF 断言，不依赖前端界面**——pr6 与本片同波次并行，界面可能还没做好。界面上的端到端确认放到 pr6 落地后做联合验收，不作为本片的验收门。

- [x] 发布 skill：给三个文件 + 一句说明，能发出一个新版本。用**版本详情接口**断言该版文件清单是这三个文件；用**评论列表接口**断言存在一条带 `artifactVersionId`、body 含这句说明的评论。
- [x] 不填说明时仍能发布，评论列表里仍有一条系统生成的发布评论。
- [x] 拉取 skill：能把指定版本的文件拉到指定位置，落盘清单与版本详情接口返回的清单逐项一致。
- [x] **连传 3 个文件不出现 409** —— 证明版本续接（1b）做对了。
- [x] **未变文件复用**：同样内容再发一版，活跃附件数**不增加**，且新版本引用的是同一批 attachment ID —— 证明 sha256 复用（1a）走的是复用而不是重传。
- [x] **去掉 Origin 头时确实 403** —— 证明 skill 带头这件事是必需的，不是可有可无的装饰。
- [x] 上传中途失败后重试，不产生重复附件、不留下半个版本。
- [x] skill 文档写明最低可用档位，且与 pr1 的实测结论一致。

#### 边界

**不做内建 MCP server，不往用户 Codex 配置注册任何 server。** 不改 BFF 与服务端代码——skill 只是调用方，接口不合用要回头改 pr5，而不是在 skill 里绕过去。不做本机目录整体递归发布（目录遍历、符号链接、重名相对路径、批量预览、失败原子性均属独立范围，本期明确不做）。不规定 PM 或开发的本机目录结构——skill 自己决定读哪个子目录、放到哪里。

#### 依赖与顺序提示

依赖 **pr5**（BFF 端点）与 **pr1**（档位结论）。另外**需要 pr3 已合入**（上传响应返回 `requirementVersion`，1b 靠它；pr3 在第 1 波，早已落地）。

可与 pr6 并行——两者文件集完全不重叠（本片只新增 skill 文件，不改 `client/web`）。本片验收已全部改为 API 级断言，**不依赖 pr6 的界面**，所以不需要声明对 pr6 的依赖。

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-ff50bd246828, subtask-7f83290ffa2d
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-08-21 | 物化任务文档 | 无 | 等待 dispatch 派工 |
| 2026-08-23 | 交付完成，8 条验收全通过 | 模型网关反复掐断长 turn，四次未落地；逐级缩小分块粒度后成功 | 归档 |

## 五、验收标准

- [x] 完成 `spec_section_md` 定义的实现范围。
- [x] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [x] 完成必要验证，并在回执中说明测试命令与结果。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## Materialization Context

- Requirement: suduo-v2-pm-requirement-intake-001
- Section: pr7-official-publish-fetch-skills
- Owner: ccb_codex
- Priority: medium
- Dependencies: subtask-ff50bd246828, subtask-7f83290ffa2d

## 七、验收证据

提交 `a6653ba`。Node v24.10.0。全部走 API / BFF 断言，不依赖前端界面。

| # | 验收项 | 证据（`official-artifact-skills.test.ts`） |
|---|---|---|
| 1 | 三文件 + 说明发出新版本，版本详情与评论可断言 | `uploadedFileCount: 3`、`summary` 含 `v1`、版本详情 3 个文件名匹配、评论列表含带 `artifactVersionId` 且 body 含说明的评论 |
| 2 | 不填说明仍有系统生成发布评论 | 评论列表断言 |
| 3 | 拉取落盘清单与版本详情逐项一致 | `fetchedFiles` 与版本详情 `files` 逐项 `objectContaining` 比对，并逐个读回落盘文件 |
| 4 | 连传 3 文件不出现 409 | `expectedVersions` 断言为 `[1, 2, 3]` —— 直接证明版本续接（1b）成立 |
| 5 | 未变文件复用 | 同内容再发：`reusedFileCount: 3` / `uploadedFileCount: 0`；活跃附件数仍为 3；新版本引用同一批 `attachmentId` —— 证明走的是复用而非重传（1a） |
| 6 | 去掉 Origin 确实 403 | `noOrigin.status === 403`；且断言所有写请求 origin 均等于 BFF baseUrl |
| 7 | 上传中途失败后重试不重复、不留半版本 | 失败后：附件 1 个、版本 0 个；重试后：附件 3 个、版本 1 个；**`failedIdempotencyKey === successfulIdempotencyKey`** —— 证明重试复用同一幂等键 |
| 8 | 文档档位说明与 pr1 一致 | 断言两份 SKILL.md 含「最低可用档位是 **full**」与「没有 loopback 例外」 |

### 交付物

```
client/server/defaults/codex/
├── skill-support/artifact-bff.mjs              共享 BFF 调用层
├── skills/suduo-publish-artifact-version/
│   ├── SKILL.md · agents/openai.yaml · scripts/publish-artifact-version.mjs
└── skills/suduo-fetch-artifact-version/
    ├── SKILL.md · agents/openai.yaml · scripts/fetch-artifact-version.mjs
```

核心实现要点（控制器复核）：
- **档位预检**：`preflightBff()` → `fullModeRequired()`，给可读中文提示说明需 full 档及原因，
  并提示可改用需求页 UI；不把 `curl exit 7` 原文抛给用户。
- **写请求带 Origin**：`artifact-bff.mjs:82`，非 GET 一律带 `Origin: <baseUrl>`。
- **sha256 复用在 skill 侧**：存储 key 由 `randomUUID()` 派生、非内容寻址，服务端无查重逻辑，
  只能由 skill 列活跃附件比对 hash。
- **版本续接**：`expectedVersion = uploaded.requirementVersion` 逐个续接（依赖 pr3 交付的响应字段）。
- **发布幂等键独立**：`operationKey: crypto.randomUUID()`，未照搬附件上传的 `Idempotency-Key`。

### 边界例外（控制器裁决，范围严格限定）

pr7 边界写「不改 BFF 与服务端代码」，但仓库**原本没有投放官方 skill 的机制**：
`server-application.ts:206-212` 从 `CODEX_HOME/skills` 读 skill，而
`codex-home.ts:4` 的 `SEED_FILES` 只有 `config.toml` / `auth.json`，不复制 skills；
Windows 打包同样只处理 config/auth。**没有投放链路，「开箱 skill」这一交付目标不成立。**

裁定该边界条款的本意是「接口不合用要回头改 pr5，不要在 skill 里绕过去」，针对请求/响应逻辑，
不含 skill 自身的投放机制。故允许例外，范围限定为三项：
1. `codex-home.ts` 扩展 `SEED_DIRECTORIES = ["skills", "skill-support"]`，
   **沿用既有「已存在的文件永不覆盖」语义**（用户改过的 skill 不被升级冲掉）——已核实逐项 `existsSync` 判断后 `continue`
2. `dist-win/build.mjs` 同步复制 `defaults/codex/skills`
3. `codex-home.test.ts` 单测

未借此改动任何路由、契约或请求响应逻辑。

### 评审保留意见（不阻断）

8 条验收挤在**一个 368 行的 `it()`** 里。断言本身完整且到位，但失败时无法定位到具体条款。
考虑到该场景本身是顺序依赖的（发布 → 拉取 → 同内容复发 → 失败重试 → Origin → 文档），
拆分并非零成本，且当前模型网关不稳定、额外往返风险高，故接受现状并留痕。
**后续若该用例开始出现偶发失败，应优先拆成 8 个独立 `it()`。**

### 最终验证（控制器独立复跑）
typecheck 四包全 Done；lint exit 0；test **52 files / 246 tests 全通过**。
