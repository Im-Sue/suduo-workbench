---
doc_type: dev_task
task_id: subtask-8ec37b1ce287
title: Gate-C 断言改语义定位
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: medium
requirement_id: suduo-v2-feedback-interaction-language-001
section_id: pr8-gatec-semantic-assertions
order: 8
implementation_owner: ccb_codex
dependencies: [subtask-e1a2f5dbb798, subtask-e188722bc768]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-feedback-interaction-language-001.json
source_draft_hash: 02b30b998028de4c87604f4656f338cd76afd80edddf54d47a4a963f5b3ba286
created_at: 2026-08-26T02:49:41.226Z
updated_at: 2026-08-28T07:03:22.326Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-feedback-interaction-language-001","branch":"ccb/req-suduo-v2-feedback-interaction-language-001"}
---

# Gate-C 断言改语义定位

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 把两处以中文文案定位反馈的 Gate-C 断言改为按 data-feedback-kind / data-feedback-result 定位，消除断言与文案的耦合。 |
| 需求来源 | suduo-v2-feedback-interaction-language-001 |
| 本期范围 | pr8-gatec-semantic-assertions · Gate-C 断言改语义定位 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### pr8 Gate-C 断言改语义定位

#### 任务概述

Gate-C 现在有两处断言把「反馈出现了没有」这件事**绑在中文文案上**。用户已拍板允许改既有文案，那这两处就必须同步改成语义定位——否则以后任何一次文案调整都会打断测试。这也顺带消除了一个长期隐患：断言与显示文案耦合本身就脆弱。

**排在最后是因为它有真实依赖**：新属性来自 pr2，被断言的那两个反馈的实际路由结果来自 pr3。前面没落地就改断言，改出来的东西没有意义。

#### 任务分解

1. **`client/server/test/gate-c/steps/requirements-board.ts:202`**
   
   现状：`publisher.getByTestId("global-message").filter({ hasText: "已发布产物版本" }).waitFor()`
   
   改为按 `data-feedback-kind` / `data-feedback-result` 定位（对应 pr3 收口后「发布成功 → success toast」的语义）。

2. **`client/server/test/gate-c/steps/requirements-board.ts:259`**
   
   现状：`main.getByTestId("global-message").filter({ hasText: "需求已被他人改动，请刷新" }).waitFor()`
   
   改为按语义定位（对应 409 `VERSION_CONFLICT` → `global` 错误 toast）。这一处尤其重要——它断言的是**版本冲突**这个特定分支，用文案定位既脆弱又不精确。

3. **保留文案作为辅助断言可以，但不得作为唯一定位手段**（业务规则 N7）。

4. **`assertion-migration.md`** 若记录了断言迁移约定，同步更新。

5. **实跑验证**：跑 `pnpm gate:c` 确认两处断言在真实链路上通过。

#### 验收标准

- [ ] 两处断言不再以中文文案作为唯一定位手段。
- [ ] `pnpm gate:c` **实跑通过**，两处断言在真实链路上验证有效（不是只看代码改对了）。
- [ ] 故意改掉对应的中文文案后，两处断言**仍然通过**——这是本片是否真的解耦了的判据，必须做这一步。
- [ ] 基线漂移检查通过。
- [ ] build / typecheck / lint 通过。

#### 实跑授权（用户 2026-08-24 拍板）

`pnpm gate:c` 会**消耗真实模型调用**（需 `CODEX_HOME` / `SUDUO_CODEX_HOME` 且有可用模型配置）、执行 `systemctl --user enable --now`（脚本使用自有 install-home，不触碰真实部署）、并拉起浏览器。**实施方可自行运行，无需逐次确认**。

#### 边界

**本片独占文件**（outline 的归属矩阵不会随物化进入任务文档，故在此下沉）：`client/server/test/gate-c/steps/requirements-board.ts`（必要时加 `assertion-migration.md`）。

**只改 `client/server/test/gate-c/steps/requirements-board.ts`**（必要时加 `assertion-migration.md`）。不改 `data-testid-baseline.json` 的结构与 checker（pr1 已定稿），不改 `client/web/src` 任何一行，不改其他 Gate-C step 文件，不改夹具 `requirements-service-fixture.ts`。

不顺手迁移其他步骤里按文案定位的断言——本需求只授权这两处。发现别处也有同类问题，记录下来另开，不在本片做。

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-e1a2f5dbb798, subtask-e188722bc768
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-08-26 | 物化任务文档 | 无 | 等待 dispatch 派工 |

## 五、验收标准

- [ ] 完成 `spec_section_md` 定义的实现范围。
- [ ] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [ ] 完成必要验证，并在回执中说明测试命令与结果。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## Materialization Context

- Requirement: suduo-v2-feedback-interaction-language-001
- Section: pr8-gatec-semantic-assertions
- Owner: ccb_codex
- Priority: medium
- Dependencies: subtask-e1a2f5dbb798, subtask-e188722bc768

