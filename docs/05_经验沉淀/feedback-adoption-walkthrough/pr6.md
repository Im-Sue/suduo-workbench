---
doc_type: lessons
title: pr6 Codex 组与 MCP 面板反馈收口走查
updated: 2026-08-27
---

# pr6 Codex 组与 MCP 面板反馈收口走查

本片逐项记录原 16 处 `showMessage` 与 3 处 `window.confirm`。实证仅限下面列出的 jsdom 夹具；其余可通过同一 API mock 构造、但本轮未写对应案例的调用点明确标为「可构造但未做」。不以静态阅读冒充实证，也不触碰真实 Codex、MCP、远程 HTTP 或 Skill 安装环境。

| 调用点 | 故障构造方式 | 判定结果 | 实际出口 / 确认结论 | 观察证据 | 无副作用 |
| --- | --- | --- | --- | --- | --- |
| `CodexGroups.tsx:99` 读取模型配置失败 | 可构造但未做：`api.modelProvider` 拒绝 502 `DEPENDENCY_UNAVAILABLE` | `upstream_unavailable` | action → error/global，8000ms；仍保留本机已知配置降级横幅 | 未做：观察 `global-message` 的 `upstream_unavailable` / `global` | 需确认模型列表自由输入降级不被清空 |
| `CodexGroups.tsx:128` 有运行中回合保存 | 可构造但未做：传 `runningTurns > 0` 并保存 | 非故障 | **去掉确认**；信息提示 info/global，5000ms，继续保存 | 未做：观察 info/global；无阻塞对话框 | 不取消写入；现有回合只在下回合读取新配置 |
| `CodexGroups.tsx:167` 还原成功 | 可构造但未做：`updateModelProvider` resolve 后 `load` resolve | 非故障 | success/global，5000ms | 未做：观察 `success` / `global` | 需确认草稿与结果复位 |
| `CodexGroups.tsx:169` 还原失败 | 可构造但未做：`updateModelProvider` 拒绝 502 | `upstream_unavailable` | action → error/global，8000ms | 未做：观察 `upstream_unavailable` / `global` | 需确认保存前快照仍可用 |
| `CodexGroups.tsx:440` 读取全局 Skills 失败 | 实证：`api.globalSkills` 拒绝 409 `AUTH_INVALID` | `auth_expired` | page（常驻） | `AUTH_INVALID 从能力组动作路由到 page`：page store 为 `auth_expired` / `page` | 实证：没有回退为 Skills 局部块 |
| `CodexGroups.tsx:579` 安装 Skill 失败 | 可构造但未做：`api.installSkill` 拒绝可分类响应 | 依响应 `classifyFailure` | action → error/global，或 AUTH → page | 未做：观察对应属性 | 需确认路径草稿保留、busy 复位 |
| `CodexGroups.tsx:653` 切换 Skill 启用态失败 | 可构造但未做：`api.setSkillEnabled` 拒绝可分类响应 | 依响应 `classifyFailure` | action → error/global，或 AUTH → page | 未做：观察对应属性 | 需确认 checkbox 不被错误回写 |
| `CodexGroups.tsx:468` 卸载 Skill 失败 | 可构造但未做：确认后 `api.removeSkill` 拒绝可分类响应 | 依响应 `classifyFailure` | action → error/global，或 AUTH → page | 未做：观察对应属性 | 需确认失败 Skill 行仍在、busy 复位 |
| `McpPanel.tsx:117` 初次读取或连接测试失败 | 可构造但未做：`listMcpServers` / `refreshMcpServers` 拒绝 502 | `upstream_unavailable` | region（常驻） | 未做：观察 `region-error` 的 `upstream_unavailable` / `region` | 保留已知服务器；不重复 toast |
| `McpPanel.tsx:132` 原子保存成功 | 可构造但未做：`updateMcpServer` 返回 `atomic:true` | 非故障 | success/global，5000ms | 未做：观察 `success` / `global` | 需确认随后刷新列表 |
| `McpPanel.tsx:134` 非原子保存告知 | 可构造但未做：`updateMcpServer` 返回 `atomic:false` | 非纯故障，保留服务端部分成功信息 | warning/global，5000ms | 未做：观察 `warning` / `global` | 不伪报为失败，仍刷新状态 |
| `McpPanel.tsx:261` 切换 MCP 启用态失败 | 可构造但未做：`api.updateMcpServer` 拒绝可分类响应 | 依响应 `classifyFailure` | action → error/global，或 AUTH → page | 未做：观察对应属性 | 需确认开关不被错误回写 |
| `McpPanel.tsx:295` OAuth 登录成功 | 可构造但未做：`loginMcpServer` 返回授权 URL | 非故障 | info/global，5000ms | 未做：观察 `info` / `global` | 不在夹具中打开真实浏览器 |
| `McpPanel.tsx:300` OAuth 登录失败 | 可构造但未做：`api.loginMcpServer` 拒绝可分类响应 | 依响应 `classifyFailure` | action → error/global，或 AUTH → page | 未做：观察对应属性 | 需确认不调用 `window.open` |
| `McpPanel.tsx:322` OAuth 登出失败 | 可构造但未做：`api.logoutMcpServer` 拒绝可分类响应 | 依响应 `classifyFailure` | action → error/global，或 AUTH → page | 未做：观察对应属性 | 需确认服务器行仍保留 |
| `McpPanel.tsx:145` 删除 MCP 失败 | 可构造但未做：确认后 `api.removeMcpServer` 拒绝可分类响应 | 依响应 `classifyFailure` | action → error/global，或 AUTH → page | 未做：观察对应属性 | 需确认失败服务器未从列表消失 |
| `McpPanel.tsx:456` 创建 MCP 失败 | 可构造但未做：`api.createMcpServer` 拒绝 400 `VALIDATION_ERROR` | `validation` | field（常驻）；非 validation 走 global 或 AUTH → page | 未做：观察 `inline-error` 的 `validation` / `field` | 草稿保留，创建按钮 busy 复位 |
| `CodexGroups.tsx:667` 卸载 Skill 确认 | 实证：点击卸载再取消 | 非故障；`needsConfirm("uninstall-skill")` 为真 | ConfirmDialog，危险操作且默认焦点取消 | `卸载 Skill 默认聚焦取消，取消不调用卸载接口`：焦点为取消，`removeSkill` 0 次 | 实证：取消零卸载请求 |
| `McpPanel.tsx:338` 删除 MCP 确认 | 实证：点击删除再取消 | 非故障；`needsConfirm("delete-mcp-server")` 为真 | ConfirmDialog，危险操作且默认焦点取消 | `删除 MCP 默认聚焦取消，取消不调用删除接口`：焦点为取消，`removeMcpServer` 0 次 | 实证：取消零删除请求 |

