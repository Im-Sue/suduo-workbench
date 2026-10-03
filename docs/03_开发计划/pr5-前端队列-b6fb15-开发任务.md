---
doc_type: dev_task
task_id: subtask-7de1feb6fb15
title: PR5 · 前端队列
status: done
current_node: archive
node_substate: archived
review_status: passed
runtime_state: completed
priority: high
requirement_id: cmto2qafxd2362785ef3af281
section_id: pr5-frontend-queue
order: 5
implementation_owner: claude
dependencies: [subtask-3a7486ba0614, subtask-30823b359683, subtask-193ab77c887b]
source_breakdown_draft: docs/.ccb/drafts/breakdown/cmto2qafxd2362785ef3af281.json
source_draft_hash: 6698db8fd4565c352d369cc73d82fa36f7c61c2a4da9ec71149d21423606964e
created_at: 2026-09-06T06:44:24.497Z
updated_at: 2026-09-21T09:05:40.992Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-cmto2qafxd2362785ef3af281","branch":"ccb/req-cmto2qafxd2362785ef3af281"}
---

# PR5 · 前端队列

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | queue.ts 状态机 + sessionStorage；Composer 队列布局、排队按钮与 Tab；一个真实回合终态只取一项；停止瞬间 / 失败 / 不确定 / 刷新 → paused；发送结果三分：证实未受理才回队首，结果不确定与归属未证实都不回队、不自动重发。 |
| 需求来源 | cmto2qafxd2362785ef3af281 |
| 本期范围 | pr5-frontend-queue · PR5 · 前端队列 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | claude |

## 二、任务分解

### PR5 · 前端队列

#### 任务概述

想到第三件事但不想打断 Codex，按「排队」把它排进队列，列在输入框上方，能改能删能取回；当前回合正常结束后自动发出队首一条，等这一条落进的真实回合结束再取下一条。你点了停止、回合失败、或者系统说不准那条话去了哪儿——队列就停在那儿等你，绝不自作主张继续发。只在当前标签页有效，界面上说清楚。

对应需求：4.3、R5、R6、第九章数据、第十三章风险「队列重复执行」；技术设计 §四.2、§六。

#### 任务分解

1. `client/web/src/session/queue.ts`（新建）：状态机纯函数（`idle / waiting / dispatch / paused`）+ `sessionStorage` 读写，键 `suduo.session.queue:<sessionId>`，形状 `{ items: [{ id, text, skillPath?, attachmentIds[] }], status, pausedReason? }`。
2. 出队节拍：出队时记录 `awaitingTurnId`（归属解析出的真实 turnId）与当时的投影水位 `dequeueSeq`；只有**该 turnId** 在 `turnMeta` 里到达终态、且其终态事件 `endedSeq > dequeueSeq` 才取下一项；不用投影全局 `lastSeq` 代替目标回合的终态 seq，不看 HTTP 响应的 turnId。
3. **在途项与恢复语义**（Claude 裁定，依据需求 4.3「不确定就暂停不重试」与 ADR-0004「人仲裁」）：
   - 出队即视为已发送：项离开队列进入「在途」，气泡按 4.1 立即上屏标「已提交」。
   - 发送结果三分。① **证实未受理**（HTTP 明确拒绝且服务端未入账，如 4xx 校验失败 / 会话不存在）→ 该项**回到队首**，`paused`，理由「发送失败」。② **结果不确定**（断网、超时、5xx、「启动 turn 的结果不确定」）→ `paused`，理由「这一条发没发出去还不确定」，在途内容留在队列区标「待核对」（可取回输入框或删除），**不自动回队重发**——`message-service.ts:112-144` 先入账 `message.submitted` 再启动 turn，HTTP 失败不等于未发送，气泡可能稍后出现，「没看见气泡」不能当「未发送」。③ HTTP 成功但 **10s 归属等待期限**内未拿到真实 turnId（实测 `item/started` 同秒到达，10s 是十倍余量）→ `paused`，理由「这一条去了哪儿还没确认」，`awaitingTurnId` 清空，在途项**不回队列、不重发**——它在消息流里看得见，用户可自行处理。10s 是归属等待期限，不是新增的 loading 反馈阈值，不得用作任何用户反馈时序（R10 只约束反馈时序）。
   - 「恢复」只把状态置回 `waiting`；出队仍受「无回合在跑（`runningTurnIds` 为空）且 `awaitingTurnId=null`」约束；**任何情况下恢复都不自动重发已出现在消息流里的项**。
