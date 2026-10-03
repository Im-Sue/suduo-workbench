---
doc_type: dev_task
task_id: subtask-735ea641ad3a
title: A · 组件基座与外壳接线槽
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-workbench-ui-refit-001
section_id: pr2-ui-base-and-mode-slots
order: 2
implementation_owner: claude
dependencies: [subtask-f8fc8be52b7e]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-workbench-ui-refit-001.json
source_draft_hash: 539ebf4a8c5b66964ac2fa8fc30c204413962ad59f4434dc555ca2b11972a8a6
created_at: 2026-08-16T15:13:00.518Z
updated_at: 2026-08-17T07:25:16.565Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-workbench-ui-refit-001","branch":"ccb/req-suduo-v2-workbench-ui-refit-001"}
---

# A · 组件基座与外壳接线槽

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 建齐 components/ui 原语，迁移外壳四件的呈现层，并把 RequirementsV2App 的单条 ternary 链改造为 SessionsMode/SettingsMode 两个接线槽，消除后续两片的接线冲突。 |
| 需求来源 | suduo-v2-workbench-ui-refit-001 |
| 本期范围 | pr2-ui-base-and-mode-slots · A · 组件基座与外壳接线槽 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | claude |

## 二、任务分解

### A · 组件基座与外壳接线槽

#### 任务概述

项目在 ADR-0003 就装好了 Tailwind v4 + Radix，也落了 `components.json`（`style: new-york`、`baseColor: slate`、`iconLibrary: lucide`），但 `components/ui/` 下**只有 `button` 和 `dropdown-menu` 两个组件**，三个 V2 页面全是裸 `<button>/<input>/<p>` 加自定义 `v2-*` class。本片把基座真正建起来，后面三页才有共同的地基——否则基座会被建三遍并产生分歧（这正是需求 4.7 把它放进需求的理由）。

另一件事同样重要：`RequirementsV2App.tsx` 现在用**一条 ternary 链**（204–256 行）渲染 requirements / sessions / settings 三个模式。后面 pr8 要换 sessions 那一支、pr9 要换 settings 那一支，两片必然改同一处。本片先把这条链拆成两个接线槽，把冲突消灭在发生前。

#### 任务分解

1. 按 `components.json` 既定风格补齐 `components/ui/`：`dialog`、`input`、`textarea`、`select`、`card`、`badge`、`tabs`、`tooltip`、`skeleton`、`scroll-area`、`separator`、`avatar`、`label`。逐个安装所需 `@radix-ui/react-*` 子包。
2. 外壳四件呈现层迁移：`RequirementsV2App.tsx`(289)、`RequirementsTopBar.tsx`(108)、`RequirementsLogin.tsx`(97)、`RequirementsWorkspaceMappingDialog.tsx`(63)——这四个文件内的 `v2-*` class 清零。
3. **建接线槽**：新增 `app/SessionsMode.tsx` 与 `app/SettingsMode.tsx`，把 App 中对应分支的现有渲染逻辑原样搬进去；`RequirementsV2App` 改为渲染这两个组件。本片**不改变行为**，只改接线形状。
4. `styles.css` 只允许新增令牌，不得删除 `v2-*` 段（归 pr13）。

#### 验收标准

- `components/ui/` 下 13 个新原语全部可用，且与既有 `button`/`dropdown-menu` 风格一致（`new-york` / slate / lucide）。
- 外壳四件中 `grep -c 'v2-'` 为 0。
- `SessionsMode` / `SettingsMode` 两个槽已建立，`RequirementsV2App` 中不再有 sessions/settings 的直接渲染分支。
- 行为零变化：登录、选项目、映射对话框、三模式切换与 `pnpm gate:c` 全部与迁移前一致。
- build / typecheck / lint 通过。

#### 边界

