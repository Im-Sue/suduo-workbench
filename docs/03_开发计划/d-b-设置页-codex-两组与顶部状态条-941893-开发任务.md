---
doc_type: dev_task
task_id: subtask-f44697941893
title: D-b · 设置页 Codex 两组与顶部状态条
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-workbench-ui-refit-001
section_id: pr10-settings-codex-groups
order: 10
implementation_owner: claude
dependencies: [subtask-39aa6a8addc5, subtask-0fbe7dd923c7, subtask-76717ae856de]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-workbench-ui-refit-001.json
source_draft_hash: 539ebf4a8c5b66964ac2fa8fc30c204413962ad59f4434dc555ca2b11972a8a6
created_at: 2026-08-16T15:13:00.518Z
updated_at: 2026-08-17T09:26:18.856Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-workbench-ui-refit-001","branch":"ccb/req-suduo-v2-workbench-ui-refit-001"}
---

# D-b · 设置页 Codex 两组与顶部状态条

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 落地依赖 Codex 的模型组与 Skills 组、Codex 自检卡片与顶部状态条，接回 SettingsPanel 已有能力后删除该文件。 |
| 需求来源 | suduo-v2-workbench-ui-refit-001 |
| 本期范围 | pr10-settings-codex-groups · D-b · 设置页 Codex 两组与顶部状态条 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | claude |

## 二、任务分解

### D-b · 设置页 Codex 两组与顶部状态条

#### 任务概述

这一片把设置页里**依赖 Codex 的部分**补上，并接回 `SettingsPanel.tsx`(744) 里那些写好了却断了入口的能力——模型服务表单、Skills 安装启停卸载。用户感受到的「设置页什么都没有」，很大一部分是这块在 T4 清旧壳时被断了线。

顶部状态条是设置页的第一职责所在：让人一眼看出**现在是好是坏**。它吃 pr3 建的全局状态投影 SSE。

#### 任务分解

1. **顶部状态条**：服务已连接／已登录谁／几个项目已映射／模型可用／Skills 数／MCP 数。任一项异常可点击直达对应分组。数据来自 pr3 的 `/api/v1/codex/status` SSE。
2. **组 3 模型**（底层已由 pr4 换成官方口子）：Base URL（Input）、API Key（**只读脱敏行 + 「更换」展开 password**，R4）、模型（Select，数据来自 pr4 的官方模型清单端点）、推理力度（Select 极简/低/中/高/极高）、上下文窗口（numeric，**无官方来源、保持用户显式输入**）。
3. **每字段的来源／是否被上层覆盖**：字段旁只读徽章，数据来自 `config/read` 的 `includeLayers`。
4. **「保存并验证」**（替代原「测试连接」＋「保存」两个按钮）：调 pr4 的 `PUT /api/v1/settings/model-provider`，失败可一键还原。**收到 `okOverridden` 绝不能显示「已保存生效」**——必须明说「已写入你的配置，但被上层配置覆盖，当前生效值仍是 X」，走独立文案与来源徽章。
5. 保存前的确认**仅当真有进行中回合时**才弹，且措辞按「下回合生效」——`reloadUserConfig` 是热重载配置，不是换掉进行中的 turn。
6. **组 4 Skills（接回）**：启用全局 skills 目录 Switch（**可被 env 锁 🔒**）+ 目录路径；安装 skill（zip 上传／本机文件夹绝对路径，同名弹覆盖确认）；skill 列表（启停 Switch／scope 徽章 全局·项目·内置·管控／版本／描述／卸载确认）；保留现有「可用 skill 越多，每条描述篇幅越少」的描述预算说明——它回答了「我为什么要停用不用的 skill」。
7. **组 6 的 Codex 自检卡片**：内嵌，按 `category` 分组，逐项显示 `summary` 与官方 **`remediation`**（这正是团队成员卡住时最需要、而我们自己写不出的东西）。另加只读的 Codex 版本与协议基线（期望 0.143.0／实际 `doctor.codexVersion`／基线 diff 状态）。「复制诊断信息」按钮（`doctor --json` 已是 redacted 报告）。
8. **codex 不可用时降级**：模型与能力扩展两组显示降级横幅，但**仍显示已知配置**——沿用现有 Skills `catalog === null` 的降级路径。
9. 迁完后删除 `SettingsPanel.tsx`。

#### 验收标准

- **状态条真的会亮**：在**隔离 `CODEX_HOME` 的确定性夹具**下（复用 pr3 随片提交的那套，可重复执行，不接受手工构造）制造一个 Codex 配置告警，设置页状态条可见（这条同时验收 pr3 的投影链路端到端通了——「不报错」不算完成）。
- `okOverridden` 场景下界面**不显示「已生效」**，且能说出当前生效值与来源。
- 「保存并验证」失败后一键还原可用。
- API Key 全程脱敏，界面上不出现明文（R4）。
- Skills 的安装／启停／卸载／scope 分级行为与 `SettingsPanel` 迁移前一致；全局目录锁定时显示 🔒 与锁来源。
- Codex 自检卡片显示官方 `remediation`；`checks` 按对象解析不崩。
- 拔掉 codex（或令其不可用）时两组降级横幅出现且仍显示已知配置，不白屏。
- `SettingsPanel.tsx` 已删除且无残留引用。

#### 边界