4. 暂停触发：用户点停止的**瞬间**（不等完成事件）、回合 `failed | interrupted`、上述证实未受理 / 结果不确定 / 归属未证实、页面刷新恢复 → `paused`，理由如实显示；提供「恢复」动作。等待审批不产生终态事件，自然不出队。
5. `client/web/src/components/Composer.tsx`：**本片自带队列布局**（输入框上方、状态行之上）；次级按钮「排队」为主入口；`Tab` 仅在补全面板关闭且有回合在跑时生效（面板打开时 `Tab` 仍是接受候选）；每项可编辑 / 删除 / 取回输入框；界面明示「仅本标签页有效」。
6. `client/web/src/app/SessionRuntime.tsx`：队列宿主状态与出队触发；`SessionsWorkbench` 以 `key=sessionId` 重挂 Runtime，切会话即卸载，队列从 `sessionStorage` 按 `sessionId` 重建，因此切回必为 `paused`（**不清空**——清空等于毁掉用户已写的字）。
7. 单元测试（状态机，9 条）：出队仅在无运行回合且 `awaitingTurnId=null`；只认 `awaitingTurnId` 的终态且 `endedSeq > dequeueSeq`；回放旧终态不推进；刷新恢复必为 `paused`；切会话不丢项；停止瞬间即 `paused`；证实未受理项回队首；结果不确定项不回队、标待核对、恢复后不重发；归属超时项不回队且恢复后不重发。
8. testid：队列项用静态 testid + `data-index`，**不用模板串**（`testid-baseline.test.ts:37` 硬编码动态 testid 数 17）；`data-testid-baseline.json` 同片更新并通过 `pnpm testid:check`。

#### 验收标准

- 排队 → 队列显示在输入框上方 → 回合正常结束后队首自动发出 → 等该条真实回合终态再取下一条（一个终态只取一项）
- 点停止 / 回合失败 / 证实未受理 / 结果不确定 / 归属未证实 → 队列显示「已暂停」+ 对应理由 + 恢复动作，不自动发
- 恢复后：证实未受理的项重新发出；结果不确定的项留在队列区待核对、不自动发；归属未证实的项不再发出、也不在队列里
- 刷新页面 → 队列项仍在且为 `paused`；切会话再切回 → 队列项仍在且为 `paused`
- 补全面板打开时 `Tab` 仍接受候选
- 上述 9 条单测全绿；`pnpm testid:check` 通过；用 PR1 子集入口跑 `final-interrupt` 通过
- 隐私：队列文本只进 `sessionStorage`，关页即失效，不外发

#### 边界

不做后端队列、跨标签页、跨设备；不动补全面板既有 `Tab` 行为；不做队列项拖拽排序（需求未要求）；不为队列改动态 testid 计数。

#### 依赖与 owner