- **不**做 `ui/session-status.ts` 提取（属会话域，归 pr8）。
- **不**动 `RequirementsWorkbench.tsx`、`RequirementsSessions.tsx`、`RequirementsSettings.tsx` 三个页面主体（分别归 pr7/pr8/pr9）。
- **不**删 `styles.css` 的 `v2-*` 段。
- 不引入前端路由库（`client/web` 架构既定边界），沿用按 `pathname` 分流。

#### 依赖

pr1（回归网必须先可用，否则基座迁移无法验证未回归）。

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-f8fc8be52b7e
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
- Section: pr2-ui-base-and-mode-slots
- Owner: claude
- Priority: high
- Dependencies: subtask-f8fc8be52b7e

## 实施与审查记录 · 2026-08-17（ccb_claude 自实施）

**Review decision: pass** — 归档。commit `febc60e`，21 文件 +1457/-68。

按草案终审的「呈现层例外」，本片由 Claude 直接实施。

### 逐条验收判定

| # | 验收标准 | 判定 | 证据 |
|---|---|---|---|
| 1 | `components/ui/` 13 个新原语可用且风格一致 | **pass** | dialog / input / textarea / select / card / badge / tabs / tooltip / skeleton / scroll-area / separator / avatar / label；全部沿用既有 `button.tsx` 的 new-york + `var(--*)` 语义令牌写法 |
| 2 | 外壳四件 `grep -c 'v2-'` 为 0 | **pass** | App 0 / TopBar 0 / Login 0 / MappingDialog 0（迁移前分别为 2/1/4/5） |
| 3 | 两个接线槽建立，App 不再直接渲染两支 | **pass** | 新增 `app/SessionsMode.tsx`、`app/SettingsMode.tsx`；App 内已无 `RequirementsSessions`/`RequirementsSettings`/`SessionRuntime` 直接引用 |
| 4 | **行为零变化** | **pass** | **`pnpm gate:c` 全绿，8 步 PASS**——登录、选远程项目、映射对话框、三模式切换、会话全流程均经迁移后组件跑通 |
| 5 | build / typecheck / lint 通过 | **pass** | 三项 exit 0；web 单测 28/28 |

### 依赖引入

新增 8 个 `@radix-ui/react-*` 子包：dialog、select、tabs、tooltip、scroll-area、separator、avatar、label。其余 5 个原语（input／textarea／card／badge／skeleton）无需 Radix。

均属 ADR-0003 已采纳的 Radix/shadcn 基座同族扩展，`components.json`（new-york / slate / lucide）本就为此配好。

### 令牌纪律

**一个新 CSS 令牌都没加。** 起初 badge 想用 `--radius-chip`、dialog title 想用 `--text-md`，核查发现两者不存在，改为复用既有的 `--radius-control` 与 `--text-lg`——复用优于新造。写完后对全部原语引用的令牌做了存在性扫描，无缺失。

**`styles.css` 一行未改**，`v2-*` 段完整保留给 pr13。

### 迁移中保住的两处可访问性契约

gate-c 直接依赖这些定位器，迁移时刻意保住：

1. **登录卡**原先靠 `.v2-auth-card label`/`input` 后代选择器上样式，且 `<label>` 包裹 `<input>` 形成隐式关联。改用 `Label`+`Input` 后以 `htmlFor`/`id` 显式关联，`getByLabel("登录名")`／`getByLabel("密码")` 仍然命中。
2. **映射对话框**保持原 DOM 语义（`div[role=presentation]` + `section[role=dialog][aria-label]`），**没有换成 Radix Dialog**——换了会改变 portal 与焦点行为，与「行为零变化」冲突。只迁类名、换 `Input`/`Button` 原语。

### 交接不变量核对

- `data-testid` 基线 44 项，迁移后仍为 44 项，**集合完全相等**，满足 pr13 的只增不删要求。
- gate-c 步骤模块目录 11 个文件，空步骤缝未被破坏。

### 剩余风险

三个页面主体（`RequirementsWorkbench`／`RequirementsSessions`／`RequirementsSettings`）仍是裸 HTML + `v2-*`，按边界分别归 pr7／pr8／pr9。本片只建地基与缝，未越界。
