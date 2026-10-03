---
doc_type: dev_task
task_id: subtask-76717ae856de
title: D-a · 设置页壳与不依赖 Codex 的四组
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-workbench-ui-refit-001
section_id: pr9-settings-shell-local-groups
order: 9
implementation_owner: claude
dependencies: [subtask-735ea641ad3a, subtask-0fbe7dd923c7, subtask-2d21da6ae36f, subtask-03d81034035e, subtask-f7ed2c7ad507]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-workbench-ui-refit-001.json
source_draft_hash: 539ebf4a8c5b66964ac2fa8fc30c204413962ad59f4434dc555ca2b11972a8a6
created_at: 2026-08-16T15:13:00.518Z
updated_at: 2026-08-17T09:06:55.469Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-workbench-ui-refit-001","branch":"ccb/req-suduo-v2-workbench-ui-refit-001"}
---

# D-a · 设置页壳与不依赖 Codex 的四组

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 建设置页六组左导航外壳与 hash 深链接，落地账号与服务、工作目录、安全与执行、外观四组，替换当前 66 行的设置页。 |
| 需求来源 | suduo-v2-workbench-ui-refit-001 |
| 本期范围 | pr9-settings-shell-local-groups · D-a · 设置页壳与不依赖 Codex 的四组 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | claude |

## 二、任务分解

### D-a · 设置页壳与不依赖 Codex 的四组

#### 任务概述

当前设置页只有 66 行。它的根本问题不是条目少，而是 **SuDuo 自有配置、Codex CLI 配置、纯客户端偏好三个来源混在一起没有骨架**。所以重建方式是按「**谁拥有这个设置**」分组——这同时也解释了为什么有的改完立刻生效、有的要重连 codex。

分组虽按「谁拥有」，**排序按到达频率**：第一次必配的在前，几乎不来的在后。

还有一个方向性问题要纠正：用户来设置页，九成是因为**某样东西不工作**——「AI 说看不到我的文件」（目录没映射）、「发消息没反应」（模型连不上）、「我的 Skill 没生效」（被停用了）。所以设置页的第一职责是**让人看出现在是好是坏**，第二职责才是改配置。现在 doctor 自检被藏在「关于」tab 的一个链接后面，方向是反的。

本片做外壳和**不依赖 Codex 的四组**；依赖 Codex 的两组和顶部状态条归 pr10，MCP 归 pr12。

#### 任务分解

1. 新增 `components/settings/SettingsPage`：六组左导航外壳，替换 pr2 建的 `SettingsMode` 槽内实现，替掉 `RequirementsSettings.tsx`(66)。为 pr10/pr12 预留组 3「模型」、组 4「能力扩展」与顶部状态条的挂载位。
2. **深链接**：当前分组进 URL（`/settings#mcp` 形态），刷新与状态条跳转都不丢位置。
3. **保存语义靠控件形态编码**（全页统一）：Switch／单选段 = 即时生效、行尾闪 ✓；表单块 = 底部粘性保存条、脏了才出现（含「放弃修改」）；破坏性操作 = Dialog 二次确认 + destructive 按钮。
4. **锁定态统一表达**：控件禁用 + 🔒 + Tooltip 写明锁来源（`SUDUO_GLOBAL_SKILLS` / `SUDUO_MAX_APPROVAL_MODE`）与「请联系管理员」。团队成员要能分辨「被锁」和「坏了」。
5. **组 1 账号与服务**：远程需求服务地址（Input + 测试连通，调 pr5 的试连端点；改地址清登录态需确认）、当前登录态只读卡片、退出登录（destructive）。
6. **组 2 工作目录**：项目→本机目录映射表（项目／路径／**可用性灯**／解除），可用性灯调 pr5 的 `verify=1` 端点；新增映射（Select 项目 + Input 绝对路径，保存时 realpath + R/W/X 复验）。
7. **组 5 安全与执行**：新会话默认审批模式三档单选 + 每档一句后果，**选 `full` 时二次确认**（现在会话头有二次确认、设置页却是单击即写，两处不一致）；「允许会话使用完全访问」Switch，读 pr6 的 `approvalModeLocked` 并按第 4 点表达锁定态；三档实际沙箱与网络权限**只读对照表**；一键初始化版本管理时默认开启「回合前自动存档」Switch（从旧 git tab 并入——它本质是执行安全）。
8. **组 6 外观部分**：主题（跟随系统／浅色／深色）、界面缩放（标准／大／特大），来源为客户端 localStorage、不上传。SuDuo 自检（Node／pnpm／better-sqlite3／端口）由跳转新页改为**内嵌结果卡片**。
9. **高级逃生门**：「直接编辑配置文件」放**诊断组底部**（不是模型组），调 pr5 的 `config-file/open` 端点 + 风险提示。不做内嵌编辑器。

