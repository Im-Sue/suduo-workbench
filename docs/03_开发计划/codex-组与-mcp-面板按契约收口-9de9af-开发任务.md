---
doc_type: dev_task
task_id: subtask-a930219de9af
title: Codex 组与 MCP 面板按契约收口
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-feedback-interaction-language-001
section_id: pr6-settings-codex-mcp-adoption
order: 6
implementation_owner: ccb_codex
dependencies: [subtask-e1a2f5dbb798]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-feedback-interaction-language-001.json
source_draft_hash: 02b30b998028de4c87604f4656f338cd76afd80edddf54d47a4a963f5b3ba286
created_at: 2026-08-26T02:49:41.226Z
updated_at: 2026-08-28T03:29:27.085Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-feedback-interaction-language-001","branch":"ccb/req-suduo-v2-feedback-interaction-language-001"}
---

# Codex 组与 MCP 面板按契约收口

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | CodexGroups 与 McpPanel 共 16 处 showMessage、3 处 window.confirm 逐项收口；ModelGroup/CapabilityGroup 导出 props 必须冻结，因为 SettingsPage 也在消费。 |
| 需求来源 | suduo-v2-feedback-interaction-language-001 |
| 本期范围 | pr6-settings-codex-mcp-adoption · Codex 组与 MCP 面板按契约收口 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### pr6 Codex 组与 MCP 面板按契约收口

#### 任务概述

设置页的另一半。`CodexGroups.tsx`（566 行，7 `showMessage` + 2 `confirm` = 9 个调用点）内部挂载 `McpPanel.tsx`（495 行，9 `showMessage` + 1 `confirm` = 10 个调用点），两者是父子关系但文件独立，合成一片既保持内聚又与 pr5 文件互斥。

**本片有一个特别的坑**：MCP 的失败信息**天生不可归因**。`McpPanel.tsx:32` 与 `:39` 的注释写得很清楚——Codex 0.143 不提供失败原因，`serverInfo: null` 既可能是启动失败也可能是尚未启动。这正是 `unknown` 档存在的理由。**不要在收口时现场发明一个归因**，那比不说更糟。

#### 任务分解

1. **16 处 `showMessage` 逐项定路由**（CodexGroups 7 + McpPanel 9）。其中 13 处是 `"warning"` 字面量（CodexGroups 6 + McpPanel 7），逐个复核实际该落哪一档。建局部 `reportFailure(context)` 可以，但**每个动作单独判定出口**。

2. **3 处 `window.confirm` 逐个按 `needsConfirm` 判定**：
   - `CodexGroups.tsx:103` 「当前有进行中的回合，配置改动将在下个回合生效。确认保存？」——**这条是信息告知，不是破坏性确认**。按需求 4.4 的判定规则很可能应该改成信息提示而非阻塞确认，请给出明确结论。
   - `CodexGroups.tsx:539` 卸载 skill —— 不可逆，大概率保留并迁 `ConfirmDialog`。
   - `McpPanel.tsx:272` 删除 MCP 服务器 —— 同上。
   
   判定为需要确认的迁 `ConfirmDialog`（危险色 + 默认焦点在取消）。

3. **空态收编**：`CodexGroups.tsx:544`（还没有安装任何 skill）、`McpPanel.tsx:151`（还没有配置 MCP 服务器）→ `EmptyState` + 引导动作。

   **另有两处项目上下文状态（commit `92434dc` 新增，原草案漏收）**，同样纳入本片：
   - `CodexGroups.tsx:449` `skills-project-context-empty`（尚未关联本机项目，只能显示已安装 Skills）——这是**真空态**，收编为 `EmptyState`，引导动作指向建立工作区映射。
   - `CodexGroups.tsx:486` `skills-project-context-required`（多映射未选择时的提示）——这**不是失败也不是空态，是前置条件未满足**，按 pr7 中 `:220` 同类处理：走行内引导而非 toast，**不要**误判成 `validation` 档。
   - 同处的 `skills-degraded-banner`（`skills === null` 的降级横幅）属于**诚实降级**，与 MCP 不可归因同理：保留现有表述，**不得**在收口时补一个编造的原因。

4. **MCP 不可归因的失败落 `unknown` 档**：保留 `McpPanel.tsx:32` / `:39` 已有的诚实表述，呈现层不得断言「启动失败」或「尚未启动」。这与契约层对裸 `TypeError` 不归因是同一条原则。

5. **loading 分工**：skill 安装/卸载、MCP 服务器连接测试这类动作按钮进入忙碌态（禁用 + 文案变化或 spinner，不能只变灰）；耗时超 1s 显示「仍在处理」。

6. **同提交跑 pr1 的基线再生成命令**。

#### 验收标准

