---
doc_type: dev_task
task_id: subtask-f8e31dd1346c
title: PR1 · 解除输入封锁：`busy` 拆分与草稿保全（附模型切换器只读前置实测）
status: done
current_node: archive
node_substate: archived
review_status: passed
runtime_state: completed
priority: high
requirement_id: cmto2qafxd2362785ef3af281
section_id: pr1-unblock-composer
order: 1
implementation_owner: claude
dependencies: []
source_breakdown_draft: docs/.ccb/drafts/breakdown/cmto2qafxd2362785ef3af281.json
source_draft_hash: 6698db8fd4565c352d369cc73d82fa36f7c61c2a4da9ec71149d21423606964e
created_at: 2026-09-06T06:44:24.497Z
updated_at: 2026-09-21T06:43:18.365Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-cmto2qafxd2362785ef3af281","branch":"ccb/req-cmto2qafxd2362785ef3af281"}
---

# PR1 · 解除输入封锁：`busy` 拆分与草稿保全（附模型切换器只读前置实测）

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 删掉被发送 / 上传 / 预览 / diff / 审批共用的 `busy` 开关，textarea 只在无会话时禁用；修发送成功后无条件清空草稿的 bug；附带完成模型切换器行为的只读实测（不改文案，结果给 PR4 用）；建 gate-c 步骤子集运行入口供后续各片分片回归。 |
| 需求来源 | cmto2qafxd2362785ef3af281 |
| 本期范围 | pr1-unblock-composer · PR1 · 解除输入封锁：`busy` 拆分与草稿保全（附模型切换器只读前置实测） |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | claude |

## 二、任务分解

### PR1 · 解除输入封锁：`busy` 拆分与草稿保全（附模型切换器只读前置实测）

#### 任务概述

今天只要你点开一个 diff、上传一张图、或者审批卡正在提交，整个输入框就会变灰——因为这五件互不相干的事共用一个 `busy` 开关，而这个开关又直接禁掉了 textarea。这一片把这个开关拆掉：输入框只在「没有会话」时禁用，其它每个动作只管自己的按钮。顺带必须修一个今天被禁用态掩盖的 bug：发送成功后无条件清空输入框，一旦解除禁用，你在等响应期间新打的字会被清掉。

另外趁这一片做一次**只读实测**：运行中切换模型到底会不会中断当前回合。这句提示今天没有代码依据；实测结果决定 PR4 怎么改文案，也决定 PR3 的停止流程要不要考虑「切模型」这条路径——所以必须最早做。

对应需求：R1、4.5『`busy` 拆分』、第七章移交项「模型切换器」；技术设计 §三-5、§四.6、§五实测项。

#### 任务分解