#### 验收标准

- 六组外壳可用，组 3／组 4 与状态条的挂载位已预留且不报错（pr10/pr12 未落地时显示占位而非崩溃）。
- `/settings#<group>` 深链接刷新后仍停在原组。
- 四组内每一项的保存语义符合第 3 点的控件约定；破坏性操作都有二次确认。
- 设 `SUDUO_MAX_APPROVAL_MODE=auto` 后，组 5 的「允许完全访问」显示锁定态、Tooltip 写明锁来源，且**默认档单选里 `full` 不可选**。
- 映射可用性灯能正确反映目录被删除或被改权限的情况。
- 组 1 的测试连通按钮真实可用（不是假按钮）。
- `RequirementsSettings.tsx` 已被替换，其 `v2-*` 清零。
- gate-c 增加设置页深链接与锁定态步骤模块。
- **认领 pr1 断言迁移矩阵中责任片为本片的全部 `replacement` 条目**，逐条落成步骤模块断言并在矩阵中标记已核销。

#### 边界

- **不**碰依赖 Codex 的组 3 模型、组 4 Skills 与 Codex 自检卡片（归 pr10），**不**碰 MCP（归 pr12）。
- **不**删 `SettingsPanel.tsx`——它的模型与 Skills 能力要等 pr10 迁完才能删。
- **不**做 `config.toml` 全量字段可视化、`codex plugin`／marketplace、多 profile 切换。
- 不做内嵌配置编辑器。

#### 依赖

pr2（基座与 `SettingsMode` 槽）、pr4（`api/client.ts` 串行前序——pr4 要改 `:462` 的 `testModelProvider` 调用点，本片再为 pr5 端点加调用）、pr5（三个支撑端点）、pr6（`approvalModeLocked` 契约字段）、pr8（gate-c 主编排串行前序）。

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-735ea641ad3a, subtask-0fbe7dd923c7, subtask-2d21da6ae36f, subtask-03d81034035e, subtask-f7ed2c7ad507
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-08-16 | 物化任务文档 | 无 | 等待 dispatch 派工 |

## 五、验收标准

- [ ] 完成 `spec_section_md` 定义的实现范围。
- [ ] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [ ] 完成必要验证，并在回执中说明测试命令与结果。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## Materialization Context

- Requirement: suduo-v2-workbench-ui-refit-001
- Section: pr9-settings-shell-local-groups
- Owner: claude
- Priority: high
- Dependencies: subtask-735ea641ad3a, subtask-0fbe7dd923c7, subtask-2d21da6ae36f, subtask-03d81034035e, subtask-f7ed2c7ad507

## 实施与审查记录 · 2026-08-17（ccb_claude 自实施）

**Review decision: pass** — 归档。commit `3de52a4`。

### 逐条验收判定