依赖：PR2（出队节拍依赖 `turnMeta` 与真实 turnId）、PR3（停止瞬间暂停依赖 `stopping`）、PR4（线性顺序：与 PR4 共享 SessionRuntime 宿主状态）。owner：Claude Code。

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-3a7486ba0614, subtask-30823b359683, subtask-193ab77c887b
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-09-06 | 物化任务文档 | 无 | 等待 dispatch 派工 |
| 2026-09-21 | 进入派工：brief r1（base b10af03），送 Codex 执行者视角协商 | 无 | 协商后实施 |
| 2026-09-21 | Codex 协商（job_e036fb2155c3）四项必改采纳为 brief r2；派工 | 无 | 实施 |
| 2026-09-21 | 实施完成并 commit `94497ba`；typecheck / lint / build / 三包单测 / testid:check / protocol:diff / gate-c 子集（final-interrupt，跑于 94497ba）全绿 | 无 | 送 Codex 审查 |
| 2026-09-21 | Codex 审查（job_41d61502ff12）request changes：①skill 队列只存路径、出队靠当时 skills 列表，刷新重建/未加载时丢 skill（#1 fail）②只剩待核对 / 队列为空时恢复按钮被隐藏（#2 fail）。返工 `215b0ed`（片内第 1 轮）：持久化 skill name + 所有暂停态都渲染恢复 + 5 例；gate-c final-interrupt 在 215b0ed 重跑 passed | 无 | 送复审 |
| 2026-09-21 | Codex 复审（job_4af7e8c64f3c）pass：7/7；归档 | 无 | PR6 |

## 五、验收标准

- [ ] 完成 `spec_section_md` 定义的实现范围。
- [ ] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [ ] 完成必要验证，并在回执中说明测试命令与结果。

## 实施回执（2026-09-21 · Claude Code 直接实施）

提交：`94497ba` + 返工 `215b0ed`（基于 PR4 `b10af03`）。证据：`artifacts/pr5-evidence/`（gitignored，本机留存；gate-c 在两个 SHA 上各跑一次、工作区干净）。

### 改动清单

| 文件 | 改动 |
|---|---|
| `client/web/src/session/queue.ts`（新） | **返工 `215b0ed`：`QueueItem.skill?: { name, path }`（原只存 `skillPath`）**，`loadQueue` 校验并保留；状态机纯函数：`enqueue / removeItem / updateItem / takeItem / pause / resume / canDispatch / beginDispatch / onSendAccepted / onSendRejected / onSendUncertain / reconcile`；存储 `loadQueue / saveQueue`（键 `suduo.session.queue:<sessionId>`，形状 `{ items, status, pausedReason? }`，item 多一个可选 `unconfirmed` 标「待核对」；有项即恢复 paused/restored，不清空；inflight 不持久化）；`classifySendFailure`（只有 `ApiClientError` 4xx 且 code≠`IDEMPOTENCY_INDETERMINATE` 为证实未受理，其余一律不确定）；`buildMessageContent`（与 Composer 共用）；`ATTRIBUTION_DEADLINE_MS=10_000`（归属等待期限，非反馈时序）；`PAUSED_REASON_TEXT` |
| `client/web/src/app/SessionRuntime.tsx` | 队列宿主：`useState(() => loadQueue(sessionId))` + 变化即 `saveQueue`；投影变化与每秒 tick 各跑 `reconcile`（tick 条件扩到 inflight 期间）；出队单飞（`canDispatch` 布尔为 effect 唯一依赖，`beginDispatch` 置 inflight 挡重入 + `dispatchingRef` 守卫，请求在 effect 体内发）；accepted 后立刻用当前投影对账并 `trackSentMessage`；失败按分类；`stopTurn` 里与 `setStopping` 同一处 `pause("user_stop")`（含失配分支）；Composer 收到 `queue` 视图与动作；**返工：`sendQueued` 直接用项内 `skill` 组装，不再依赖 `skills` 列表；内容为空兜底放回队首** |
| `client/web/src/components/Composer.tsx` / `styles.css` | 附件草稿改本地 `DraftAttachment { id; size? }`（上传结果映射，不伪造 AttachmentDto；无大小时 chip 只显示「图片」）；`send()` 改用 `buildMessageContent`；队列面板 `QueuePanel`（状态行之上；标题「排队 · 仅本标签页有效」；每项静态 testid + `data-index`，编辑（行内 textarea）/ 删除 / 取回输入框；待核对 `data-unconfirmed`；暂停 `queue-paused` + 理由 + `queue-resume`——**返工：所有暂停态都渲染恢复入口**，无可发项时恢复只解除暂停）；`QueueDraft.skill` 带 name+path；`comp-bar` 次级按钮 `queue-message`「排队」（running/approval 且 canSend）；`onKeyDown` 在 palette 分支之后加 Tab 分支（非 IME、非 Shift、运行中、canSend）；入队只清草稿那一份 |
| `client/web/test/queue.test.ts`（新） | 17 例（返工 +2：resume 无可发项 / skill 项持久化后组装）：spec 第 7 项 9 条逐条 + seenSeq 基线（历史 failed 不盖 restored）+ 非队列回合失败暂停 / 审批不出队 + accepted 即时归属 + 编辑删除取回 + 分类 9 断言 + 内容组装 |
| `client/web/test/composer-queue.test.tsx`（新） | 6 例（返工 +2：skill 入队带 name / 各暂停态都有恢复且恢复不发送）：排队按钮入队并只清一份、空闲无入口；面板关闭 Tab 入队 / 面板打开 Tab 接受候选不入队；空闲 Tab 不入队；面板列项与 data-index、待核对、暂停理由 + 恢复、删除 / 编辑 / 取回填回输入框（skill 回选、附件无大小 chip） |
| `client/web/test/session-runtime-queue.test.tsx`（新） | 4 例（桩式 EventSource；返工 +1：skills 列表为空时恢复出队仍带入队时的 skill、不发空内容）：两项入队 → T1 completed 只发第一条 → 入账 + 归属到 T2 + T2 运行中不发 → T2 completed 才发第二条；`api.interrupt` 悬挂、点停止**立即** `queue-paused`（user_stop），随后 interrupted 终态到达也不出队；sessionStorage 重建为 paused/restored |
| `client/server/test/gate-c/data-testid-baseline.json` | 159 → 167（8 个 queue-* 静态 testid）；动态计数仍 17 |

