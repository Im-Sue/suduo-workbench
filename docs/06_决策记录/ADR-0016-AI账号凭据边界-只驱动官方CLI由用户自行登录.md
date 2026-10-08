---
id: ADR-0016
title: AI 账号凭据边界：SuDuo 只驱动用户本机未修改的官方 CLI，登录由用户在官方流程里完成，SuDuo 不读取、不存储、不转发任何 AI 账号凭据
doc_type: adr
status: accepted
supersedes: []
superseded_by:
date: 2026-10-08
---

# ADR-0016: AI 账号凭据边界——只驱动官方 CLI，由用户自行登录

> 一个决策一篇，记下「为什么这么定」，防止以后反复扯 / 误改
>
> **状态**：accepted（2026-10-08 用户「按照你的规划开始推进」） ｜ **拍板人**：用户（2026-10-08：「我们应该也要复用本机登录的 cli 为先」；「我觉得我们可以做提示但是不应该限制用户，毕竟用户使用claude code是用户自身的限制和我们作为一个工具提供一个能力没有关系？本身我们也不篡改和私自获取用户、claude code的敏感信息？」）；合规细则由 Claude 按各家官方条款整理

---

## 一、背景

SuDuo 要从只接 Codex 扩展到 Claude Code 与 ACP 协议的多家 Agent（[多 Agent 接入与本机工具服务](../02_需求设计/多Agent接入与本机工具服务-需求.md)）。用户的方向是「复用本机已登录的 CLI 为先」：成员已经在自己电脑上装好、登录好 Codex / Claude Code / Gemini CLI 等，SuDuo 直接用，不另配 Key。

各家对「第三方产品复用用户订阅」的态度不一样，2026-10-08 查到的官方原文：

**Anthropic（Claude Code）**，[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)：

> Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services … requires agreeing to our Commercial Terms of Service and complying with the conditions below:
> - The Claude Code binary must not be modified. … customers may not remove, disable, or restrict any authentication method built into it …
> - Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential …

> Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication … Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

> … Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription …

> Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK.

命名：可以如实写「支持 / 运行 Claude Code」，不能把 Claude Code 或 Anthropic 的名字、标志用作自己产品或功能的名字，也不能暗示对方背书。

