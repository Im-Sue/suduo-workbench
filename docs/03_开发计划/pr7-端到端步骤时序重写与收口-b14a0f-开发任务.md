---
doc_type: dev_task
task_id: subtask-5c2bf0b14a0f
title: PR7 · 端到端步骤时序重写与收口
status: done
current_node: archive
node_substate: archived
review_status: passed
runtime_state: completed
priority: medium
requirement_id: cmto2qafxd2362785ef3af281
section_id: pr7-e2e-timing-closeout
order: 7
implementation_owner: ccb_codex
dependencies: [subtask-f8e31dd1346c, subtask-3a7486ba0614, subtask-30823b359683, subtask-193ab77c887b, subtask-7de1feb6fb15, subtask-c3c61bc096a5]
source_breakdown_draft: docs/.ccb/drafts/breakdown/cmto2qafxd2362785ef3af281.json
source_draft_hash: 6698db8fd4565c352d369cc73d82fa36f7c61c2a4da9ec71149d21423606964e
created_at: 2026-09-06T06:44:24.497Z
updated_at: 2026-09-21T15:06:00.417Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-cmto2qafxd2362785ef3af281","branch":"ccb/req-cmto2qafxd2362785ef3af281"}
---

# PR7 · 端到端步骤时序重写与收口

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 逐条核对 gate-c 步骤中「点发送后不等回合结束就继续」的时序依赖并重写；新增归属标记 / 排队 / 停止暂停三条步骤并在 registry 注册；testid 计数与 schema diff 最终核对；全量 gate-c 绿。 |
| 需求来源 | cmto2qafxd2362785ef3af281 |
| 本期范围 | pr7-e2e-timing-closeout · PR7 · 端到端步骤时序重写与收口 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### PR7 · 端到端步骤时序重写与收口

#### 任务概述

前六片各自更新了 testid 基线、保证了各自触碰的 e2e 步骤不红。剩下的是「时序」问题：现有步骤里有直接点发送、以及点发送后不等回合结束就继续的地方，在运行中输入框不再禁用、停止控件移位、归属标记出现之后，这些时序假设可能不再成立。这一片逐条核对并重写，同时新增覆盖本需求核心行为的步骤，最后跑全量。

对应需求：第八章第 5 片、第十三章风险「端到端大面积变红」；技术设计 §五、§十。

#### 任务分解

1. 输入：前六片回执（每片必须附提交 SHA、testid 新旧清单与动态数量变化、交互触发 / 等待条件 / 终态与禁用态变化、测试命令与证据）。缺任一项先回 Claude 补，不自行翻代码猜。
2. 逐条核对 `client/server/test/gate-c/steps/` 中「点发送后不等回合结束就继续」的时序依赖（重点 `assistant-attachment.ts`、`overview-workbench.ts`、`interrupt-and-reopen.ts`、`v2-user-path.ts`），每处标注仍成立 / 需重写，并重写；迭代时用 PR1 的子集入口，最终以全量为准。
3. 新增步骤并在 `steps/registry.ts` 注册，写明每步前置状态与后置状态：运行中发送 → 气泡出现归属标记；排队一条 → 回合结束后自动发出；点停止 → 队列显示已暂停。每条新步骤：用需求服务夹具 / 可控输入建立足够长的运行窗口（Codex 是真实运行时，不靠「数到 10000」这类慢任务碰运气）；按事件 / 状态等待，不用固定 sleep；结束时清理——中断仍在跑的回合、清空队列；排在离开会话路由的步骤之前。
4. `pnpm testid:check` 通过；`testid-baseline.test.ts` 动态 testid 计数与源码一致。
5. `client/codex-protocol` `schema.mjs diff` 最终核对为 clean。
6. 全量 `pnpm gate:c` 跑通，输出通过清单。

#### 验收标准

