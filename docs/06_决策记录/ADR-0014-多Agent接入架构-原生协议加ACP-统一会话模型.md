---
id: ADR-0014
title: 多 Agent 接入架构：Codex 与 Claude Code 走各自官方接口，其余 Agent 走 ACP；Agent 由配置表声明；会话事件、权限档位、能力集合统一为与 Agent 无关的模型
doc_type: adr
status: accepted
supersedes: []
superseded_by:
date: 2026-10-08
---

# ADR-0014: 多 Agent 接入架构

> 一个决策一篇，记下「为什么这么定」，防止以后反复扯 / 误改
>
> **状态**：accepted（2026-10-08 用户「按照你的规划开始推进」） ｜ **拍板人**：用户（2026-10-08：「claude code和acp同时一起做」「我们应该也要复用本机登录的cli为先」）；架构细节由 Claude 推荐，待用户确认

---

## 一、背景

用户原话：「当前系统智能支持codex cli，集成的llm或者ai能力太弱」。SuDuo 目前只接 Codex（app-server JSON-RPC，锁 0.159.2）。虽然有 `AgentRuntime` 接口与 `RuntimeRegistry`，但三处与 Codex 绑死：

1. **事件内容是 Codex 的条目形状**：事件名是通用的（`item.started` 等），载荷却原样是 Codex 的 `agentMessage` / `commandExecution` / `fileChange` / `mcpToolCall`，前端时间线直接按这些类型渲染。
2. **安全模型是 Codex 语义**：契约里写的是 `approvalPolicy` + `sandbox`（read-only / workspace-write / danger-full-access）。Claude 只有权限模式，ACP 没有沙箱概念。
3. **需求工具走 Codex 独有的 `dynamicTools`**（ADR-0008，本次由 ADR-0015 取代）。

另外，云端 `agents` 表有约束 `kind IN ('codex')`，房间共享 Agent 也只认 Codex。

2026-10-08 研读了开源多 Agent 工作台 Tutti（Apache-2.0，Go）。它的做法是：主力 Agent 保留原生协议（Codex 走 app-server；Claude Code 早期用社区 ACP 适配包问题多，改为官方 Agent SDK），其余 Agent（OpenCode、Cursor、Kimi、Qwen Code、Gemini、CodeBuddy 等）走 ACP；所有输出翻译成同一套「会话 / 回合 / 消息 / 工具调用 / 交互」实体；Agent 由一张描述符表声明（安装、鉴权、启动、模型、权限档位、能力）；适配器只有很小的必选接口，其余是可选能力。

SuDuo 面向全球，重点是东南亚工作室与欧美小团队（用户 2026-10-08）。这些地区都在 Anthropic 与 OpenAI 的支持范围内，Claude Code 与 Codex 是主力；同时 ACP 覆盖了团队里大量已有的订阅与低成本选择：
- GitHub Copilot CLI（`copilot --acp`，2026-01 起公测）——欧美很多团队已经为 Copilot 付费；
- Gemini CLI（`--acp`）——免费额度大，对预算紧的东南亚成员友好；
- Cursor CLI（`cursor-agent acp`）、OpenCode（`opencode acp`，可接任意模型服务）；
- Qwen Code（`qwen --acp`，已收录在 ACP 官方注册表）、Kimi Code CLI（`kimi acp`）——低价模型。

所以 ACP 对 SuDuo 不只是「接长尾」：成员已有的 Copilot 订阅、免费的 Gemini、便宜的开源模型都靠它进来。

## 二、决策

1. **三条接入通道**：
   | 通道 | Agent | 理由 |
   |---|---|---|
   | Codex app-server（现有） | Codex | 官方为「在自己产品里深度集成」提供的接口，能力最全；保持版本锁定（ADR-0007） |
   | Claude Agent SDK（TypeScript，在本机服务进程内调用） | Claude Code | 官方库，提供审批回调、hooks、中断、续接、分叉；SuDuo 本身是 Node，不需要侧车进程；SDK 驱动用户本机已安装的官方 `claude`（ADR-0016） |
   | ACP（Agent Client Protocol，stdio JSON-RPC） | GitHub Copilot CLI、Gemini CLI、Cursor CLI、OpenCode、Qwen Code、Kimi Code 等 | 一个通用客户端接一批 Agent；各家差异用声明式配置 + 少量钩子补齐 |
