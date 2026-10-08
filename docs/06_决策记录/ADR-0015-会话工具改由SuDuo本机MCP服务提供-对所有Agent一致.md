---
id: ADR-0015
title: 会话工具改由 SuDuo 本机 MCP 服务提供，对所有 Agent 一致；Codex dynamicTools 只作迁移期兼容
doc_type: adr
status: accepted
supersedes: [ADR-0008]
superseded_by:
date: 2026-10-08
---

# ADR-0015: 会话工具改由 SuDuo 本机 MCP 服务提供

> 一个决策一篇，记下「为什么这么定」，防止以后反复扯 / 误改
>
> **状态**：accepted（2026-10-08 用户「按照你的规划开始推进」） ｜ **拍板人**：用户授权 Claude 按长期最优定（2026-10-08：「这个你按照项目的长期发展、最优优化方案进行处理」），待用户确认

---

## 一、背景

ADR-0008 让需求会话通过 Codex 的 `dynamicTools` 拿到 `suduo_*` 工具（读需求、读评论附件、读写结论笔记、查房间历史、发评论等，当前 10 个）。它在只接 Codex 时是最省事的做法，当时把「每会话挂一个 MCP 服务」列为备选。

现在 SuDuo 要同时接 Claude Code 与 ACP 协议的多家 Agent（[多 Agent 接入与本机工具服务](../02_需求设计/多Agent接入与本机工具服务-需求.md)）。`dynamicTools` 是 Codex 独有的实验接口，其他 Agent 都没有对应物；而 MCP 是各家共同支持的工具接口：

| Agent | 能接 SuDuo 的 MCP 吗 | 依据 |
|---|---|---|
| Codex 0.159.2 | 能。配置支持 Streamable HTTP、`http_headers`、`bearer_token_env_var`、`tool_timeout_sec`、按工具的 `approval_mode`；`thread/start` 带 `config` 覆盖（ADR-0009 已用它关掉所有者的 MCP） | 0.159.2 二进制字符串与生成的协议类型 |
| Claude Code（Agent SDK） | 能。`mcpServers` 选项支持 HTTP；SDK 还能在进程内定义工具 | Agent SDK 文档；Tutti 实现 |
| ACP Agent | 大多能。`session/new` 带 `mcpServers`，Agent 在 `initialize` 里声明 `mcpCapabilities.http` | ACP 协议；Tutti 实现 |

参照：Tutti（开源多 Agent 工作台）的第三方能力（Connector）全部聚合成一个本机 HTTP MCP 服务注入给所有 Agent；它自己的业务能力则走「CLI + Skill 说明书」，代价是 Codex 必须给每个命令前缀开免审批规则、沙箱开网络。

另外，SuDuo 的开发者大多有自己常用的 Agent（在终端或 IDE 里），他们希望不离开习惯的环境也能拿到需求上下文。MCP 是各家 Agent 通用的扩展方式，同一个服务以后可以给 SuDuo 之外启动的 Agent 用。

## 二、决策

1. **工具层统一为 SuDuo 本机 MCP 服务**。本机服务（`client/server`）内置一个 Streamable HTTP MCP 端点，只监听 `127.0.0.1`。工具的业务实现（现 `session-tools/` 下的需求、笔记、房间工具）保持一份，MCP 只是外壳。
2. **按会话签发令牌，令牌即身份**。每个会话（含房间任务会话）启动时签发一个随机令牌，映射到该会话的工具上下文（会话、项目、需求、房间、能用哪些工具）。Agent 以 `Authorization: Bearer <令牌>` 调用。本机只存令牌哈希；每次建线程或续接时重新签发并注入新令牌，旧令牌随即作废；会话删除时全部作废。不同会话看到的工具清单可以不同（例如房间任务不挂写工具，ADR-0009）。
3. **各 Agent 的接入方式**：
   - Codex：`thread/start` / `thread/resume` 的 `config` 覆盖里写入 `mcp_servers.suduo`（地址、请求头、超时）。能否按线程新增 MCP 服务须在技术设计 S0 实测；不行时退到「全局登记一个 suduo 服务 + 按线程覆盖请求头」，再不行则 Codex 保留 dynamicTools（见第 6 条）。
   - Claude Code：Agent SDK 的 `mcpServers` 选项。
   - ACP：`session/new` / `session/load` 的 `mcpServers`；Agent 没声明 HTTP MCP 能力时，界面告知「这个 Agent 用不了 SuDuo 需求工具」，会话照常可用。