---

## 审查记录 · 2026-08-28（ccb_claude）

**Review decision: pass** — 归档。commit `f7475e5`。

### ⚠ 责任归属先说清楚

**本片的提交由审查方（ccb_claude）完成，不是执行方。** 执行方 slot4_codex 完成了代码改动后，因 Gate-C 环境阻塞按 brief 要求「验证未全绿不提交」而停止，这个判断是对的。此后的环境根因排查、定向实跑验证、解耦判据执行与最终提交均由审查方完成。不把这段含糊成「执行方完成」。

### 改动

两处按中文文案定位的 Gate-C 断言改为按语义属性定位：

| 位置 | 原 | 现 |
|---|---|---|
| `:202` 发布成功 | `getByTestId("global-message").filter({ hasText: "已发布产物版本" })` | `[data-testid="global-message"][data-feedback-kind="success"][data-feedback-result="global"]` |
| `:260` 附件删除 409 | `.filter({ hasText: "需求已被他人改动，请刷新" })` | `[data-testid="global-message"][data-feedback-kind="version_conflict"][data-feedback-result="global"]` |

`:265` 日志同步；`assertion-migration.md` 记录迁移约定与「文案仅可作辅助断言、不可作唯一定位手段」（业务规则 N7）。

**`version_conflict` 是精确值而非泛化 error 匹配。** 用 `role=alert` 会匹配任何错误 toast，比它替换掉的文案定位**更不精确**——那是退步不是改进。

### 本片的真实定性：不是优化，是修红

派工前审查方实测发现：`:260` 断言的文案「需求已被他人改动，请刷新」**在 `client/web/src` 中已不存在**——pr3 把附件删除的 409 路径改为契约层生成文案后，该断言已必然失败。**pr8 是本批次自己造成的红的收尾**，不是锦上添花。`:202` 的「已发布产物版本」仍是手写文案、当时仍可通过——两处性质不同，brief 已要求分别处理。

### 实跑证据

完整 14 步 Gate-C 套件在本机无法跑完（原因见下），审查方改为**定向实跑**：临时把步骤表缩减为 `v2UserPathStep + requirementsBoardStep`，跑完立即还原。

**依据**：审查方核实 `requirements-board` 步骤只使用 `context.page` / `browserContext` / `origin`，不依赖 `remoteProjectId` / `localProjectId` / `sessionId`，即**不依赖第 2~7 步的任何产物**——它排在第 8 位只是顺序，不是依赖。

**结果（真实浏览器 + 真实服务 + 真实 SSE 事件流）**：

```
[requirements-board] viewport=1440x900 clientWidth=1392 scrollWidth=1392
[requirements-artifacts] SSE 已经由 parseRequirementsEvent 通过并进入 artifact.published 分发；主窗口收到事件后回查详情。
[requirements-artifacts] 附件删除收到 409：收到 version_conflict/global 反馈，详情已自动回查至 v3。
```

第三行是 pr8 自己改的 `:265` 日志，**只有 `:260` 断言成功后才会打印**；`:202` 在同一函数中排在其前，必然亦通过。

### 解耦判据（spec 点名，必须做）

审查方把两处中文文案改为哨兵值——`"已发布产物版本"` → `"文案已被故意改动ABC"`，`version_conflict` 兜底 `"数据已发生变化，请刷新后重试"` → `"文案已被故意改动XYZ"`——重跑定向 Gate-C，**三行日志一字不差照常出现**。断言与文案确已解耦。测试后两处文案均已还原，工作树验证干净。

### 环境阻塞的完整排查（五层，全部与本需求无关）

执行方最初报「provider 请求超时」。审查方逐层证伪与定位：

| 层 | 结论 |
|---|---|
| provider / 凭证 / 配额 | **证伪**。`codex exec` 真实回合成功返回，11,385 tokens |
| Playwright 浏览器缺失 | 属实，**零成本解决**：用户 `~/.cache/ms-playwright` 已有所需的 `chromium_headless_shell-1228`，设 `PLAYWRIGHT_BROWSERS_PATH` 即可，无需下载 |
| `codex app-server` exit=1 | 属实。**CCB 把 agent CODEX_HOME 下的 `logs_2.sqlite` 软链到 `/tmp`，而 gate-c 服务单元 `PrivateTmp=true` 给出空的私有 `/tmp`**，链接悬空致 sqlite state runtime 初始化失败 |
| doctor exit=1 | 属实。审查方 `cp -rL` 复制了运行中 agent 的状态，`state.rollout_db_parity` 判 fail |
| CODEX_HOME 建在 `/tmp` 下 | **审查方自身失误**。发现 `PrivateTmp` 问题后仍把「干净 home」建在 `/tmp`，导致整个路径在服务命名空间不存在 |

最终解法：最小 CODEX_HOME（仅 `config.toml` + `auth.json`，置于 `/tmp` 之外），doctor 实测 exit 0 零 fail。