## MCP 状态、空态与 loading

| 项 | 标签 | 证据 |
| --- | --- | --- |
| `serverInfo:null` / `unknown` | 实证 | `serverInfo 为空时仅呈现未确认连接，不编造启动原因`：诊断详情含「未确认连接」，且不含「启动失败」「尚未启动」「命令路径」「环境变量未设置」。`failed` 仅在后端明确给出该状态时显示。 |
| `skills-project-context-empty` | 实证 | `Skill、MCP 与缺少项目上下文三处均使用 EmptyState`：项目未关联时为 `EmptyState(kind=prerequisite)`，动作设置 `#workspace`，指向工作区映射。 |
| `skills-project-context-required` | 实证 | `多项目未选择时展示行内引导，不发送 toast`：`role=status` 行内提示存在，error toast 与普通 toast 均为 0。 |
| `skills-degraded-banner` | 可构造但未做 | 保留既有「读取 Skills 目录失败，Codex 可能暂时不可用」表述，未补造失败原因；需让 `globalSkills` 拒绝非 AUTH 错误后观察。 |
| Skill 与 MCP 空态 | 实证 | `Skill、MCP 与缺少项目上下文三处均使用 EmptyState`：一次无 Skill、无 MCP、无项目夹具渲染 3 个 `empty-state`。 |
| MCP 连接测试 loading | 实证 | `连接测试忙碌一秒后同时声明 aria-busy 和仍在处理`：点击后 `mcp-panel[aria-busy=true]`，1000ms 后出现「仍在处理」。 |

## 统计与已知缺口

- 19 个调用点三分标签：实证 4、可构造但未做 15、未验证（客观障碍）0。
- 组件夹具共 7 条：unknown 文案、两个取消确认、行内项目引导、三空态、AUTH 路由、1 秒忙碌提示。
- 未覆盖的 15 个调用点均可由 API mock 构造；本片按隔离约束没有触发真实 MCP 登录、远程 HTTP、stdio 命令或真实 Skill 安装/卸载。