1. `client/web/src/app/SessionRuntime.tsx`：删除 `busy` state（L192）与三处 `setBusy`（L460-512：预览 / diff / 审批链路）；预览 / diff 的加载态改为只作用于右侧抽屉的 `drawerLoading`；去掉向 `Stream`（L634）、`Composer`（L655 `disabled={!session || busy}`、L677 `onBusy`）、`ModelSwitcher`（L665 `disabled={busy}`）的传递。
2. `client/web/src/components/Composer.tsx`：`disabled` 收窄为 `!session`；`sending` 只驱动发送按钮 0ms 忙碌态；新增 `uploading` 只驱动图片按钮；删除 `onBusy` prop（L48、L259/271、L285/300）。
3. `Composer.send()`（L240-275）草稿保全：发送前对 `{ text, skillPath, attachments }` 取快照；成功后只移除快照那一份——文本若已被改动则保留新草稿、附件只移除本次提交的 id、期间完成的上传不受影响；会话切换时在途回调不得作用于新会话。
4. `client/web/src/components/Stream.tsx`：去掉 `busy` prop（L66、L213、L482）；审批卡 `locked` 只用自身 `deciding`（L509）。
5. 单元测试：草稿保全 3 例（在途改写文本 / 在途新增附件 / 切会话在途回调）。
6. **模型切换器只读实测**（不改文案）：明确运行环境（pinned codex 0.143.0、隔离 `CODEX_HOME`）、两种模型配置；在回合运行中切换，记录两个观察点——「当前轮」（是否收到 `turn/completed` / `interrupted`、过程卡是否中断）与「下一轮」（新回合用的是哪个模型）；证据必须是事件日志 / 协议日志 / 界面截图，**不能靠模型自述**。结果写进回执，供 PR4 消费。
7. `data-testid-baseline.json`：本片若新增或移动 testid，同片更新并通过 `pnpm testid:check`。
8. **gate-c 步骤子集入口**（建立入口本身只改测试侧 runner 与前置映射，不碰步骤文件、不碰产品代码）：`client/server/test/gate-c.real.ts:182` 现只能全量跑（`runGateCSteps(gateContext, gateCSteps)`），且末尾强制要求 supervisor 恢复证据与全量收尾断言（route state / runtime pid / 账本连续性）。新增按环境变量（如 `GATE_C_STEPS=final-interrupt,assistant-approval`）筛选步骤的入口。**注意：`GateCStep`（`client/server/test/gate-c/steps/types.ts:28`）只有 `id` 和 `run` 两个字段，步骤自己不声明前置**——不要按「被选步骤声明的前置」实现，那个机制不存在。做法：在测试侧维护一张 `step id → 前置 step id[]` 映射（登录 / 建项目 / 建会话等；与 `client/server/test/gate-c/steps/registry.ts` 放在一处，registry 增删步骤时同步），据此求前置闭包，再**按 registry 数组顺序**执行闭包内的步骤（`runGateCSteps` 本就按数组序执行并累积 `completedSteps`，顺序语义直接复用）。子集模式下跳过 supervisor 证据与仅对全量成立的收尾断言，结束时输出通过清单；不设环境变量时行为与现在完全一致。后续 PR2–PR6 都用它跑本片相关步骤。

#### 验收标准

- 回合运行中 textarea 可输入、可粘贴图片；打开 diff / 预览时输入框不变灰，只有抽屉区域有加载指示
- 发送在途改写文本 → 响应成功后输入框保留新文本；在途上传完成的附件不被清；只清快照那一份
- 审批提交中只禁自身按钮，不影响输入框与模型切换器
- 切会话后，上一会话的在途发送回调不改动新会话的输入框
- `SessionRuntime.tsx` 无共享 `busy` state / `setBusy`；`Composer.tsx` / `Stream.tsx` 无 `busy` / `onBusy` prop 及其传递。`grep -ai busy` 三文件只作辅助核对，注释、`aria-busy` 等合法出现不算失败
- 模型切换器实测记录随回执提交：环境、两种配置、两个观察点各一条证据
- 子集入口 `GATE_C_STEPS=final-interrupt,assistant-approval` 跑通并输出通过清单，且实际执行序列包含 runner 映射算出的前置闭包、顺序与 registry 数组序一致；本片另跑一次全量 `pnpm gate:c` 证明入口未改变全量行为；单测 + `pnpm testid:check` 通过
- 本片产品变更若弄红既有 gate-c 步骤，在本片内修复，并在回执列出改了哪些步骤文件、为什么
- ADR-0004 自查：本片只拿掉禁用，不新增任何拒绝

#### 边界

不加状态行、不加停止控件（PR3）；不改模型切换器文案（PR4）；不动 `/` `@` 补全面板；不动上传链路本身；`EnvPanel.tsx` 自有的局部 `busy` 是它自己的动作态，不在本片范围（PR4 处理其守卫）；gate-c 子集入口：**建立入口本身**只改测试侧 runner 与前置映射，不改步骤文件、不改产品代码；但本片的产品变更（`busy` 拆分 / `disabled` 收窄 / 草稿保全）若把既有 gate-c 步骤弄红，按共享约束「本片修，不留给 PR7」处理，此时允许改相应步骤文件。两条不冲突：禁改指的是「为了做子集入口而改步骤」，不是「为了修本片弄红的步骤而改」。