**仍无法跑完的部分**：第 2 步 `assistant-approval` 要求模型拾取 `gate-c-workflow` skill 并**实际发出需审批的 shell 命令**；codex 自身告警 `Model metadata for gpt-5.6-terra not found. Defaulting to fallback metadata; this can degrade performance and cause issues`。非标准模型的工具调用保真度不足以稳定触发审批卡。**与本批次无关，属环境/模型问题，不计入本片验收，也不因此声称「Gate-C 全绿」。**

### 排查中发现的两项范围外问题

**一、`onStderr` 被定义、被接线、却无人传入。** `stdio-codex-transport.ts` 与 `rpc-connection.ts` 均支持它，但全仓零调用方。`codex app-server` 的 stderr 被读出后直接丢弃，故障现场只剩无信息量的 `RpcConnectionClosedError: ... code=1`。

那条 sqlite 报错**从第一次运行起就一直存在**，只是被扔了；审查方临时接一行转发即刻定位。**这直接解释了执行方为何把根因误报为 provider 超时——它手上确实没有别的线索。** 属服务端范围、不在本需求授权内，未改动，**建议另开一片修（成本一行）**。

**二、pr3/pr4 的 EmptyState 引导动作集体与区块按钮同名。** 见下。

### 本批次回归：EmptyState 同名与绕过前置条件（已修）

定向实跑在 `requirements-board.ts:188` 抓到 `strict mode violation: getByRole('button', { name: '发布新版本' }) resolved to 2 elements`——**该断言在本批次之前是通过的**。

审查方随即全扫 12 个 `EmptyState` 接入点，发现这是**系统性问题而非一处**：

| 组 | 区块按钮 | 空态动作 | 最坏同屏数 |
|---|---|---|---|
| 1 | `DetailPage:277` 发布新版本 | `:287` 同名 | 2 |
| 2 | `DetailPage:219` 编辑需求 | `:240` 同名 | 2 |
| 3 | `DetailPage:387` 选择附件 | `:462` 同名 | 2 |
| 4 | `Board:86` 新建需求 | `:165` 同名 × **4 列** | **5** |
| 5 | `Rail:101` 新建项目会话 | `:128` + `:158` 同名 | **3** |

**第二类缺陷**：5 组中有 4 组的区块按钮带 `disabled` 前置条件（`attachments.length === 0`、`!canCreate`），而**空态动作一个都没有镜像**——用户能在无附件时点「发布新版本」、在 `canCreate` 为 false 时点「新建需求」。此缺陷 Gate-C 抓不到，是审查方扫描时读码发现的。

**用户 2026-08-28 拍板修法**：改空态按钮文案 + 补前置条件；特批解除 pr3/pr4 文件冻结。已由 `5346948 fix(pr3-pr4): align empty-state actions` 修复：文案改为「发布第一个版本」「补充需求说明」「上传第一份材料」、`` 在「${STATUS_LABEL[status]}」列新建需求 ``（7 个状态标签各不相同，一次解决 4 列同名）、「先创建项目会话」/「创建首个项目会话」；前置条件以条件展开镜像（不满足即不渲染动作）。审查方独立复核：**同文件内零重名**。

**根因是审查方的规格缺口**：六片 brief 都强调「空态要有引导动作」，而最自然的写法就是复用区块按钮的文案与 onClick——pr3 与 pr4 各自独立地这么做了。brief 从未提过「引导动作不得与同屏按钮同名，且须继承其前置条件」。此缺陷只有实跑才会暴露：12 处单看都对，错的是「同屏」这个组合关系，单测 / typecheck / lint 全部抓不到。

### 审查方自跑验证（还原全部临时改动之后）

`testid:check` 136 静态 / 12 dynamic、build / typecheck / lint 全 exit 0、contracts 3 / **web 24 files 130 tests** / requirements-service 43 / server 129。工作树干净。

### 边界核查

pr8 提交只含 `steps/requirements-board.ts` 与 `assertion-migration.md`。未改 `data-testid-baseline.json` 结构与 checker、未改 `client/web/src` 任何一行、未改其他 Gate-C step、未动夹具、未迁移其他按文案定位的断言（`requirements-board.ts` 内另有 `:181 :190 :207 :210 :211 :253` 等多处 `hasText`，本需求只授权两处，其余**记录另开、未动**）。

### 审查方临时改动的还原确认

排查期间三处临时改动均已还原并验证：`server-application.ts` 的 `onStderr` 诊断转发、`steps/registry.ts` 的步骤表缩减（已回到 14 步）、两处哨兵文案。临时 CODEX_HOME 三个目录已删除。未改动用户任何服务、配置或系统包。

### 未覆盖

- 完整 14 步 Gate-C 套件未跑通（`assistant-approval` 起，模型工具调用保真度问题，与本需求无关）。
- `requirements-board.ts` 内其余按文案定位的断言未迁移（超出本需求授权）。
