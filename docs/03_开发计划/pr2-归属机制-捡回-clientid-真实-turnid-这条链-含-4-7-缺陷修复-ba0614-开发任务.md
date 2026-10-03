---
doc_type: dev_task
task_id: subtask-3a7486ba0614
title: PR2 · 归属机制：捡回 `clientId → 真实 turnId` 这条链（含 4.7 缺陷修复）
status: done
current_node: archive
node_substate: archived
review_status: passed
runtime_state: completed
priority: high
requirement_id: cmto2qafxd2362785ef3af281
section_id: pr2-attribution
order: 2
implementation_owner: claude
dependencies: [subtask-f8e31dd1346c]
source_breakdown_draft: docs/.ccb/drafts/breakdown/cmto2qafxd2362785ef3af281.json
source_draft_hash: 6698db8fd4565c352d369cc73d82fa36f7c61c2a4da9ec71149d21423606964e
created_at: 2026-09-06T06:44:24.497Z
updated_at: 2026-09-21T07:20:24.348Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-cmto2qafxd2362785ef3af281","branch":"ccb/req-cmto2qafxd2362785ef3af281"}
---

# PR2 · 归属机制：捡回 `clientId → 真实 turnId` 这条链（含 4.7 缺陷修复）

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | reducer 解析 userMessage item 建立 clientId → 真实 turnId 映射并按四条规则给气泡标三态；暴露覆盖所有回合的终态元数据（纯文本回合今天不产出 TurnGroup）；契约回传 clientTurnId；actionTurnId 与两个单值 suggestion 改为按回合保存（修 4.7）。 |
| 需求来源 | cmto2qafxd2362785ef3af281 |
| 本期范围 | pr2-attribution · PR2 · 归属机制：捡回 `clientId → 真实 turnId` 这条链（含 4.7 缺陷修复） |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | claude |

## 二、任务分解

### PR2 · 归属机制：捡回 `clientId → 真实 turnId` 这条链（含 4.7 缺陷修复）

#### 任务概述

你在回合运行中再发一条消息，它其实被塞进了正在跑的那一轮，但界面上它只是又一个普通气泡；更糟的是，界面等的那个回合编号是发送接口返回的「幽灵 id」，永远不会出现在事件流里——所以这条消息对应的附件 / 评论动作卡永远不出现（需求 4.7）。协商中还查出一个同源缺陷：**纯文本、没有任何工具步骤的成功回合，投影里根本不产出 TurnGroup**（`reducer.ts:340` 直接跳过），而动作卡解析恰恰依赖这个列表——所以 Codex 只回一段文字（评论全文正是这种情况）时，动作卡也永远不出现。这一片把 Codex 本来就在事件里报回来的 `item.clientId + 真实 turnId` 捡起来，让气泡能如实说出「这条话去了哪一轮」；同时给**所有**回合（不管有没有过程卡）一份终态元数据，让动作卡和后面的队列都等真实回合。

这是七片里最大的一片，因为它是四个出口共用的机制层；拆开会产生一片没有用户可见价值的纯数据片，所以不拆。

对应需求：4.2、4.7、R3、R4；技术设计 §二、§三-1/2/3、§四.1。

#### 任务分解

1. `client/contracts/src/api.ts`：`SendMessageAccepted`（L156）新增可选字段 `clientTurnId?: string`（加法式）。改后先重建 contracts 包再跑 web / server。
2. `client/server/src/application/message-service.ts`：发送响应回传 `clientTurnId`（L111 已生成，L146-152 返回处补字段）。
3. `client/web/src/event-projection/reducer.ts`：
   - 把 `if (/^usermessage$/i.test(rawType)) continue;` 换成解析——建立 `clientId → 真实 turnId` 映射；`ConversationMessage` 增 `attribution: "submitted" | "merged" | "new-turn"` 与 `interruptedNote: boolean`；按技术设计 §三-3 四条规则**按序求值、命中即停**：① 找不到 item → 已提交；② 所属回合未见 `turn.started` → 已提交；③ 是该回合内 seq 最小的 userMessage item → 已作为新一轮；④ 其余 → 已并入当前工作。回合以 `interrupted` 终止时，归属到它的插入型消息置 `interruptedNote`。
   - **新增覆盖所有回合的元数据**（如 `turnMeta: Map<turnId, { status, sawStart, startedTs, endedTs, endedSeq }>` 或等价结构）：不管有没有 step 都有一条；`endedSeq` = 该回合终态事件的 seq，供 PR5 做出队水位比较（**不用投影全局 `lastSeq` 代替**）；**过程卡列表 `turns` 的显示规则不变**（无 step 仍不出过程卡）。
   - 删除无人消费的顶层 `interrupted` 字段，同步迁移 `client/web/test/reducer.test.ts:72` 的断言。