#### 依赖与 owner

依赖：无。owner：Claude Code（用户 2026-09-05 拍板：UI 实施由 Claude Code 完成）。

## 三、执行顺序 / 里程碑

- 前置依赖: 无
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-09-06 | 物化任务文档 | 无 | 等待 dispatch 派工 |
| 2026-09-06 | 实施完成（8 项分解全做）；单测 / typecheck / lint / build / testid:check / gate-c 子集全绿；模型切换器实测完成 | 全量 `pnpm gate:c` 在 `overview-workbench` 步骤红，经 A/B 对照证明与本片无关（既有服务端挂起） | 一条验收项无法在本片范围内满足，已升级给用户裁决 |
| 2026-09-21 | 用户裁决 A：按子集证据放行；已 commit a32a2f7；Codex 归档完整性协商（job_b06467cbe920）后归档 | 全量 gate-c 顺延 PR7；既有 createRequirementSession 挂起未修 | PR2 开工 |
| 2026-09-21 | PR6 归档后 FU-1 定位（journal `blocker_diagnosed:fu-1`）：不是挂起——`POST /api/v2/requirements/req-draft-1/sessions` 203ms 内返回 409 `VERSION_CONFLICT`「远程需求版本无效」，根因是 gate-c fixture 的远程 id 不是 UUID，与 `RequirementsMaterialService.safeSegment` 及 contracts `format: uuid` 不符；测试夹具问题，非产品缺陷，`overview-workbench` 自前需求 PR8（787d410）起从未跑绿 | 上表「BFF 侧挂起」归因作废，以本行为准 | 修复方案交用户裁决后并入 PR7 或单独 follow-up |

## 五、验收标准

- [ ] 完成 `spec_section_md` 定义的实现范围。
- [ ] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [ ] 完成必要验证，并在回执中说明测试命令与结果。

## 实施回执（2026-09-06 · Claude Code 直接实施）

代码改动落在实施空间 `../SU-CCB-req-cmto2qafxd2362785ef3af281`（分支 `ccb/req-cmto2qafxd2362785ef3af281`，base `f87b7c7`），2026-09-21 已 commit `a32a2f7`。
证据文件：`artifacts/pr1-evidence/`（该目录被 .gitignore 排除，仅本机留存）。

### 改动清单

| 文件 | 改动 |
|---|---|
| `client/web/src/app/SessionRuntime.tsx` | 删共享 `busy` state 与三处 `setBusy`；新增只作用于抽屉的 `drawerLoading` 与抽屉加载占位（`drawer-loading`）；停止向 `Stream` / `Composer` / `ModelSwitcher` 传递 |
| `client/web/src/components/Composer.tsx` | `disabled` 收窄为 `!session`；新增 `uploading` 只驱动图片按钮（`attach-image`）；删 `onBusy`；`send()` 改为发送前取 `{text, skillPath, attachments}` 快照、成功后只移除快照那一份；切会话在途回调守卫 |
| `client/web/src/components/Stream.tsx` | 去掉 `busy` prop 与传递；审批卡 `locked` 只用自身 `deciding` |
| `client/web/src/components/ModelSwitcher.tsx` | `disabled` 改可选（调用方不再传）；未改文案（归 PR4） |
| `client/server/test/gate-c/steps/registry.ts` | 新增 `gateCStepPrerequisites` 前置映射 + `resolveGateCStepSelection` 闭包解析（与 registry 同文件，含一一对应校验） |
| `client/server/test/gate-c.real.ts` | 接入 `GATE_C_STEPS` 子集入口；收尾断言按已跑步骤收窄；`result.json` 增 `mode`/`requestedSteps`，`flows` 改为按实跑步骤如实计算 |
| `client/web/test/composer-draft.test.tsx` | 新增 5 例（草稿保全 3 例 + 输入解禁 2 例） |
| `client/server/test/gate-c-step-selection.test.ts` | 新增 6 例（全量等价 / 闭包 / 传递闭包 / 前置序 / 错名报错 / 映射一一对应） |
| `client/server/test/gate-c/data-testid-baseline.json` | 148 → 150（新增 `drawer-loading`、`attach-image`） |