### 验收逐项判定

| # | 验收项 | 判定 | 证据 |
|---|---|---|---|
| 1 | 排队 → 队列显示在输入框上方 → 回合正常结束后队首自动发出 → 等该条真实回合终态再取下一条（一个终态只取一项） | **pass（首审 skill 项 fail → 返工后 pass）** | `session-runtime-queue` 第 1 例（两项、两次真实终态、两次 send）；`queue.test` 1–3 |
| 2 | 点停止 / 回合失败 / 证实未受理 / 结果不确定 / 归属未证实 → 显示「已暂停」+ 理由 + 恢复，不自动发 | **pass（首审恢复入口 fail → 返工后 pass）** | `queue.test` 6–9 + 补充「非队列回合失败暂停」；Runtime 停止用例；面板 `queue-paused` 文案与 `queue-resume` |
| 3 | 恢复后：证实未受理的项重新发出；结果不确定的留在队列区待核对不自动发；归属未证实的不再发出也不在队列 | **pass** | `queue.test` 7 / 8 / 9 |
| 4 | 刷新 → 队列项仍在且 paused；切会话再切回 → 仍在且 paused | **pass** | `queue.test` 4 / 5；Runtime 第 3 例（sessionStorage 重建 restored）；切会话 = key 重挂 = 同一条重建路径 |
| 5 | 补全面板打开时 Tab 仍接受候选 | **pass** | `composer-queue` 第 2 例（"/rev" 打开面板后 Tab → onSkillPath，不入队） |
| 6 | 9 条单测全绿；`testid:check` 通过；子集跑 `final-interrupt` 通过 | **pass** | web 45 文件 / 230 例；testid 167；gate-c plan `["v2-user-path","final-interrupt"]` → passed |
| 7 | 隐私：队列文本只进 sessionStorage，关页即失效，不外发 | **pass** | `saveQueue` 只写 sessionStorage；无网络调用；读码 |

### 验证命令与结果
typecheck（4 包）/ lint（0）/ build 全过；web 45 文件 / 235 例（返工后）、server 47 / 216、contracts 3；testid 167；protocol clean；禁用表述 grep 为空；gate-c 子集在 `94497ba` 与最终 `215b0ed` 各 passed。