4. **对外写操作的确认**（发评论等，ADR-0004「共享服务上的 append-only 写入须经用户显式确认」）：MCP 服务收到写工具调用后挂起，在 SuDuo 界面弹出确认卡（沿用审批坞）；用户确认后执行并返回结果，拒绝返回「用户未同意」。给各 Agent 配足够长的工具超时。**若 Agent 那边先超时或回合被中断，这次写请求不丢**：转成一条「待发出的草稿」留在本机这个会话里，用户仍可在界面上确认发出或丢弃（草稿不上传服务器）。
5. **返回格式**：文本用 Markdown；图片用 MCP 的 image 内容；大文件仍存到项目 `.suduo/` 下返回路径（ADR-0003）。ADR-0008 里为 Codex「代码模式」写的返回格式说明（`text()` / `image()`）作为 Codex 专用的工具说明附注保留，以实测为准。
6. **dynamicTools 只作迁移期兼容**：Codex 切到 MCP 并通过 gate 后，dynamicTools 路径停用；已有 Codex 线程的工具清单存在线程记录里（续接不重传），这些老线程继续按老路径服务到自然结束，不强行迁移。
7. **工具用法说明随 Agent 下发**：每个 Agent 的指令通道不同（Codex 的 developer instructions、Claude 的 system prompt 追加、ACP 首条消息），工具说明写一份，按通道投递。
8. **SuDuo 外部启动的 Agent 接入**（用户自己终端里的 Claude Code / Codex 等）列入后续需求：用同一个 MCP 服务 + 用户级令牌 + 项目目录识别，不在本次范围内。
9. **跨 Agent 协作**（读另一个会话、委派、评审）由 P2 通过同一个 MCP 服务的协作工具实现，等待采用「有上限的等待 + 返回进度」避开工具超时（ADR-0017）；不引入「CLI + Skill」通道。

## 三、否决的方案

| 方案 | 为什么没选 |
|------|------------|
| 维持 dynamicTools，其他 Agent 各写一套 | Claude、ACP 没有对应接口；每家一套等于把工具层写三遍 |
| 全部走「CLI + Skill」（Tutti 的做法） | Codex 询问档沙箱不能联网，要么开完全访问、要么逐条开免审批规则（ADR-0008 曾否决「skill 里让模型调本机 HTTP」也是此因）；工具调用在时间线上只是一条 shell 命令，丢了结构化的工具语义；图片返回不便 |
| 每个会话起一个独立 MCP 进程 | 进程多、起停慢；按令牌区分会话的单一服务足够 |
| 写操作改成「只交草稿、永不在调用里等待」 | Agent 拿不到「发出了吗」的结果，会在回答里瞎说；挂起等待 + 超时降级为草稿两头兼顾 |

## 四、影响

- **好处**：一套工具服务所有 Agent；新增 Agent 只要它支持 MCP 就自动获得需求工具；为「外部 Agent 接入 SuDuo」铺好路；房间任务与普通会话按令牌区分权限，比按线程挂工具更清楚。
- **代价 / 风险**：
  - 本机多一个 HTTP 端点，令牌必须只给对应会话的 Agent，且只听 127.0.0.1（沿用 LoopbackGuard 的思路）。
  - 各 Agent 的 MCP 超时与确认交互不一样，挂起确认要逐家实测；超时降级为草稿要有界面。
  - Codex 按线程注入 MCP 的能力未实测，S0 不通过时 Codex 仍走 dynamicTools，两条路径并存更久。
- **受影响**：`client/server` 会话工具层与审批服务、需求会话与房间任务的建线程流程、gate 中的工具调用检查、ADR-0008（被本篇取代）。

## 五、关联

| 关系 | 对象 |
|------|------|
| 取代 | ADR-0008（需求会话取数用 Codex dynamicTools） |
| 相关决策 | ADR-0003（大材料存 `.suduo/` 按需拉取）、ADR-0004（写操作须显式确认、不丢数据）、ADR-0009（房间任务不挂写工具）、ADR-0014（多 Agent 接入架构） |
| 相关文档 | [多 Agent 接入需求](../02_需求设计/多Agent接入与本机工具服务-需求.md)、[技术设计](../03_开发计划/多Agent接入与协作-技术设计.md) |