### 验收逐项判定

| # | 验收项 | 判定 | 证据 |
|---|---|---|---|
| 1 | 回合运行中 textarea 可输入；打开 diff / 预览时输入框不变灰，只有抽屉区有加载指示 | **pass** | `disabled` 收窄为 `!session`；`drawerLoading` 只驱动抽屉槽位；单测「回合运行中 textarea 不禁用」 |
| 2 | 在途改写文本→保留新文本；在途上传的附件不被清；只清快照那一份 | **pass** | `composer-draft.test.tsx` 前两例 |
| 3 | 审批提交中只禁自身按钮 | **pass** | `ApprovalCardView.locked = deciding !== null`；`SessionRuntime.decideApproval` 不再改全局态 |
| 4 | 切会话后上一会话在途回调不改动新会话输入框 | **pass** | `composer-draft.test.tsx` 第三例（`sessionRef` 守卫） |
| 5 | 三文件无共享 `busy` / `onBusy` | **pass** | `grep -n busy` 仅剩注释与 `aria-busy` |
| 6 | 模型切换器实测记录随回执提交（环境、两种配置、两个观察点各一条证据） | **pass（证据已保全，见归档记录 SHA256 表）** | 见下节 |
| 7 | 子集入口跑通并输出通过清单，执行序列含前置闭包、顺序与 registry 数组序一致 | **pass** | `gate-c-subset-pass.log`：plan `["v2-user-path","assistant-approval","final-interrupt"]`，结果 `{"status":"passed","mode":"subset"}` |
| 8 | 本片另跑一次全量 `pnpm gate:c` 证明入口未改变全量行为 | **fail（非本片原因；用户 2026-09-21 裁决 A：接受，顺延 PR7）** | 全量在 `overview-workbench` 红；把本片产品改动 stash 后同一步同一行同样红 → 既有问题，见下节 |
| 9 | 单测 + `pnpm testid:check` 通过 | **pass** | web 35 文件 166 例、server 44 文件 208 例、contracts 3 例全绿；`testid:check` PASS（150） |
| 10 | 本片产品变更若弄红既有 gate-c 步骤，在本片内修复 | **pass（无需修复）** | A/B 对照证明 `overview-workbench` 的红与本片产品变更无关 |
| 11 | ADR-0004 自查：只拿掉禁用，不新增拒绝 | **pass** | 本片净删除 4 处禁用（textarea / 图片按钮的全局态 / 审批卡外部锁 / 模型切换器外部锁），未新增任何拒绝 |

### 第 6 项 · 模型切换器只读实测结果

**运行环境**：pinned `codex-cli 0.143.0`（`node_modules/.bin/codex`）、隔离 `CODEX_HOME`、Node 24.10.0。
**两种模型配置**：`gpt-5.6-terra`（A，切换前）→ `gpt-5.4`（B，切换后）。
**切换方式**：走产品同一条链路 `config/batchWrite`（`reloadUserConfig: true`），与 `ModelProviderService.update` 一致（`expectedVersion` 同样取 user 配置层版本）。
**证据取法**：codex app-server JSON-RPC 协议日志 + 在 codex 与真实上游之间插的只读转发代理所录的出网请求体；每轮 prompt 带唯一 tag，请求按 body 内 tag 归属到回合。**不用模型自述**。

| 观察点 | 结果 | 证据 |
|---|---|---|
| 当前轮 | **不中断**。切换后 8s 内该回合无任何终态通知，回合此后自然 `completed` | `model-switch-probe-report.json` → `observations.currentTurn`；`turn1FinalStatus: "completed"` |
| 下一轮（同一 thread） | **仍用旧模型 A**。切换后同一 thread 的下一个回合，出网请求 `model` 仍是 `gpt-5.6-terra` | 出网请求 `PROBE-TURN-2` → `model: "gpt-5.6-terra"`，`tagsInBody` 证明归属 |
| 下一轮（新建 thread） | **用新模型 B**（`gpt-5.4`） | 出网请求 `PROBE-TURN-3` → `model: "gpt-5.4"` |