| 证据（codeRoot 相对，gitignored） | SHA256 |
|---|---|
| `artifacts/pr5-evidence/gate-c-subset.log` | `0a9908bc37168c978d388db3c1ddec74b7c4397f1cd53a5445b7d49e8d229a3b` |
| `artifacts/pr5-evidence/gate-c-subset-result.json` | `2c90dc91129256256c5055bd87f9ef8f597a6e1974ce5e4324359fb3d61b47b7` |
| `artifacts/pr5-evidence/gate-c-subset-215b0ed.log`（最终 SHA） | `ea60947a0d0f5727533911507b48c813bf8ffda50df3ce5404a382ca3e4dee83` |
| `artifacts/pr5-evidence/gate-c-subset-result-215b0ed.json`（最终 SHA） | `6be25a9d08cc1686151d1056ea94a68009546cc9e214d19cc6bf3c4ce3b23a88` |

### 未验证项 / 风险
- 浏览器手工：队列面板布局、行内编辑、取回后的光标位置未手工看；gate-c `final-interrupt` 不触碰队列（PR7 新增「排队」步骤覆盖）。
- 出队后 HTTP 迟迟不返回（既不成功也不失败）：inflight 停在 acceptedAt=null，10s 期限只从受理起算，队列会一直 dispatch 态直到请求 settle——与「不确定就停」一致，但界面此时只显示队列项减少、无「发送中」提示（可在 PR6/PR7 视需要补）。
- `seenSeq` 是内存水位：刷新后从零对账（首次只设基线），历史失败不会误暂停，已有用例。
- 待核对项一直留在队列区直到人处理；不设自动清理。

## 归档记录（2026-09-21）

**Review decision：pass**（首审 job_41d61502ff12 request changes → 返工 `215b0ed` → 复审 job_4af7e8c64f3c pass，7/7）。提交：`94497ba` + `215b0ed`。

### 完成内容
前端队列：状态机（idle / waiting / dispatch / paused）+ sessionStorage（有项即恢复为 paused，不清空）；出队只认归属解析出的真实回合终态且 `endedSeq > 出队水位`（一个终态只取一项）；点停止瞬间 / 回合失败或中断 / 证实未受理（回队首）/ 结果不确定（待核对，永不自动重发）/ 归属未证实（不回队）/ 刷新或切回 → 暂停 + 如实理由 + 恢复；Composer 队列面板（编辑 / 删除 / 取回）、「排队」按钮与 Tab；队列项完整持久化 skill（name+path）。

### 验证证据
typecheck / lint / build；web 45 文件 235 例、server 47 文件 216 例、contracts 3；testid 167；protocol clean；gate-c `v2-user-path → final-interrupt` 在 `94497ba` 与 `215b0ed` 各 passed（SHA256 见回执表）。

### 未覆盖 / 剩余风险
1. 浏览器未手工看队列面板（布局、行内编辑、取回光标）；现有 gate-c 步骤不触碰队列——PR7 新增「排队」步骤。
2. 出队后 HTTP 长时间既不成功也不失败：队列停在 dispatch 态直到请求 settle，界面无「发送中」提示（10s 期限只从受理起算）。
3. 待核对项不自动清理，直到人取回或删除。
4. 首审两处失误如实记入进度记录：skill 只存路径（内容不保真）、恢复入口以「有可发项」为条件；均已返工并有用例。

### 交接
- PR6：动作卡与队列面板都在 Composer 上方；PR6 把动作卡下沉到消息流后，队列面板位置不变。
- PR7：「排队」E2E 步骤可用 `queue-message` / `queue-item` / `queue-paused` / `queue-resume`；断言「运行中排队 → 回合结束后自动发出 → 第二条等第一条的真实回合」。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## Materialization Context

- Requirement: cmto2qafxd2362785ef3af281
- Section: pr5-frontend-queue
- Owner: claude
- Priority: high
- Dependencies: subtask-3a7486ba0614, subtask-30823b359683, subtask-193ab77c887b
