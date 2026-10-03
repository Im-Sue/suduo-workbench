---
doc_type: dev_task
task_id: subtask-a9de756e9c6f
title: H · 交付缺口补齐（会话删除 / 主题与缩放 / Skills 接线）
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-workbench-ui-refit-001
section_id: pr15-delivery-gap-closure
order: 15
implementation_owner: ccb_codex
dependencies: [subtask-f7ed2c7ad507, subtask-f44697941893, subtask-0eee6c8685d7]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-workbench-ui-refit-001.json
source_draft_hash: c17633172b3b2c225613e934c5a43595a9cc7152b99009e0a3679bbdc43c4185
created_at: 2026-08-24T03:45:00.000Z
updated_at: 2026-08-25T02:24:36.476Z
updated_by: ccb_claude
---

# H · 交付缺口补齐（会话删除 / 主题与缩放 / Skills 接线）

> 第 15 片，用户 2026-08-24 拍板「补完再归档」授权新增，不在原 13 片拆分内。
> 归档前的完整性检查发现三项需求原文要求的能力未交付，**且三项各自的豁免/交接理由经实核都不成立**。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 补齐三项需求原文要求但至今缺失的能力，使本需求可以诚实地 finalize 为 delivered |
| 需求来源 | suduo-v2-workbench-ui-refit-001（归档前完整性检查发现） |
| 分工 | ccb_codex |
| 工作空间 | **主仓原地**（`workspace_mode=inplace`），不展开 worktree；需求分支已合入 main 且 main 已前进 |

## 二、为什么会漏

三项都不是"没人提"，而是**每一片都合法地把它记进交接项、链条末端没人接**。14 片全绿不等于需求交付完整，这是批次归档的结构性盲区。更糟的是三条理由经实核**全部与事实相反**——见下表，实施前请自行复核一遍，不要采信本文档的转述。

## 三、任务分解

### 1. 会话删除（需求 4.3「会话操作：重命名、归档、删除」）

pr8 记的豁免理由是「查证：服务端无会话 DELETE 路由」。**假的**：

- `client/server/src/infrastructure/http/http-server.ts:558` 就是 `server.delete("/api/v1/sessions/:sessionId")`
- `client/server/src/application/session-service.ts:307` `remove()` 已把状态置为 `deleted`
- `git blame` 指向 `60b6069`（基线导入），远早于 pr8 的 `7175f9e`

真实缺口只在 web 端：`client/web/src/api/client.ts` 没有 sessions 的 DELETE 封装。

要做：client 补 `deleteSession(sessionId)`；`SessionsRail.tsx` 在既有重命名（`:269`）／归档（`:278`）旁加删除入口，**必须二次确认**（删除不可逆，且服务端是状态置 `deleted` 而非物理删）；删除当前会话后右侧要正确落到空态而不是白屏。

### 2. 主题与界面缩放（需求 4.5「外观与诊断：主题、界面缩放」）

pr9 spec 第 8 条明确派给自己 → 未做记给 pr10 → 未做记给 pr13 → pr13 未做。settings 组件里 theme/zoom 零命中。

**主题机制已经完整存在**：`client/web/src/ui/theme.ts` 有 `loadThemePreference` / `applyThemePreference`，localStorage 键 `suduo.theme`，`system` 移除覆盖交给 `prefers-color-scheme`、`light|dark` 打 `data-theme`。所以主题这一半是**纯接入 UI**，不要重造机制。

缩放没有既有机制，需新建，照 `theme.ts` 的范式（localStorage + 根元素属性），三档标准／大／特大。两项都是客户端偏好，**不上传、不进 settings 端点**。

### 3. Skills 启停与 scope 徽章接线（需求 4.5「Skills 安装/启停/卸载/按 scope 分级」）

`SettingsPage.tsx:207` 传 `localProjectId={null}`，导致 `CodexGroups.tsx:393` 的 `skillCatalog` 分支整个不走，启停开关与 scope 徽章不显示（列表／安装／卸载正常）。

pr10 记的理由是「设置页手上只有远程项目列表，没有本机项目 id」。**也不成立**：`SettingsPage` 本来就在加载 `mappings`，而 `RequirementsWorkspaceMappingDto` 自带 `localProjectId`（`client.ts:76`）。

要做：从已加载的 mappings 取本机 projectId 传下去。**多映射时如何选**由你判断并说明理由；无映射时保持现有降级，不要伪装成有数据。

## 四、验收标准