**配置确实写进去了**（排除「没保存成功」这个解释）：`config/batchWrite` 返回 `status: ok`；`config/read` 回读 `model = gpt-5.4`；磁盘 `config.toml` 亦为 `model = "gpt-5.4"`。

**给 PR4 的结论**：现有文案「回合进行中，切换会中断当前工作」**与实测不符**（不中断）。同时实测还推翻了一个本片范围外的表述——`model-provider-service.ts` 成功文案「新配置将在下一个回合生效」对**已存在的会话线程不成立**（要新建 thread 才生效）。后者不在 PR4 的改动清单里，作为发现移交 Claude 裁决。

### 第 8 项 · 全量 gate-c 未通过的归因

| 事实 | 证据 |
|---|---|
| 全量 `pnpm gate:c` 在 `overview-workbench.ts:21` 超时（等 `conversation-stream`） | `gate-c-full-fail.log` |
| 把本片全部产品改动（`client/web/src` + testid 基线）`git stash` 后，跑 `GATE_C_STEPS=overview-workbench`，**同一步同一行同样超时** | `gate-c-baseline-without-pr1-fail.log` |
| 服务端 `POST /api/v2/requirements/req-draft-1/sessions` 收到请求后**再无响应日志**，即 BFF 侧挂起 | `journalctl --user -u suduo-gate-c.service` |
| **2026-09-21 更正**：同一请求实为 203ms 内返回 409 `VERSION_CONFLICT`（`ensureRequirementSnapshot` 拒绝非 UUID 的 fixture id `remote-gate-c-project` / `req-draft-1`），「挂起」归因作废；根因在测试夹具，非产品缺陷 | `artifacts/fu1-diagnosis/service-journal.log`（req-3s）、journal `blocker_diagnosed:fu-1` |
| 该步骤不在 PR2–PR6 任何一片要求的子集里 | 各片 spec 的「用 PR1 子集入口跑 X」清单 |

结论：这是既有的服务端挂起，不由本片引入，也不在本片范围内。它**只影响全量 gate-c**（即本片第 8 项与 PR7），不影响 PR2–PR6 的子集验收。

## 归档记录（2026-09-21 · 用户裁决 A 后归档）

**Review decision：pass（用户裁决 A）**。11 条验收 10 pass；第 8 项 fail 由既有阻塞导致（A/B 对照已证与本片无关），用户接受并顺延 PR7。提交：`a32a2f7`（分支 `ccb/req-cmto2qafxd2362785ef3af281`，base `f87b7c7`）。

### 完成内容
- 产品：`SessionRuntime.tsx` 删共享 `busy`、抽屉加载态收窄为 `drawerLoading`；`Composer.tsx` `disabled` 收窄为 `!session`、`sending`/`uploading` 各管各按钮、发送快照只清快照那一份；`Stream.tsx` 审批卡 `locked` 只用自身 `deciding`；`ModelSwitcher.tsx` `disabled` 改可选（文案归 PR4）
- 测试侧：gate-c `GATE_C_STEPS` 子集入口 + 前置闭包映射（`registry.ts` 同文件，含一一对应校验）；子集模式跳过仅全量成立的收尾断言
- 单测：`composer-draft.test.tsx` 5 例、`gate-c-step-selection.test.ts` 6 例；testid 基线 148 → 150（`drawer-loading`、`attach-image`）
- 只读实测（供 PR4）：运行中切模型**不中断当前轮**；同一 thread 下一轮仍用旧模型；新建 thread 才用新模型；配置确已写入