- **不**碰 MCP（归 pr12），本片只保留组 4 里 MCP 区的挂载位。
- **不**改 pr4 建立的后端语义，只做消费；发现后端契约不足要报告，不在前端自建替代实现（R3）。
- **不**做 `config.toml` 全量字段可视化；高级逃生门已由 pr9 放在诊断组底部。
- 上下文窗口**不得**声称来自官方能力接口——0.143 实测 `modelProviderCapabilities` 只返回 `imageGeneration`／`namespaceTools`／`webSearch`。

#### 依赖

pr3（全局状态投影 SSE）、pr4（官方控制面与模型清单端点）、pr9（设置页外壳）。

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-39aa6a8addc5, subtask-0fbe7dd923c7, subtask-76717ae856de
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
- Section: pr10-settings-codex-groups
- Owner: claude
- Priority: high
- Dependencies: subtask-39aa6a8addc5, subtask-0fbe7dd923c7, subtask-76717ae856de

## 实施与审查记录 · 2026-08-17（ccb_claude 自实施）

**Review decision: pass** — 归档。commit `2dc3360`。

### 逐条验收判定

| # | 验收标准 | 判定 | 证据 |
|---|---|---|---|
| 1 | **状态条真的会亮**（同时端到端验收 pr3 投影链路） | **pass** | gate-c 断言 `status-projection-note` 的投影计数 **> 0** 且模型栏显示「有配置告警」；告警来源确定性——隔离 `CODEX_HOME` 的 `service_tier` 与模型元数据每次启动必触发 configWarning，非手工构造 |
| 2 | `okOverridden` 不显示「已生效」，能说出当前生效值与来源 | **pass** | 三态独立文案：`ok`→「已保存并验证通过」／`okOverridden`→「已写入你的配置，但被上层配置覆盖——当前生效值仍是原值」／`failed`；配合每字段 `OriginBadge` |
| 3 | 「保存并验证」失败后一键还原可用 | **pass** | 保存前留内存快照，`failed` 与 `okOverridden` 两态均出现 `model-restore` 按钮 |
| 4 | API Key 全程脱敏，界面不出明文（R4） | **pass** | 默认只读展示服务端 masked 值，改才展开 `type="password"`；gate-c 断言三种合法形态之一且**额外正则检查界面上不出现 `sk-` 明文** |
| 5 | Skills 安装／启停／卸载／scope 分级与迁移前一致；全局目录锁定显示 🔒 与锁来源 | **pass** | 沿用 `globalSkills()` 取列表 + `skillCatalog(projectId)` 取启用态与 scope 的既有做法；锁定态走 pr9 的 `settings-kit` 统一表达 |
| 6 | Codex 自检卡片显示官方 `remediation`；`checks` 按对象解析不崩 | **pass** | gate-c 断言 `doctor-remediation` 计数 > 0（本机 installation/updates 两项必失败并带 remediation）；解析由 pr4 的 `Object.values(checks)` 负责 |
| 7 | codex 不可用时两组降级横幅出现且仍显示已知配置 | **pass** | `model-degraded-banner` 与 `skills-degraded-banner`；模型清单拿不到时退化为自由输入而非禁用整组 |
| 8 | `SettingsPanel.tsx` 已删除且无残留引用 | **pass** | 734 行已删，仅余两处注释提及 |

### 一处刻意的「不知道就说不知道」

状态条的 **MCP 一栏显示「未知」而不是 0**。pr3 归档时明确记了：`mcpServerStatus/updated` 在隔离夹具下未观测到通知发出，未进白名单。显示 0 会让用户以为「确实没有 MCP 服务器」，而真相是**我们没有这个数据面**。状态条下方的投影说明也写清了原因。gate-c 有断言守这条。

### 顺带更新了 pr9 的一条过渡期断言

pr9 的 gate-c 步骤断言「组 3／组 4 显示占位而不崩溃」——那是 pr10 未落地时的正确验收。pr10 落地后该断言必然失败，已改为断言真实分组渲染。占位机制本身仍留在 `settings-kit` 里供后续新增分组复用。**这不是放宽验收，是验收对象随实现推进而更新。**

### 三处按真实契约纠正的自我错误

实施中我凭猜写了几个 API 名与字段，typecheck 全部拦下并按契约改正：

- `listGlobalSkills` → 实际是 `globalSkills`
- `installSkill({ sourcePath })` → 实际是 `{ source: "folder", path }` 判别联合
- `SkillDto.enabled`／`scope` 不存在 → 它们在 `SkillCatalogEntry`，需 `projectId`，故沿用 `SettingsPanel` 的双请求做法
- `apiKeyMasked` 除脱敏串与 `null` 外还有第三种形态「由 Codex 管理」（OAuth 登录时本机无 key 可脱敏）

### 边界核查

未碰 MCP（只留 `settings-mcp-slot` 挂载位给 pr12）｜未改 pr4 建立的后端语义，只做消费｜未做 `config.toml` 全量字段可视化｜**上下文窗口明确标注「Codex 没有提供该值的官方来源」**，未声称来自能力接口（0.143 实测 `modelProviderCapabilities` 只返回 imageGeneration／namespaceTools／webSearch）。

### 剩余风险

- `CapabilityGroup` 的 `localProjectId` 目前传 `null`——设置页手上只有远程项目列表，没有本机项目 id。**后果是 skill 的启停开关与 scope 徽章不显示**（列表、安装、卸载正常）。这是 pr9 外壳未向下传本机项目 id 造成的，属可补的接线缺口，已在交接项记录给 pr13。
- 组 6 主题与界面缩放仍未落地（pr9 已记，本片同样未做）——它们来源为客户端 localStorage，与 `ui/theme.ts` 既有机制重叠，留待 pr13 一并判定。