- `pnpm gate:c` 全绿，含 3 条新增步骤；新步骤在 registry 声明前置 / 后置状态，结束时不留在跑回合与队列项
- 时序依赖核对清单随回执提交（每处：文件 / 行 / 结论 / 改法）
- 不改产品代码——发现缺陷回报 Claude，不自行修，不为让测试通过而放宽断言

#### 边界

不改 `client/web/src` / `client/server/src`；不改视觉基线以外的产品行为。

#### 依赖与 owner

依赖：PR1–PR6 全部。owner：Codex（纯测试工程，与 UI 实施者分离以获得独立验证视角）。

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-f8e31dd1346c, subtask-3a7486ba0614, subtask-30823b359683, subtask-193ab77c887b, subtask-7de1feb6fb15, subtask-c3c61bc096a5
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-09-06 | 物化任务文档 | 无 | 等待 dispatch 派工 |
| 2026-09-21 | 用户裁决 A：FU-1（gate-c 夹具 id 非 UUID，overview-workbench 从未跑绿）并入本片为第 0 项；brief r1 → Codex 协商（job_43d0f3c8ed71）5 点采纳为 r2；派工 Codex 实施 | 无 | 实施 |
| 2026-09-21 | 实施期 Codex 三次因执行环境阻塞停下（doctor：TERM=dumb / CODEX_SQLITE_HOME 透传致 parity 假警 / pnpm store 随 HOME 变化要清空 node_modules），Claude 逐一定位后授权仅命令环境变量（`env -u CODEX_SQLITE_HOME TERM=xterm-256color npm_config_store_dir=…`），未改机器环境与产品 | Codex turn 无法承载长任务，全量 gate-c 改由 Claude 在同一工作区分离执行 | 继续实施 |
| 2026-09-21 | FU-1 通过（overview-workbench 首次跑绿）；探针证明运行中第二条 turn/start 202 且归属 submitted→merged/new-turn；三条新步骤子集绿。全量 gate-c 四次红均为既有套件潜在问题（queue 步骤 hidden 竞态 / 改动面板按会话基线 / 夹具漂移未恢复 / mcp 文案断言过期且失败不清理 / 单会话 seq 连续性假设），全部测试侧修正、未放宽断言、未改产品 | 无产品缺陷 | 全量第 5 次 |
| 2026-09-21 | 全量 `pnpm gate:c` passed（mode full，18 步，flows 10/10）；Codex 写回执并 commit `ec3ba5e`（仅 client/server/test/**）；Claude 审查 pass（3 条轻微备注记为剩余风险）；归档 | 无 | 需求终态判断 → merge-only |

## 五、验收标准

- [ ] 完成 `spec_section_md` 定义的实现范围。
- [ ] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [ ] 完成必要验证，并在回执中说明测试命令与结果。

## 实施回执（2026-09-21 · Codex）

### 改动清单

| 文件 | 改动 |
|---|---|
| `client/server/test/gate-c/requirements-service-fixture.ts` | 远程资源夹具统一为固定 v4 UUID；导出 `GATE_C_FIXTURE_IDS`；保存启动快照并提供 `restoreRequirement()`。 |
| `client/server/test/gate-c/{structure-check.ts,steps/v2-user-path.ts,steps/overview-workbench.ts,steps/requirements-board.ts}` | 同步 UUID 引用；overview 漂移验证后恢复夹具，并回到原 Gate C 会话。 |
| `client/server/test/gate-c/steps/{helpers.ts,attribution-badge.ts,queue-auto-dispatch.ts,stop-pauses-queue.ts}` | 以 skill wait 阶段建立真实运行窗口，新增归属、自动出队、停止暂停三步及收口。 |
| `client/server/test/gate-c/steps/{assistant-approval.ts,assistant-attachment.ts,supervisor-recovery.ts,interrupt-and-reopen.ts}` | 发送后的终态等待；删除 reopen 固定 800ms。 |
| `client/server/test/gate-c/steps/{overview-workbench.ts,mcp-settings.ts}` | 清理跨步骤夹具状态 / Codex MCP 配置；MCP 文案断言对齐现行产品常量语义。 |
| `client/server/test/gate-c/{steps/registry.ts,../gate-c-step-selection.test.ts,real.ts}` | 注册三步与前置闭包测试；结果 flows 增项；账本改验全库连续、单会话严格递增；workflow skill 增加 wait 阶段。 |

### 第 0 项 FU-1

- **结果：通过。** `GATE_C_FIXTURE_IDS` 的 project、需求、附件、评论与产物 id 均为 UUID，避免 requirements-v2 的 `safeSegment` / `format: uuid` 拒绝（`requirements-service-fixture.ts:8-31`）。入口、overview、看板与结构检查引用已同步（`v2-user-path.ts:16-18`、`overview-workbench.ts:27-30`、`requirements-board.ts:175-180`、`structure-check.ts:15-25`）。
- `overview-workbench` 首次跑绿；后半段未发现产品缺陷。步骤内对 `reqDraft1` 的人为漂移已在 `finally` 恢复，避免污染随后看板的标题与 version=1 前提（`overview-workbench.ts:29-48`、`requirements-service-fixture.ts:131-133, 58-59`）。

### 运行窗口探针与新增步骤

- 探针结论：运行中第二次 `turn/start` 返回 HTTP 202；消息先为 `submitted`，服务端回填 clientId 后终态归属为 `merged` 或 `new-turn`，不是永久 submitted（`attribution-badge.ts:12-30`；证据 `attribution-probe-result.json`）。
- 窗口机制：选取 `gate-c-workflow` skill，审批通过后实际执行 `printf 'started' > GATE_C_WAIT_STARTED && sleep 45`；以标记文件和运行态控件同步，不以固定 sleep 断言（`gate-c.real.ts:396-402`、`helpers.ts:62-86`）。
- `attribution-badge`：前置 `v2-user-path`，后置为 wait 回合终态且标记已清理；断言第二次发送的完整归属（`registry.ts:24-31,64-72`、`attribution-badge.ts:8-34`）。
- `queue-auto-dispatch`：前置 `v2-user-path`；排队后按“用户气泡 → 之后 assistant 气泡 → `new-turn` → 新回合终态”收口，断言队列不残留、不暂停并清标记（`queue-auto-dispatch.ts:14-55`）。
- `stop-pauses-queue`：前置 `v2-user-path`；停止后断言 `user_stop`、队列项仍在且文本未发送；终态后删除项、恢复空队列，确保不补发（`stop-pauses-queue.ts:7-40`）。

### 时序核对清单（14 条）

| 文件:行 | 结论 | 改法 |
|---|---|---|
| `assistant-attachment.ts:12-16` | assistant 文本出现不等于回合终态。 | 文本后等待 `interrupt-turn` hidden。 |
| `assistant-approval.ts:13-29` | accept / decline 后直接进入下一阶段会与尾部事件并发。 | approval 卡隐藏后等待终态。 |
| `supervisor-recovery.ts:31-36` | recovery 回复出现后仍可能在运行。 | 回复文本后等待终态。 |
| `interrupt-and-reopen.ts:10-28` | 固定 800ms 不构成会话恢复同步。 | 关闭页后立即按同一路由重开，按卡片 / 控件状态处理。 |
| `v2-user-path.ts:16-52` | 远程路径 id 须满足真实 UUID 契约。 | 用 UUID 常量选择项目并保存路由状态。 |
| `attribution-badge.ts:12-32` | 第二条运行中请求必须证实 clientId 回填及终态归属。 | wait 窗口内发第二条，先验 submitted、再验 merged/new-turn。 |
| `queue-auto-dispatch.ts:23-45` | 有排队项或会立即起新回合时，不能以 `interrupt-turn` hidden 观察上一回合终态：hidden 窗口极短。 | 以出队用户气泡、后续 assistant 气泡和 `new-turn` 归属作为状态事实。 |
| `stop-pauses-queue.ts:10-37` | stop 后不得由尾部自动出队吞掉队首。 | 先验暂停原因和未发送，再清项并恢复空队列。 |
| `overview-workbench.ts:40-48` | changes 面板按会话 baseline 比对；依赖 `GATE_C_ACCEPT.md` 的步骤须与 assistant-approval 同会话。 | requirement session 验证后导航回原 Gate C 会话，未覆盖共享 `context.sessionId`。 |
| `overview-workbench.ts:29-39` | 步骤改动的 fixture 会污染 requirements-board 的既有前置。 | `try/finally` 调 `restoreRequirement()`。 |
| `mcp-settings.ts:20-85` | 步骤在隔离 Codex home 造的配置若失败不清理，会阻塞下一次 doctor。 | `mcp add` 后所有断言置于 `try/finally`，finally remove。 |
| `mcp-settings.ts:48-60` | 旧断言与 491399e 后 `NO_REASON_HINT` 文案脱节。 | 保留“不得编造原因”的意图，匹配“Codex 0.143 未提供”或官方“未找到”。 |
| `gate-c.real.ts:243-274` | `events.seq` 全库自增，多会话交错时单会话连续性不成立。 | 验全库连续无重复，Gate C 单会话仅严格递增。 |
| `registry.ts:24-31,64-72` | 新步骤若未声明前置 / 执行顺序，子集回归无法等价全量。 | 三步置于 changes-and-diff 后、interrupt-and-reopen 前，并显式仅依赖 `v2-user-path`。 |

### 验收判定

| 项目 | 判定 | 证据 |
|---|---|---|
| FU-1：夹具 UUID 与 overview-workbench 复验 | 通过 | UUID 夹具与引用已替换；`fu1-overview-workbench-result.json`。 |
| 任务分解 1：以前六片回执 / 契约为输入 | 通过 | 以 PR1–PR6 已归档交接、spec 与技术设计核对实施。 |
| 任务分解 2：时序依赖核对与重写 | 通过 | 上表 14 条，涉及重点文件及扩展出的 runner / MCP 收口。 |
| 任务分解 3：三条新步骤、前后状态、清理 | 通过 | registry、前置表、新步骤和子集 / 全量结果。 |
| 任务分解 4：testid 计数 | 通过 | `pnpm testid:check`：183。 |
| 任务分解 5：protocol diff | 通过 | `pnpm protocol:diff` clean。 |
| 任务分解 6：全量 gate-c | 通过 | full mode 18 步全绿，flows 10 项均 true。 |
| 验收 1：全量含三条新增步骤、无运行回合 / 队列残留 | 通过 | 全量 `gate:c` gateSteps；各步骤 finally / 删除 / resume 收口。 |
| 验收 2：时序清单随回执 | 通过 | 本回执“时序核对清单”14 条。 |
| 验收 3：不改产品代码、缺陷不自行修 | 通过 | 仅 `client/server/test/**`；本轮未发现需上抛的产品缺陷。 |

### 验证与证据

| 命令 / 项目 | 结果 |
|---|---|
| `pnpm typecheck` | 通过。 |
| `pnpm lint` | 通过。 |
| `pnpm --filter @suduo/client-server test` | 47 files / 217 tests 通过。 |
| `pnpm testid:check` | 通过，183。 |
| `pnpm protocol:diff` | clean。 |
| 全量 `pnpm gate:c` | **通过**；由 Claude 在同一工作区执行（Codex turn 无法承载长任务）。18 步：`v2-user-path, assistant-approval, overview-workbench, assistant-attachment, changes-and-diff, attribution-badge, queue-auto-dispatch, stop-pauses-queue, interrupt-and-reopen, supervisor-recovery, final-interrupt, requirements-board, sessions-rail, settings-shell, settings-codex, mcp-settings, visual-closeout, extension-seam`；flows 10 项全 true，Gate C events 402、全库 seq 1..478 连续、approvals 5。 |

| 证据文件 | SHA256 |
|---|---|
| `attribution-probe-result.json` | `5c6fcddac97106fa11340b68e372b07caf8d99a6dfc68cd58864210b1dec9f7f` |
| `attribution-probe.log` | `300ebb8f86af1500060d5d395ff55dca6cc9c7c168da4f8ffb2e9f6deb6b6190` |
| `fu1-overview-workbench-result.json` | `73c8c03b2ed12bdf59247aa8e4d12f47eb12a45842792bc0c99a4616b013714a` |
| `fu1-overview-workbench.log` | `0d42890151a7b1368cbe3f9ff4e82c5071f294d4e7575e1c31df0f64d31890f9` |
| `gate-c-attempt4-ledger.sqlite` | `63c64e67e3e88ff16b422840441ded27c2c8cc8036de84bb7fe44a9b5e6df203` |
| `gate-c-full-attempt1-fail.log` | `7109b7152d946bee571565a799ffe4f9cb18bb43fc3e170c7558b628b20d19fe` |
| `gate-c-full-attempt2-fail.log` | `aafd0c0f053690c73be4845be3decb0b0670dd72f99d7eee69dbfab50f4ab7d1` |
| `gate-c-full-attempt3-fail.log` | `b11657d4f91b2dc98946075e0d3a435fe619583ee949d80b9f94565ee5582d61` |
| `gate-c-full-attempt4-fail.log` | `ea93fe9e6b1ac4c437d784b39d3822c6e330280d444ef250bf6db19010e6340b` |
| `gate-c-full-result.json` | `af67c80f20abf10713164b73f180db83451a32fae7fb2850b8318c00a359b77b` |
| `gate-c-full.exit` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` |
| `gate-c-full.finished` | `883159acaed30b36df3da10c978ab8c004268dfa5ac8bd0c332ec3152701c56c` |
| `gate-c-full.log` | `2cd2676252749653a3c4c7a15e67b9819c9ed7bbc642b6f3014174c1111ac438` |
| `mcp-settings-retry.log` | `a34e64d5020811bdf2bffa98b1fb1ac79a7325f39ddad5750e878a4b7fda2fd1` |
| `new-steps-retry.log` | `a4531ce32e8b44cb04ea8b3a93c6189450872a68e11093702937c168734f5dbf` |
| `overview-board-retry.log` | `a821e3c86aa7d904724dbf5e8908fa3513387d8ee64001c23439993202653ad9` |
| `overview-changes-retry.log` | `6d3536062e680d87245d4269b719db4f3a7952a3ce166bb67b85bcd8081f31cd` |
| `queue-steps.log` | `651c5545d7928ac7c5d9cfb0099610ba0d50ccd9f33854661a27887278f77a0b` |

### 未验证项与风险

- 三条新增步骤均依赖真实模型执行的 45 秒 wait 窗口；已由全量实跑覆盖，但后续模型 / skill 行为变更仍可能影响耗时与稳定性。
- overview-workbench 在 requirement session 校验后刻意返回 Gate C 会话；下游不再覆盖到需求会话，以保留 changes 基线。需求会话本身不再承载后续步骤。
- 本轮依次暴露并以测试侧修正 4 处既有套件问题：会话基线耦合、fixture 漂移未恢复、MCP 文案过期且失败路径未清理、单会话 seq 连续性假设错误；均未改产品代码或放宽断言。
- Windows 原生环境仍未验证：当前 WSL2 gate-c 结果在 `result.json.windowsNative` 标记为 BLOCKED。

### 提交

- 提交 SHA：`ec3ba5e07c13b90c15fd7eb59eb09112d77f2471`。

## 审查记录（2026-09-21 · Claude）

**Review decision：pass**（无返工）。审查对象：提交 `ec3ba5e`（17 个文件，全部在 `client/server/test/**`；提交内容 = 全量 gate-c 第 5 次实跑的工作区，实跑开始后无测试文件改动）。

- 独立复核（Claude 在 `ec3ba5e` 上执行）：`pnpm typecheck` / `pnpm lint` 通过；`pnpm --filter @suduo/client-server test` 47 文件 / 217 例；`pnpm testid:check` PASS 183；`pnpm protocol:diff` clean；全量 gate-c passed（`gate-c-full.log` sha256 `2cd26762…ac438`、`gate-c-full-result.json` sha256 `af67c80f…b77b`）。
- spec 合理性：任务分解 6 项 + 第 0 项 + 验收 3 条逐项对得上；「可控输入建立运行窗口」以 skill wait 阶段（`GATE_C_WAIT_STARTED` 标记 + `sleep 45`）实现，不靠慢任务碰运气；三条新步骤前置 / 后置 / 清理齐全；时序核对清单 14 条含本轮沉淀的通用结论。
- 边界：未改产品代码、未放宽断言（mcp 文案断言对齐已评审的 `NO_REASON_HINT` 且保留「不得编造原因」意图；runner 账本断言改为全库连续 + 每会话递增，比原单会话假设更严）。ADR-0004：纯测试，无新增拒绝式守卫。
- 轻微备注（不阻塞，记入剩余风险）：① `attribution-badge` 首次观测硬断言 `data-attribution=submitted`，理论上与 app-server 回填 userMessage item 存在竞态（实测 5/5 稳定：命令执行期间 item 在命令结束后才回填）；② `mcp-settings` try 块内缩进未整理，`finally` 里 `mcp remove` 以期望退出码 0 调用，失败时会遮住原始错误；③ `registry.ts` 注释「必须在离开 requirement session 之前」措辞已过期（现回原 Gate C 会话）。

## 归档记录（2026-09-21）

### 完成内容
FU-1：gate-c 夹具远程 id 改 UUID 常量并修正全部引用，`overview-workbench` 自前需求 PR8 起首次跑绿；时序核对 14 条并重写（发送后等终态、删固定等待、会话基线与夹具副作用清理、mcp 失败路径清理、runner 多会话账本断言）；新增 `attribution-badge` / `queue-auto-dispatch` / `stop-pauses-queue` 三条真实运行窗口步骤并登记前置；全量 gate-c 18 步绿。

### 验证证据
见回执「验证与证据」表（SHA256 齐全）；全量由 Claude 在同一工作区执行（Codex turn 无法承载长任务），前 4 次红日志保留为 `gate-c-full-attempt{1..4}-fail.log`。

### 未覆盖 / 剩余风险
1. 三条新步骤各依赖 45s 真实窗口（全量耗时约 +3 分钟）；模型 / skill 行为变化可能影响稳定性。
2. 审查备注 ①②③（见上）。
3. 本片暴露的执行环境事实：CCB agent shell 与人类 shell 的差异（`TERM=dumb`、`CODEX_SQLITE_HOME` 透传、pnpm store 随 HOME）会让 gate-c 的 doctor / 安装阶段误拦；简报「运行环境」一行是 agent shell 里的标准命令。产品侧 follow-up 候选 FU-3：doctor-service 清洗 `CODEX_SQLITE_HOME`、headless 场景 `terminal.env` 非阻断（待用户审）。
4. Windows 原生环境未验证（`result.json.windowsNative` = BLOCKED，既有状态）。

### 交接
- 需求内全部子任务归档后只做 `mergeRequirementWorktree()`，需求保持 delivering，worktree + 分支留给用户预览。
- 待用户审的 follow-up：FU-2（`model-provider-service` 成功文案对已有线程不成立）、FU-3（doctor 环境变量清洗 / headless 非阻断）。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## Materialization Context

- Requirement: cmto2qafxd2362785ef3af281
- Section: pr7-e2e-timing-closeout
- Owner: ccb_codex
- Priority: medium
- Dependencies: subtask-f8e31dd1346c, subtask-3a7486ba0614, subtask-30823b359683, subtask-193ab77c887b, subtask-7de1feb6fb15, subtask-c3c61bc096a5