- [ ] 19 个调用点（16 `showMessage` + 3 `confirm`）**逐项**有走查记录：调用点 → `FailureKind` → 出口。
- [ ] `CodexGroups.tsx:103` 有明确判定结论（保留阻塞确认 / 改为信息提示），理由写进记录。
- [ ] 卸载 skill 与删除 MCP 服务器的确认已迁 `ConfirmDialog`，危险色与默认焦点在取消。
- [ ] 2 处空态（skill / MCP）接入 `EmptyState`；另 2 处项目上下文状态（`skills-project-context-empty` 收编为 `EmptyState`、`skills-project-context-required` 走行内引导）各有判定结论；`skills-degraded-banner` 的诚实表述未被改成编造原因。
- [ ] MCP 失败呈现**不含**对原因的断言——构造 `serverInfo: null` 场景验证。
- [ ] 基线再生成已跑，漂移检查通过。
- [ ] build / typecheck / lint / 全量单测通过。
- [ ] **关键路径组件测试**（2026-08-25 勘误新增）：本片至少 2 条组件测试——① 该片最关键的一条「故障 → 出口」路由断言；② 一条焦点归还或 `aria-busy` 断言。文件顶部加 `// @vitest-environment jsdom` docblock，**不新增任何依赖**（jsdom 与 @vitejs/plugin-react 已在 `client/web/package.json`）。
- [ ] **验收表述诚实性**：关键路径之外的调用点没有自动化覆盖。收尾报告**不得笼统写「已自动化验证」**，必须分开写清：哪几条用例覆盖了什么、其余多少处走人工走查、记录落在 `docs/05_经验沉淀/feedback-adoption-walkthrough/pr6.md`。

#### 走查记录（强制，缺列即视为未走查）

落点固定 `docs/05_经验沉淀/feedback-adoption-walkthrough/pr6.md`，每个调用点一行，六列缺一不可：

| 列 | 含义 | 反例（无效） |
|---|---|---|
| 调用点 | `文件:行号` + 触发动作 | 只写文件名 |
| 故障构造方式 | **怎么让它真的失败**：改 fixture / devtools 改响应 / 断网 / 停服务 | 「模拟失败」 |
| 判定结果 | `classifyFailure` 返回的 `FailureKind` | 空着 |
| 实际出口 | 真看到的呈现（toast / 行内 / 区域块 / 整页）+ 停留时长 | 「符合预期」 |
| 观察证据 | 截图文件名，或 DOM 里 `data-feedback-kind` / `data-feedback-result` 实际取值 | 「已确认」 |
| 无副作用 | 该失败没有连带触发别的反馈、没有重复弹出 | 空着 |

构造不出来的场景**如实写「未验证」，不许写「已走查」**。

#### 边界

**本片独占文件**（outline 的归属矩阵不会随物化进入任务文档，故在此下沉）：`client/web/src/components/settings/CodexGroups.tsx` / `McpPanel.tsx`。

**硬约束（pr5 与本片并行的前提）**：

- `CodexGroups.tsx` 导出的 `ModelGroup` / `CapabilityGroup` 被 `SettingsPage.tsx:16` 消费。**本片不得改动这两个导出的 props 签名**。
- `settings-kit.tsx` 归 **pr5 持有**，本片 `CodexGroups.tsx:16` 只消费 `DirtyBar` / `SettingsGroup` / `SettingsRow`——**严禁修改 `settings-kit.tsx`**。若 `DirtyBar` 的未保存拦截语义确需改动，**停下来升级**，不要自行改。
- `skill-project-context.ts` 同样归 **pr5 持有**，本片 `CodexGroups.tsx:17-19` 只消费 `defaultSkillProjectId` 与 `SkillProjectOption` 类型——**严禁修改该文件**。上面第 3 条要接入的两处项目上下文状态**只改 `CodexGroups.tsx` 里的呈现**，不动这个纯函数模块。

**严禁触碰 `SettingsPage.tsx` / `settings-kit.tsx` / `SettingsStatusBar.tsx`**（pr5 持有）、`app/**`（pr7 持有）、`components/requirements-v2/**`（pr3 持有）、`components/sessions/**`（pr4 持有）、`feedback/**` 与 `ui/message.tsx`（pr2 已定稿）。

不改服务端。不改 Codex 配置文件格式与 MCP 协议行为——本片是纯呈现层。

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-e1a2f5dbb798
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
- Section: pr6-settings-codex-mcp-adoption
- Owner: ccb_codex
- Priority: high
- Dependencies: subtask-e1a2f5dbb798

---

## 审查记录 · 2026-08-27（ccb_claude）

**Review decision: pass（一轮通过）** — 归档。执行：slot4_codex，commit `491399e`（单提交，4 文件 +503/-74）。

### 🎯 里程碑：全仓 `window.confirm` 清零

审查方 rg 全仓确认：**可执行代码（`client/web/src` / `client/server/src` / `packages`）中 `window.confirm` 为 0**。全文检索仅命中若干 Markdown 文档中的历史说明（`components/ui/MIGRATION.md`、需求与开发任务文档、走查表本身），非调用代码。

需求现状表第 5 条记的是「`window.confirm` 9 处真实调用」，加上 2026-08-24 commit `92434dc` 新增的会话删除共 10 处。经 pr4（会话 2 处）、pr5（设置页主壳 5 处）、pr6（Codex/MCP 3 处）依次收口，**10 → 0**。