2. **Agent 由配置表声明**（`client/server` 内置一张表，后续可扩展为外部清单）：标识与显示名、接入通道与启动命令、可执行文件名与最低版本、登录状态检查命令与登录命令、安装说明、模型列表来源、权限档位映射、能力集合、条款要点链接（ADR-0016 第 8 条）。新增一家 ACP Agent 原则上只加一条配置。
3. **统一会话模型：SuDuo 契约自有，字段以 Codex 条目为基线**。在 `client/contracts` 里定义并版本化 SuDuo 自己的条目类型——用户消息、助手消息、推理摘要、命令执行（命令、目录、输出、退出码、耗时）、文件改动（路径、类型、统一 diff）、工具调用（服务、名称、入参、结果，合并现在的 `mcpToolCall` 与 `dynamicToolCall`）、网页搜索、计划、子 Agent、上下文压缩、系统提示；交互类型——命令审批、文件审批、权限审批、提问、工具确认，审批载荷带中立的「对象」字段与由适配器声明的可选决策。字段沿用 Codex 条目的命名与结构（它最完整，现有前端、账本 SQL、会话预览、房间进度与全部历史数据都按它建），所以 Codex 适配器近乎原样映射、已存历史不用改写也不用翻译；Claude、ACP 适配器把各自输出翻译成同形条目，原始载荷留在 `extensions.<agent>` 里供诊断。前端只按契约渲染，遇到未知条目显示通用卡片。没选「全新中立模型 + 读取时翻译历史」：收益只是命名更干净，代价是前端时间线、账本 SQL、房间进度全部重写外加一层历史翻译。
4. **统一权限档位**：只读 / 写前询问 / 自动 / 完全访问，四档语义写在契约里（沿用现有 `approvalMode`，增加 `readonly`）；每家 Agent 的配置给出映射（例如 Codex 只读 = `never` + 只读沙箱 + 可联网，即现在房间任务的组合；写前询问、自动、完全访问沿用现有三档组合；Claude 写前询问 = `default`、自动 = `acceptEdits`、完全访问 = `bypassPermissions`；ACP 按各家的 mode 映射，并由 SuDuo 按档位自动通过或拒绝权限请求）。Agent 做不到某档时，档位选择器标明「此 Agent 不支持」或说明实际效果，不假装做到。
5. **能力按 Agent 声明并在运行时收窄**：图片输入、计划模式、中途插话、分叉、压缩、用量、模型切换、Skill 等，描述符先声明，运行时按 Agent 实际报告收窄；界面只显示当前 Agent 有的能力。
6. **适配器接口：必选很小，其余可选**。沿用现有 `AgentRuntime`（建线程、开回合、审批、中断、订阅事件），把 Codex 专有的参数（`security` 的沙箱字段、`dynamicTools`、`respondToolCall`）移到 Codex 适配器内部或改为通用形态（权限档位、MCP 注入）。
7. **进程模型按通道**：Codex 维持一个共享 app-server 进程（现状）；Claude 由 SDK 为每个查询拉起 `claude` 子进程；ACP 每个会话一个进程，空闲 30 分钟回收，只回收能 `session/load` 或 `session/resume` 的 Agent，回收时不发 `session/close`（会毁掉 Agent 侧历史）。
8. **会话历史以 SuDuo 自己的事件账本为准**：续接时不依赖 Agent 回放历史（ACP 的 `session/load` 回放丢弃）。
9. **房间共享 Agent 支持任意接入的 Agent**：云端 `agents.kind` 放开为描述符里的 Agent 标识；房间任务固定用只读档，并由 SuDuo 拒绝该会话里所有写入类权限请求与文件写入；若某家 Agent 的最严格模式仍可能不经询问写文件，它不能被共享进房间（ADR-0004「删除或覆盖用户文件」红线，唯一的拒绝）。

## 三、否决的方案

| 方案 | 为什么没选 |
|------|------------|
| 全部走 ACP（含 Codex、Claude） | ACP 只覆盖各家能力的公共部分；Codex 的审批缓存、计划、用量、分叉，Claude 的 hooks、权限回调会丢；Tutti 用社区 Claude ACP 适配包踩过补丁、用量显示错误、启动失败等问题后放弃 |
| Claude 直接驱动 `claude -p --output-format stream-json` | 等于自己重写 Agent SDK 的控制协议（审批回调、中断、权限模式切换）；SDK 同样驱动未修改的官方二进制，合规上没有差别（ADR-0016） |
| 照 Tutti 用 Go 侧车 / 独立守护进程 | SuDuo 的本机服务本来就是 Node，SDK 进程内调用即可；多一个进程只增加故障面 |
| 每个会话一个 Codex 进程（Tutti 的做法） | 好处是会话级配置隔离，代价是进程数与回收机制；SuDuo 现有需求（含 MCP 注入）用线程级配置覆盖即可满足，暂不需要 |
| 前端按 Agent 分别渲染时间线 | 每加一家改一次前端；跨 Agent 的引用、交接、汇总都要求统一模型 |
| Tutti 那套目标模式持久化流程、进程录制回放、冒用官方客户端名 | 前两者对 SuDuo 当前阶段过重；后者踩合规线（ADR-0016） |

## 四、影响

- **好处**：成员可以带着自己已有的 Agent 与订阅用 SuDuo，贵的和便宜的可以混用；界面、审批、需求工具、房间共享对所有 Agent 一致；后续跨 Agent 协作（接力、互评、引用）有统一数据基础。
- **代价 / 风险**：
  - 前端时间线与会话预览、运行状态、房间进度都要改为消费统一模型，是本次最大的改动面；老会话因条目模型以 Codex 为基线而直接兼容，不需要翻译。
  - 每家 ACP Agent 都有怪癖（日志混进输出、取消后不收尾、审批请求先于工具入参到达等），要按 Tutti 记录的坑逐个防。
  - Claude 订阅登录的剩余合规风险由用户接受，只提示不限制（ADR-0016 第 9、10 条）。
  - 云端 `agents` 表迁移、契约增加 Agent 标识，老客户端与新云端要兼容。
- **受影响**：`client/contracts`（runtime、events）、`client/server`（运行时装配、事件链路、审批、会话工具、房间任务、诊断、设置）、`client/web`（时间线、审批坞、开工对话框、设置页）、`cloud`（agents 表与共享 Agent 契约）、gate 脚本、官网与 README 定位。

## 五、关联

| 关系 | 对象 |
|------|------|
| 相关决策 | ADR-0004（一致性边界）、ADR-0007（Codex 版本锁定）、ADR-0009（房间共享 Agent 数据边界）、ADR-0015（工具层改为本机 MCP）、ADR-0016（AI 账号凭据边界） |
| 相关文档 | [v3 规划](../02_需求设计/v3-多AI工具与多Agent协作规划-需求.md)、[多 Agent 接入需求](../02_需求设计/多Agent接入与本机工具服务-需求.md)、[技术设计](../03_开发计划/多Agent接入与协作-技术设计.md) |
| 参考 | Tutti 源码（本机 `/Volumes/Sue-SSD/Dev/tmp/suduo/research/tutti`，`packages/agent/daemon/`） |