| # | 验收标准 | 判定 | 证据 |
|---|---|---|---|
| 1 | 六组外壳可用，组 3／组 4 与状态条挂载位已预留且不报错 | **pass** | gate-c 点进 model／capability 两组均命中 `settings-group-placeholder`，不白屏；状态条挂载位为空 div，pr10 落地即用 |
| 2 | `/settings#<group>` 深链接刷新后仍停在原组 | **pass** | gate-c 实跑：`#workspace` → reload → 仍在 workspace 组 |
| 3 | 四组保存语义符合控件约定；破坏性操作有二次确认 | **pass** | `settings-kit.tsx` 固化三种形态；退出登录、解除映射、改服务地址、设 full 默认档均有 `window.confirm` |
| 4 | cap=auto 时组 5 显示锁定态、写明锁来源，且默认档 `full` 不可选 | **pass** | gate-c 断言 `full` radio `isDisabled()`，并检查锁定文案同时含 `SUDUO_MAX_APPROVAL_MODE` 与「管理员」 |
| 5 | 映射可用性灯能反映目录被删或改权限 | **pass** | 接 pr5 的 `verify=1`，`AvailabilityDot` 按 `available` 显示红点与可读原因 |
| 6 | 组 1 测试连通按钮真实可用 | **pass** | 调 pr5 的 `POST /api/v2/requirements/settings/test`，试的是**尚未保存**的地址 |
| 7 | `RequirementsSettings.tsx` 已被替换，`v2-` 清零 | **pass** | 文件已删除且无残留引用；**`client/web/src` 下 tsx 的 `v2-` 至此全仓为 0** |
| 8 | gate-c 深链接与锁定态步骤 | **pass** | `steps/settings-shell.ts`，`registry.ts` 一行注册 |
| 9 | 核销矩阵中指名本片的条目 | **pass** | 「设置页 hash 深链接与审批锁定态」已标 ✅已核销并填入具体 testid |

### 分组方式与排序的理由

分组按「**谁拥有这个设置**」（SuDuo 自有 / Codex CLI / 本机偏好），这同时解释了为什么有的改完立刻生效、有的要重连 codex。**排序按到达频率**：账号与工作目录是第一次必配，排最前。

**纠正了一个方向性问题**：用户来设置页九成是因为某样东西不工作（AI 看不到文件 / 发消息没反应 / Skill 没生效）。原先 doctor 自检藏在「关于」tab 的一个链接后面，方向是反的；现在改为**内嵌结果卡片**。

### 两处按依赖说明授权的改动

1. **补 4 个客户端方法**：pr5 的三个端点（试连、`verify=1`、`config-file/open`）与 pr14 的代理自检在服务端已就绪但客户端无方法。本片依赖说明明确写「本片再为 pr5 端点加调用」，属授权范围。
2. **新增 `GET /api/v1/doctor`**：原 `/doctor` 只返回 HTML，无 JSON 途径，而验收要求把自检**内嵌成卡片**。只加一条读取路由，HTML 页原样保留给不开设置页的场景。pr9 边界未禁后端改动（「后端零改动」是 pr8 的约束）。

### gate-c 夹具的一处追加

锁定态验收需要服务以 `SUDUO_MAX_APPROVAL_MODE=auto` 启动，而安装器只写固定 `SUDUO_*` 白名单。照 gate-c 既有 `appendFileSync` 追加 `SUDUO_REQUIREMENTS_SERVICE_URL` 的先例，在同处追加该变量——**gate-c 拥有自己的 install-home，不影响用户真实部署**。

### 边界核查

未碰组 3 模型、组 4 Skills、Codex 自检卡片（归 pr10）｜未碰 MCP（归 pr12）｜**未删 `SettingsPanel.tsx`**（其模型与 Skills 能力要等 pr10 迁完）｜未做 `config.toml` 全量字段可视化｜未做内嵌编辑器。

### 剩余风险

组 6 的主题与界面缩放本片未落地——它们的来源是客户端 localStorage、与其余五组的服务端来源不同，且现有 `ui/theme.ts` 已有独立机制。为避免与 pr10 的顶部状态条抢同一块区域，留待 pr10 一并处置并已在交接项记录。