**OpenAI（Codex）**：app-server 的定位就是「deep integration inside your own product: authentication, conversation history, approvals, and streamed agent events」（[App Server](https://learn.chatgpt.com/docs/app-server)），SuDuo 现在就是这么接的。ChatGPT 使用条款：「You may not share your account credentials or make your account available to anyone else」。

**Google（Gemini CLI）**，[Terms of Service and Privacy Notice](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md)：「Directly accessing the services powering Gemini CLI (for example, the Gemini Code Assist service) using third-party software, tools, or services (for example, using OpenClaw with Gemini CLI OAuth) is a violation of applicable terms and policies.」——禁止的是拿 CLI 的登录凭据绕过 CLI 直接调后端，驱动 CLI 本身不在此列。

**GitHub（Copilot CLI）**：Copilot CLI 自 2026-01 起提供 ACP 服务端（`copilot --acp`），官方文档把「自定义前端、多 Agent 系统」列为用途（[ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)）；用量记在用户自己的 Copilot 订阅上。

参照：Tutti 的做法里有两处踩线，SuDuo 不照搬：它从 macOS 钥匙串读 Claude 的 OAuth 令牌去探测登录状态；连 Codex 时冒用官方客户端名 `codex_cli_rs`。

## 二、决策

1. **只驱动官方、未修改的 CLI**。用用户本机已安装的那份（Claude Code、GitHub Copilot CLI、Gemini CLI、Cursor CLI、OpenCode、Qwen Code、Kimi Code 等），不修改二进制、不打补丁、不去掉它自带的任何登录方式。Codex 继续随 SuDuo 捆绑锁定版本（ADR-0007），同样是官方未修改版本。
2. **登录只在官方流程里完成**。SuDuo 需要用户登录时，在终端里替用户打开官方登录命令（如 `claude auth login`、`codex login`），或提示用户自己去登录；不在 SuDuo 界面里做账号密码或 OAuth 表单。
3. **SuDuo 不碰凭据**：不读取、不复制、不存储、不转发任何 AI 账号的令牌、会话或 Key（包括钥匙串、`~/.claude/.credentials.json`、`~/.codex/auth.json` 这类文件的内容）。登录状态只通过官方 CLI 自己的命令判断（如 `claude auth status`、`codex login status`、app-server 的 `account/read`）。用户主动配置的 API Key 写在 CLI 自己的配置或用户自己的环境变量里，SuDuo 只告诉用户在哪配。
4. **不代付、不转售、不做中转**。所有用量都记在用户自己的账号上；SuDuo 不提供模型网关去「借」订阅额度给别人。
5. **连接身份如实**。协议握手里的客户端名写 `suduo`，不冒用任何官方客户端名。
6. **产品命名不用对方商标**。界面与官网可以写「支持 Claude Code / Codex / Gemini CLI」，不起「SuDuo Claude 版」之类的名字，不用对方标志作自己的图标；Agent 列表里显示对方名字时只作为如实的说明。
7. **房间共享 Agent 告知、不拦截**。成员把订阅账号驱动的 Agent 共享进房间时，共享开关旁说明：「个人订阅（如 Claude Pro / Max、ChatGPT Plus / Pro）按个人日常使用设计，团队长期共用建议改用厂商的团队或企业订阅（如 Claude Team / Enterprise、ChatGPT Business）或 API Key」。按 ADR-0009「由团队管理层负责」，系统不限制。
8. **每接入一家先核对条款**。新增一个 Agent 时，把它的条款要点与链接写进它的描述符说明，过一遍上面 1–6 条；不满足的不进默认列表。
9. **只提示、不限制**（用户 2026-10-08 拍板）。SuDuo 是工具，提供「驱动用户自己的 Agent」的能力；用户怎么用自己的 Claude、Codex、Copilot 等账号，适用的是用户与该厂商之间的条款。SuDuo 不对任何 Agent 加使用限制、不标「试用」、不按账号类型拦截。提示放两处：
   - Agent 面板每张卡片：「通过 SuDuo 使用时，用量与使用方式适用你与 {厂商} 之间的条款；SuDuo 不读取、不保存你的凭据」，附条款链接；
   - 第一次用某个 Agent 开工时提示一次（可不再提示）；Claude 的说明里同时写出 API Key / 云厂商凭据的用法，供需要的人选择。
10. **已知风险，由用户接受**。Anthropic 同一页还有一句「Developers building products … including those using the Agent SDK, should use API key authentication」，针对的是开发方而不是用户。SuDuo 的做法（只驱动未修改的官方 `claude`、不碰凭据、登录走官方流程、连接身份如实）落在原文「Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription」的范围内，但不排除对方日后收紧执行、影响用户账号或 SDK 这条接法。应对：Agent 配置表给 Claude 预留「仅 API Key」开关，需要时快速切换；不预先限制用户。
11. **发布前待办（发行方办理，不影响用户）**。原文把「同意 Anthropic 商业条款」列为产品运行 Claude Code 的前提（「requires agreeing to our Commercial Terms of Service」），这是发行方自己的手续，不是对用户的限制；何时办理由用户决定。办理时确认签约主体符合其地区政策（Anthropic 不服务「超过 50% 股权由总部在不支持地区的公司持有」的实体，[原文](https://www.anthropic.com/news/updating-restrictions-of-sales-to-unsupported-regions)）。

## 三、否决的方案

| 方案 | 为什么没选 |
|------|------------|
| 照 Tutti 读钥匙串里的 OAuth 令牌，直接请求 Anthropic 接口探测登录 | 原文禁止「collect, store, or intermediate Claude.ai credentials or session tokens」；用 `claude auth status` 已经够判断 |
| 在 SuDuo 界面内做 Claude / ChatGPT 登录 | 原文要求「sign-in … must complete through Anthropic's own flow」；Codex app-server 虽然支持应用内登录，统一走官方终端登录更简单、口径一致 |
| 做一个模型网关，让没有订阅的成员用别人的额度 | 「intermediate Claude usage」「make your account available to anyone else」两条都踩；也和 SuDuo 不碰凭据的原则冲突 |
| 只支持 API Key，不支持本机订阅 | 与用户方向「复用本机登录的 cli 为先」相反；且 Anthropic 原文明确不禁止用户在未修改的二进制里用自己的订阅登录 |
| 共享进房间时检测账号类型并禁止个人订阅 | SuDuo 不读凭据，判断不了账号类型；ADR-0009 已定由团队管理层负责，按 ADR-0004 只告知 |

## 四、影响

- **好处**：合规风险集中在一条清楚的线上；成员零配置复用自己已有的 Agent；SuDuo 不持有任何 AI 凭据，泄露面最小。
- **代价 / 风险**：
  - 登录状态只能靠各家 CLI 的状态命令，粒度和准确度受限（例如令牌过期要等真正运行时才发现）；运行中的 401 要回灌到状态显示。
  - Anthropic 若收紧对 Agent SDK 使用订阅的执行，用户的 Claude 账号或 SuDuo 的 Claude 接法可能受影响（第 10 条）；已由用户接受，靠配置开关应对。
  - 用户若在 SuDuo 之外自行把 CLI 改坏（如替换为非官方构建），SuDuo 无从判断，只在诊断里显示版本与来源。
- **受影响**：多 Agent 接入的需求与技术设计（Agent 状态检测、登录引导、描述符字段）；房间共享 Agent 的共享说明文案；官网与 README 的措辞。

## 五、关联

| 关系 | 对象 |
|------|------|
| 相关决策 | ADR-0004（只告知不拦截）、ADR-0007（Codex 版本锁定）、ADR-0009（房间共享 Agent 由团队管理层负责）、ADR-0014（多 Agent 接入架构） |
| 相关文档 | [v3 规划](../02_需求设计/v3-多AI工具与多Agent协作规划-需求.md)、[多 Agent 接入需求](../02_需求设计/多Agent接入与本机工具服务-需求.md) |