4. `client/web/src/app/SessionRuntime.tsx`：`actionTurnId` 单值（L194-236）改为 `watchedTurns: Map<turnId, …>`；**`attachmentSuggestion` / `commentSuggestion` 两个单值也按回合保存**，否则连发时结果仍被后到的覆盖；每次发送把解析出的真实 turnId 记入；某 watched 回合按 `turnMeta` 判定终态且拿到完整 assistant 正文时才解析动作卡；HTTP 响应里的 `turnRef.turnId` 只用于诊断，**不参与任何判定**；`watchedTurns` 按 sessionId 清理。
5. `client/web/src/components/Stream.tsx`：用户气泡渲染归属标记（静态 testid）；说明文案原样「已记入当前正在跑的这一轮」；`interruptedNote` 时追加「这一轮被中断，这条可能没被处理到」。
6. 单元测试（reducer）：四条规则各一例；**Codex 反例 `submitted(A) < submitted(B) < started(X)` 必须判成 A=新一轮 / B=并入**；未见 start → 已提交；无 item → 已提交；`interrupted` 终态的插入型消息带限定语；**纯文本无 step 的成功回合在 `turnMeta` 里有 `completed` 记录且 `turns` 仍不含它**；每个终态回合的 `endedSeq` 等于其终态事件 seq；旧格式事件缓存（`cache.ts` 存原始事件）回放后投影正确。
7. 集成测试（整链）：从 normalizer → ingestor / 账本 → SSE 推送与回填响应 → reducer，伪造带 `item.clientId` 的 Codex 通知序列，断言前端拿到的归属正确；**必须覆盖「SSE 先于 HTTP 响应到达」**的次序。只给 reducer 塞事件不算整链。
8. `data-testid-baseline.json` 同片更新并通过 `pnpm testid:check`。

#### 验收标准

- 运行中发送 → 气泡先「已提交」，收到 userMessage item 后变「已并入当前工作」；空闲时发送 → 「已作为新一轮」
- 运行中发送引发的附件 / 评论动作卡在真实回合结束后出现（4.7 缺陷消失）；**Codex 纯文本回复（无工具步骤）的动作卡也能出现**
- 连发两条各自触发动作卡时互不覆盖
- 上述单测 + 整链集成全绿；`reducer.test.ts` 迁移后全绿
- `grep -a` 限 `client/web/src` 无「一定会送到」「正在处理它」等表述
- `client/codex-protocol` `schema.mjs diff` clean；未启用 `turn/steer`
- 历史回放的归属判定与实时一致（判据不依赖 HTTP 响应）
- 本片相关 gate-c 步骤（`assistant-attachment.ts`、`assistant-approval.ts`）+ `pnpm testid:check` 通过

#### 边界

不做队列、不搬卡片（只改追踪与存储结构，不改卡片形态与文案）；不新增协议调用；不加第四种归属状态；不改过程卡显示规则。

#### 执行注意

`reducer.ts` 含 NUL 哨兵 `UNATTACHED_KEY = "\0unattached"`，grep / rg 默认把它当二进制跳过——搜索请用 `grep -a` 或编辑器。

#### 依赖与 owner

依赖：PR1（同文件顺序依赖：SessionRuntime.tsx / Stream.tsx，非语义依赖）。owner：Claude Code；后端两处改动各不到 20 行，与前端消费强耦合，随片完成不另派。

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-f8e31dd1346c
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-09-06 | 物化任务文档 | 无 | 等待 dispatch 派工 |
| 2026-09-21 | 派工（batch-job_ee4847ea8575，owner=Claude Code 直接实施；brief r2 经 Codex job_b06467cbe920 修订） | 无 | 实施 |
| 2026-09-21 | 实施完成并 commit `2ef8fdf`；typecheck / lint / build / 三包单测 / testid:check / protocol:diff / gate-c 子集全绿 | gate-c 首跑因 agent shell HOME 下无 Playwright 浏览器失败（未进服务安装、零成本），设 PLAYWRIGHT_BROWSERS_PATH 后重跑通过 | 送 Codex 审查 |
| 2026-09-21 | Codex 审查（job_5968febf26fb）pass：8 条全 pass（#1/#2 限定 pass）；归档 | 无 | PR3 |