更重要的是**做法而非数字**：N6 明确「不是把 9 处机械替换成 Dialog」。实际结果是 **8 处迁 `ConfirmDialog`、2 处判定为不该确认并真的删掉**——pr5 的「用系统编辑器打开配置文件」与本片的 `:107`「当前有进行中的回合」。

### `:107` 的判定：第二处被移除的确认

原 `:107` 是阻塞式 `window.confirm("当前有进行中的回合，配置改动将在下个回合生效。确认保存？")`。现改为 `:128` 的 `showMessage("当前有进行中的回合，配置改动将在下个回合生效。", "info")`，**且不再阻塞保存**（无早返回）。代码里留了理由注释：「热重载只影响后续回合；这是信息告知而非破坏性操作，不阻塞保存。」

审查方判定成立：这条从来不是破坏性确认，而是把一句信息告知包装成了拦路的模态。需求 4.4「本不该确认的直接去掉」要的正是这个。

### MCP 不可归因：处理得比要求更细

本片最容易做错的地方是「收口时顺手编一个失败原因」。实测执行方的处置：

- `unknown` → 呈现「**未确认连接**」，并给诊断入口
- `failed` → 呈现「启动失败」

这个区分是对的，不是偷懒：`McpPanel.tsx` 的注释说明了 Codex 0.143 的实际能力边界——**「启动失败」这个状态在部分情况下是可判别的**（用户最需要的判别），只有**原因原文**取不到；而 `serverInfo: null` 是**状态本身就有歧义**（既可能启动失败也可能尚未启动），这时才必须落 `unknown`。所以「已知失败」说失败、「状态存疑」说未确认，两者都没撒谎。

用例断言写法沿用了 pr2 的归因词组范式：断言文案包含「未确认连接」且 **不匹配 `/启动失败|尚未启动|命令路径|环境变量未设置/`**。`skills-degraded-banner` 的诚实降级表述保留原文，未被补上编造的原因。

### 冻结契约：零违反（审查方查 diff 证明）

- pr5 的四个文件（`SettingsPage.tsx` / `settings-kit.tsx` / `SettingsStatusBar.tsx` / `skill-project-context.ts`）：**零 diff**
- `ModelGroup` / `CapabilityGroup` 的导出签名行未出现在 diff 中，`SettingsPage.tsx:26` 的消费不受影响

pr5 与 pr6 两片双向冻结契约，两边都做到了零违反。

### 必须实证的最小集合 —— 全部有可运行用例

7 个用例覆盖 5 条要求，另有 2 条超出：MCP 不编造原因、卸载 skill 取消不调 API、删除 MCP 取消不调 API、多项目未选走行内 `role=status` 无 toast、三处空态渲染 `EmptyState`、`AUTH_INVALID → auth_expired/page`、MCP 测试连接 1 秒后 `aria-busy` 且显示「仍在处理」。

### 四处项目上下文状态：三种不同处置，各自成立

| 位置 | 处置 | 判断 |
|---|---|---|
| `:450` `skills-project-context-empty` | `EmptyState(kind="prerequisite")`，引导指向工作区映射 | 真空态，收编正确 |
| `:471` `skills-project-context` | 保留选择器 | 非空态非失败，不动正确 |
| `:487` `skills-project-context-required` | **行内引导**，不走 toast、不误判成 `validation` | 前置条件未满足，处置正确 |
| `:495` `skills-degraded-banner` | 保留原文 | 诚实降级，不补编造原因 |

### 隔离约束遵守情况

本片 brief 硬性禁止走查触发真实 MCP 登录、远程 HTTP、stdio 命令、skill 安装卸载。回执确认：15 条非关键失败路径**仅记录为可 mock 构造，未触发任何真实操作**。约束被遵守。

### 审查方自跑验证

`testid:check` 136 静态 / 12 dynamic（无新增静态 testid，符合"复用既有出口组件 testid"）、build / typecheck / lint 全 exit 0、contracts 3 / **web 23 files 123 tests** / requirements-service 43 / server 129。本次全量测试未命中 Postgres 偶发。工作树干净。

### 边界核查

只动 `CodexGroups.tsx` / `McpPanel.tsx` + 新测试 + 走查文档。未碰 pr5 四文件、`app/**`、`components/requirements-v2/**`、`components/sessions/**`、`feedback/**`、`ui/message.tsx`、`client/server/**`。零新增依赖。`docs/.ccb` 零改动。

### 走查表

`docs/05_经验沉淀/feedback-adoption-walkthrough/pr6.md`，19 个调用点：**实证 4 / 可构造但未做 15 / 未验证（客观障碍）0**。
「客观障碍 0」这一项值得说明：本片确实存在造不出来的真实场景（真实 MCP 服务器、真实 stdio），但那是**隔离约束主动禁止去碰**，不是能力不足——所以它们被诚实地归入「可构造但未做（用 mock）」而非「客观障碍」。这个归类是准确的。

### 未覆盖（诚实计数）

- 15 个调用点为「可构造但未做」，未逐个写测试。
- 真实 MCP 服务器 / 远程 HTTP / stdio / skill 安装卸载**按隔离约束刻意未触发**。
- 未跑 Gate-C，归 pr8。