- 会话可删除，有二次确认；删当前会话后不白屏；client 有 DELETE 封装。
- 设置页可切主题三档并即时生效、刷新后保持；复用 `ui/theme.ts`，不新建第二套主题机制。
- 设置页可切缩放三档并即时生效、刷新后保持。
- Skills 的启停开关与 scope 徽章在有映射时正常显示并可操作；无映射时降级可读。
- `pnpm build` / `typecheck` / `lint` 全 exit 0；`pnpm --filter @suduo/web test`、`--filter @suduo/client-server test`、`--filter @suduo/client-contracts test` 全绿。
- 新增能力有测试覆盖；**删除类操作必须有测试**。

## 五、边界

- **不改** `CODEX_VERSION` 与协议基线；不动 `docs/`、`.ccb/`。
- **不 commit、不 push**，改动留在工作树等 Claude 审查。
- 缩放不改既有 CSS token 语义，只加根级缩放层。
- 不碰 pr7 的附件数/评论数与 pr12 的 MCP 原文——那两条是已认定成立的产品豁免，不在本片。
- 本仓 `.ccb` 是 3.1GB／8.5 万文件的 agent 运行时目录，**不要遍历它**。

## 六、注意

- 跑测试前必须先切 Node 24：`export PATH="/home/sue/.nvm/versions/node/v24.10.0/bin:$PATH"`。默认 shell 是 Node 22，better-sqlite3 ABI 不匹配会炸出 9 个假失败。
- 另有 agent 在并发写 `docs/`，**不要动 docs/ 下任何文件**。

## 七、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-08-24 | 建片 | 无 | 等待 dispatch |

---

## 审查记录 · 2026-08-24（ccb_claude）

**Review decision: pass** — 归档。执行：slot2_codex，job `job_0bb9192afc8d`，9 改 5 增，+305/-44，未 commit（按 brief 留工作树待审）。

### 逐条验收判定 —— 证据全部来自审查方独立执行

| # | 验收标准 | 判定 | 证据 |
|---|---|---|---|
| 1 | 会话可删除、有二次确认、删当前不白屏、client 有封装 | **pass** | 对**运行中的 BFF** 实测：DELETE→`204`，state→`deleted`，18 条列表中已消失。`SessionsWorkbench.tsx` 有 `window.confirm`（与既有归档同范式）并在删当前会话时调 `onCloseSession()` 清运行时 pane + 深链 |
| 2 | 主题三档即时生效、刷新保持、复用 ui/theme.ts | **pass** | 真实 Chromium 实测三档色值互异（dark `rgb(20,24,29)` / light `rgb(243,246,245)`）；`SettingsPage` 直接 import 既有 `applyThemePreference`，未重造 |
| 3 | 缩放三档即时生效、刷新保持 | **pass** | 真实 Chromium 实测 `zoom` 1／1.125／1.25，H1 渲染宽 350→394→438（比例 1.126／1.251）；`main.tsx` 启动时恢复偏好 |
| 4 | Skills 启停与 scope 徽章正常、无映射降级可读 | **pass** | 唯一映射自动选、多映射要求显式选（不擅取第一条）、同 localProjectId 去重、无映射显示诚实降级文案 |
| 5 | build／typecheck／lint／三套测试 | **pass** | 审查方自跑（Node 24）：全 exit 0；web **82/82**、server **127/127**、contracts **3/3** |
| 6 | 新增能力有测试，删除类必须有测试 | **pass** | 新增 `api-client.test.ts`（含 DELETE 与 204）、`preferences.test.ts`、`skill-project-context.test.ts` |

### 关键设计判断复核

**`zoom` 选型成立。** 本项目 token 是 px 基（`--text-base: 12px`，全文件 926 处 px vs 62 处 rem），rem／font-size 缩放方案走不通，根级 `zoom` 是唯一不改 token 语义的做法，符合本片边界。

**固定定位元素在 zoom 下的行为已实测**，不是推断：`zj-toast-host` 在三档下 top 56→63→70、宽 1408→1404→1400，跟随缩放且始终不越界；三档 `documentElement.scrollWidth` 均未超 `innerWidth`，**无横向滚动条**。

**执行方复核了三条旧结论并确认全部为假**，与审查方独立实核一致——这一点是本片立项的前提，已相互印证。

### 未覆盖

- **登录后的完整 UI 流未做可视验证**：删当前会话落空态、Skills 多映射选择器、抽屉/遮罩类固定元素在 zoom 下的表现，均只做了代码审查与机制级实测。跑完整 gate-c 需真实模型调用（属须问事项），本片未触发。
- 缩放对 Monaco 编辑器与 diff 视图的影响未验。

### 审查方留下的痕迹

实测建了一个一次性会话 `pr15-删除验证-勿用` 并已删除（state=`deleted`，不在列表）。未触碰任何既有会话与账号。