## 五、验收标准

- [ ] 完成 `spec_section_md` 定义的实现范围。
- [ ] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [ ] 完成必要验证，并在回执中说明测试命令与结果。

## 实施回执（2026-09-21 · Claude Code 直接实施）

提交：`2ef8fdf`（分支 `ccb/req-cmto2qafxd2362785ef3af281`，基于 PR1 `a32a2f7`）。证据：`artifacts/pr2-evidence/`（gitignored，本机留存）。
**审 diff 注意**：`reducer.ts` 含 NUL 哨兵，git 把它当二进制——用 `git show --text 2ef8fdf -- client/web/src/event-projection/reducer.ts`。

### 改动清单

| 文件 | 改动 |
|---|---|
| `client/contracts/src/api.ts` | `SendMessageAccepted.clientTurnId?: string`（可选、加法式）；`turnRef` 注释标明运行中可能是幽灵 id、仅诊断 |
| `client/server/src/application/message-service.ts` | 发送响应回传 `clientTurnId`（2 行；路由经 `idempotent()` 原样存/回放 body，无需改路由） |
| `client/web/src/event-projection/reducer.ts` | 循环开头对非空 turnId 建 TurnState（`message.delta` 分支此前在建状态前 `continue`）；userMessage item 分支记 `clientId → turnId`（同 clientId 报到两个回合 = 歧义，整条退回已提交）；`ConversationMessage` 增 `clientTurnId / attribution / interruptedNote`，user 消息 `turnId` 改由映射回填；循环后按 §三-3 四条规则求值（①无 item ②未见 start ③回合内首条 ④其余），`interruptedNote = merged && interrupted`；新增 `TurnMeta` / `projection.turnMeta`（含 `endedSeq` = 终态事件 seq）；删顶层 `interrupted`；`turns` 显示规则不变 |
| `client/web/src/components/observed-attachment-action.ts` | `completedAssistantOutputForAction` 终态改读 `turnMeta`（纯文本回合无过程卡也能解析） |
| `client/web/src/session/watched-turns.ts`（新） | 纯函数：`trackSentMessage`（只记 clientTurnId）→ `reconcileWatchedTurns`（投影解析出真实回合进 watched；终态非 completed 不出卡；completed 且拿到完整正文才解析两种建议）→ `clearWatchedSuggestion`（只清该回合那一种）；不读响应 `turnRef` |
| `client/web/src/app/SessionRuntime.tsx` | 删 `actionTurnId` / `attachmentSuggestion` / `commentSuggestion` 三个单值 → `watchedTurns` 状态；投影变化时 reconcile，`onMessageAccepted` 时立刻用当前投影 reconcile 一次（SSE 先于 HTTP 响应时之后未必再有事件）；两张卡片仍各一个常驻实例、形态文案不动，依 watched 状态的插入顺序（Map 插入序，非真实回合时间线）逐个显示未处理建议，处理完下一个顶上；切会话清空 |
| `client/web/src/components/Stream.tsx` / `styles.css` | 用户气泡 meta 行增归属标记 `message-attribution`（`data-attribution`=submitted/merged/new-turn；文案 已提交 / 已并入当前工作 / 已作为新一轮；merged 时可见小字与 title 均为原样「已记入当前正在跑的这一轮」）；`interruptedNote` 追加 `message-interrupted-note`「这一轮被中断，这条可能没被处理到」 |
| `client/web/test/reducer.test.ts` | 迁移 `:72` 断言（`turnMeta.get("turn-1").status === "interrupted"`）；新增 11 例 |
| `client/web/test/observed-attachment-actions.test.ts` | 伪造投影从 `turns` 迁到 `turnMeta` |
| `client/web/test/watched-turns.test.ts`（新） | 7 例：HTTP 先 / SSE 先（回合已终态才拿到响应）/ 无 clientTurnId 不追踪 / 连发两回合互不覆盖 + 只清一种 / 同回合合并 / interrupted 不出卡 / 无变化返回原对象 |
| `client/server/test/attribution-chain.test.ts`（新）+ `fixtures/attribution-chain.events.json`（新） | 整链：真实 HTTP（listen 0）POST A → Codex 通知经 `normalizeCodexNotification` → ingestor → 账本；POST B 时 `startTurn` 挂起，从回填端点等到 `message.submitted` 入账拿 clientTurnId，注入 B 的 userMessage item + 纯文本 agentMessage + `turn/completed`，**从真实 SSE 连接读到 turn.completed 时 B 的 HTTP 仍未响应**；放行后 202 且 `clientTurnId` 等于入账值、`turnRef` 是幽灵 id 且从未出现在流里；回填与 SSE 两条路径的事件（去动态字段后）与 fixture 完全一致。`ATTRIBUTION_FIXTURE=write` 可重生成 |
| `client/server/test/gate-c/data-testid-baseline.json` | 150 → 152（`message-attribution`、`message-interrupted-note`，均静态；动态计数仍 17） |
| `eslint.config.js` | ignores 补 `artifacts/**`——**spec 外的工具侧改动**：PR1 留在 `artifacts/pr1-evidence/` 的探针脚本让 `pnpm lint` 必红，与既有「与 .gitignore 对齐」注释同理；审查可否决，否决则改为验收命令加 `--ignore-pattern` |