### 验证证据
- web 35 文件 / 166 例、server 44 文件 / 208 例、contracts 3 例全绿；typecheck / lint / build pass；`testid:check` PASS（150）
- gate-c 子集：plan `["v2-user-path","assistant-approval","final-interrupt"]` → `{"status":"passed","mode":"subset"}`
- 全量 gate-c：进入并通过 `v2-user-path`、`assistant-approval`，止于 `overview-workbench.ts:21` 既有挂起；stash 掉本片改动后同一步同一行同样挂

### 证据保全（`artifacts/` 被 .gitignore 排除，仅本机留存；归档时核对无密钥）
| 文件（codeRoot 相对） | SHA256 |
|---|---|
| `artifacts/pr1-evidence/gate-c-baseline-without-pr1-fail.log` | `1587e02d255ff556e0c6a8ae86c87344a8e4be3430745e2c78344855c5620ae9` |
| `artifacts/pr1-evidence/gate-c-full-fail.log` | `4057378ccba7ed50e82150e659f0ea63be7d8ae8e058d1a5e1e0efa295aa0dda` |
| `artifacts/pr1-evidence/gate-c-subset-pass.log` | `ad1e18162ef57cc38a48cf106c50b65f1076a1c6d2e04d034c1316e288e8926b` |
| `artifacts/pr1-evidence/gate-c-subset-result.json` | `e4578f13fe7742c0a88d20669b07bb37575ed49f5e48d3a04039d8227f0b515f` |
| `artifacts/pr1-evidence/model-switch-probe.mjs` | `81a8a31bd0dec22d56b1a7b81bb5805f66e5cf919a03305568a3f93db6537481` |
| `artifacts/pr1-evidence/model-switch-probe-report.json` | `c8e3d1af000d4524c241b700aa8fb89317e63132edd98438815c1bd43ede9e70` |
| `artifacts/pr1-evidence/model-switch-protocol-log.jsonl` | `1ffe3b91165125ea8429831ea007e89cfc08c07da5179cb4447a23f8e092fc53` |

### 未覆盖 / 剩余风险
1. 全量 `pnpm gate:c` 未在本片跑绿。子集入口「不改变全量行为」只有代码级证据（全量模式与 `gateCSteps` 同一数组、单测「全量等价」、全量实跑通过 2 步）；第 7 项只证明子集入口逻辑与选定步骤，**不替代全量验证**，字面证明顺延 PR7。
2. 既有 `createRequirementSession` 挂起（`requirements-v2-service.ts:519` 链路，候选点 resolveLocation / captureAnchor / ensureRequirementSnapshot / withMappingOperation）未修，将原样阻塞 PR7「全量 gate-c 绿」。

### 后续建议（follow-up 提案，均不阻塞 PR2–PR6，待用户裁决）
- **FU-1 修既有挂起**：在 PR7 之前处理，范围外于 7 片；不修则 PR7 必卡。
- **FU-2 模型配置生效语义与成功文案**：实测推翻 `model-provider-service.ts:147-166,211-215` 成功文案「新配置将在下一个回合生效」（已存在线程不成立，需新建 thread）；该文案同时出现在设置页（`CodexGroups.tsx:140-142,362-364`）且覆盖 model / base URL / key / 推理强度多种字段，PR1 只实测了模型切换，不能泛化——建议先补「配置字段 × 已有/新线程」实测矩阵再统一修正；**不并入 PR4**（PR4 只改运行中 ModelSwitcher 警示语）。

### Codex 归档协商（job_b06467cbe920）与反思
- 采纳：证据附保全位置与 SHA256（原 `artifacts/` 被忽略，归档后不可复核）；FU-2 建独立 follow-up 而非记录或塞进 PR4；第 7 项不替代全量的措辞。
- 保留：第 10 项条件验收（A/B 对照足以证明本片未弄红既有步骤）维持 pass。
- 盲点：把「证据在本机」当成「证据可复核」。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## Materialization Context

- Requirement: cmto2qafxd2362785ef3af281
- Section: pr1-unblock-composer
- Owner: claude
- Priority: high
- Dependencies: none