### 验收逐项判定

| # | 验收项 | 判定 | 证据 |
|---|---|---|---|
| 1 | 运行中发送 → 先「已提交」，收到 userMessage item 后「已并入当前工作」；空闲时发送 → 「已作为新一轮」 | **pass（逻辑层 + 渲染）** | reducer 规则 ③/④ 用例、Codex 反例用例、整链 fixture 用例（A=new-turn / B=merged）；Stream 标记与文案；浏览器手工核对未做，PR7 新增步骤覆盖 |
| 2 | 运行中发送引发的动作卡在真实回合结束后出现；纯文本回复的动作卡也能出现 | **pass（逻辑层）** | watched-turns 「HTTP 先」「SSE 先」两例；`completedAssistantOutputForAction` 改读 turnMeta；reducer「纯文本无 step 成功回合 turnMeta completed 且 turns 不含」；SessionRuntime 接线无组件级测试（unknown 部分：接线只靠 typecheck + 读码） |
| 3 | 连发两条各自触发动作卡时互不覆盖 | **pass** | 按回合各存各的（`watched-turns.test.ts` 「连发两条落进两个不同回合」）；卡片一次只显示一个，依状态插入顺序逐个显示，处理完下一个顶上，不丢 |
| 4 | 单测 + 整链集成全绿；`reducer.test.ts` 迁移后全绿 | **pass** | web 36 文件 / 184 例、server 45 文件 / 209 例、contracts 3 例；typecheck / lint / build 全过 |
| 5 | `client/web/src` 无「一定会送到」「正在处理它」等表述 | **pass** | `grep -a -rn` 五种表述为空 |
| 6 | `client/codex-protocol` schema diff clean；未启用 `turn/steer` | **pass** | `pnpm protocol:diff` → `{"status":"clean","codexVersion":"0.143.0","files":1005}`；`grep turn/steer client/server/src client/web/src` 为空 |
| 7 | 历史回放的归属判定与实时一致（判据不依赖 HTTP 响应） | **pass** | reducer 是纯函数，fixture 用例断言逆序输入同一判定；整链用例证明 SSE 先于 HTTP 且幽灵 turnRef 未参与；回填端点只滤两种 delta，item.* 保留（`event-repository.ts:163`） |
| 8 | gate-c `assistant-attachment` / `assistant-approval` + `testid:check` 通过 | **pass** | 子集 plan `["v2-user-path","assistant-approval","assistant-attachment"]` → `{"status":"passed","mode":"subset"}`；`testid:check` PASS（152） |

### 验证命令与结果

| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm --filter @suduo/client-contracts build` | Done | — |
| `pnpm typecheck` | contracts / requirements-service / server（`tsconfig.test.json`，rootDir=.）/ web 全 Done | — |
| `pnpm lint` | 0 problems（加 `artifacts/**` ignore 前：本文件 2 处 `_input` 未用已改；PR1 探针脚本 1 处） | — |
| `pnpm build` | 全部 Done | — |
| `pnpm --filter @suduo/web test` | 36 files / 184 tests pass | — |
| `pnpm --filter @suduo/client-server test` | 45 files / 209 tests pass | — |
| `pnpm --filter @suduo/client-contracts test` | 3 pass | — |
| `pnpm testid:baseline && pnpm testid:check` | PASS 152 static / 17 dynamic | — |
| `pnpm protocol:diff` | clean | — |
| `GATE_C_STEPS=assistant-attachment,assistant-approval pnpm gate:c` | passed（subset） | `artifacts/pr2-evidence/gate-c-subset.log` sha256 `d0a740ff…b71b`；`gate-c-subset-result.json` sha256 `184adabc…2efc3` |

gate-c 环境：Node 24.10.0；隔离 `SUDUO_CODEX_HOME=/home/sue/dev/.codex-gate-c-3af281`；`PLAYWRIGHT_BROWSERS_PATH=/home/sue/.cache/ms-playwright`（CCB agent shell 的 HOME 是 provider-state 目录，首跑在装服务前就因找不到浏览器退出，零模型成本）；代理经 `systemctl --user set-environment` 注入、跑完 `unset-environment` 已撤销；`suduo-gate-c.service` 跑完为 inactive。

### 未验证项 / 风险
- 浏览器内手工 E2E 未做：归属标记出现、动作卡在真实回合终态出现，本片只到单测 + 纯函数 + 整链事件形状；端到端由 PR7 新步骤「运行中发送 → 气泡出现归属标记」覆盖。
- 两张卡片仍是单实例：多回合建议依状态插入顺序逐个显示（不丢不覆盖；插入序 ≠ 真实回合时间线），下沉到消息流锚 assistant 消息时按消息/回合锚点重定序，归 PR6。
- `turnMeta` 现在也会收录只见过 `message.delta` 的回合（status partial）；`turns` 过程卡规则不变。
- 范围外改动 1 处：`eslint.config.js` ignores（见改动清单）。

## 归档记录（2026-09-21）

**Review decision：pass**（Codex 协商 job_5968febf26fb 同判 pass；Codex 以 Node 24.10 独立复跑 `attribution-chain.test.ts` 与 web 36/184 通过）。提交：`2ef8fdf`。

### 完成内容
契约回传 `clientTurnId`；reducer 建 `clientId → 真实 turnId` 映射并按四条规则给气泡标三态（歧义退回已提交）；覆盖所有回合的 `turnMeta`（含 `endedSeq` 供 PR5 出队水位）；动作卡追踪改按真实回合（`session/watched-turns.ts`），终态看 `turnMeta`——4.7 缺陷与「纯文本回合不出卡」的同源缺陷一并消失；气泡归属标记 + 中断限定语。

### 验证证据
typecheck / lint / build 全过；web 36 文件 184 例、server 45 文件 209 例、contracts 3 例；`testid:check` 152；`protocol:diff` clean；gate-c 子集 `v2-user-path → assistant-approval → assistant-attachment` passed。

| 证据（codeRoot 相对，gitignored，仅本机） | SHA256 |
|---|---|
| `artifacts/pr2-evidence/gate-c-subset.log` | `d0a740ff63121132ba7d831a0ea07ba8e3e28435d4eba38b6da1b1146697b71b` |
| `artifacts/pr2-evidence/gate-c-subset-result.json` | `184adabc0afecde863689c92dbf03bb60dafbeb8a37bea65fe0021eebf92efc3` |

### 未覆盖 / 剩余风险
1. 浏览器呈现未独立证明：验收 #1/#2 是逻辑 + 链路层的限定 pass，SessionRuntime 接线无组件级测试；PR7 新增步骤「运行中发送 → 气泡出现归属标记」覆盖，并建议顺带补一个 SessionRuntime 组合用例（渲染标记 + HTTP 迟到后出卡）。
2. 单卡显示顺序 = watched Map 插入顺序，不是真实回合时间线；PR6 下沉到 assistant 消息时按消息/回合锚点重定序。
3. `turnMeta` 会收录只见过 `message.delta` 的回合（status partial、sawStart=false）：PR3 计时锚点只能认 `sawStart`（且要 `stream.live` 之后的实时 start），不能把 partial 当运行中。
4. 范围外工具改动：`eslint.config.js` ignores + `artifacts/**`（Codex 判必要、低风险）。

### 后续建议
- PR5 直接消费 `turnMeta.endedSeq` 做出队水位，不用投影全局 `lastSeq`。
- PR6 用 `watchedTurns` 的按回合结果作为动作卡锚点数据源，重定序后再渲染。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## Materialization Context

- Requirement: cmto2qafxd2362785ef3af281
- Section: pr2-attribution
- Owner: claude
- Priority: high
- Dependencies: subtask-f8e31dd1346c
