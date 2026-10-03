---
id: ADR-0008
title: 需求会话的取数改为 Codex 客户端自定义工具（dynamicTools），由本机服务执行，按代码模式设计返回格式
doc_type: adr
status: accepted
supersedes: []
superseded_by:
date: 2026-10-01
---

# ADR-0008: 需求会话的取数改为 Codex 客户端自定义工具（dynamicTools），由本机服务执行，按代码模式设计返回格式

> 一个决策一篇，记下「为什么这么定」，防止以后反复扯 / 误改
>
> **状态**：accepted ｜ **拍板人**：用户（2026-09-30 拍板「普通 Codex 会话 + 本机服务提供的需求工具」，具体机制交技术方案实测后定；2026-10-01 授权 Claude 按实测结论推进）

---

## 一、背景

[需求会话上下文重做](../02_需求设计/v2-需求会话上下文重做-需求.md) 决定：需求信息不再靠「快照目录 + 现状文件 + 简报规则 + 注释标记」转交，改由本机 SuDuo 给会话提供工具，模型要什么自己取。需求文档把具体机制留给实测：Codex 0.159.2 的实验性客户端自定义工具（`thread/start` 的 `dynamicTools`，Codex 以 server request `item/tool/call` 让客户端执行），或每个会话单独挂一个 MCP 服务。

需要验证三点：中转站模型能否调用、能否把图片交给模型看、等待界面确认期间会不会超时。

### 实测（2026-10-01，Codex 0.159.2 + 用户中转站 `gpt-6-sol`，独立 CODEX_HOME，驱动脚本直连 `codex app-server`）

| # | 场景 | 结果 |
|---|---|---|
| T1 | 模型调用自定义工具 | ✅ 正常调用，参数按 inputSchema 传入 |
| T2 | 工具返回图片（`inputImage` + data URL） | ✅ 模型正确读出截图里的订单号、颜色、红字。但见下方「代码模式」 |
| T3 | 进程重启后 `thread/resume` 续接线程再调工具 | ✅ 工具清单随线程持久化，续接不用重传（`ThreadResumeParams` 本来也没有这个字段） |
| T4 | 工具调用挂起 10 分钟再回包（模拟等用户确认） | ✅ 不超时，回包后模型如实回报结果。但代码模式的 `exec` 每 50–75 秒让出一次，模型每次都写一句「仍在等待」（10 分钟 9 句）；写工具说明里加「等待期间不要输出进度消息、把等待时间设到最大」后，200 秒等待期间一句都没有、只调用一次 |
| T5 | `initialize` 需 `capabilities.experimentalApi = true` | SuDuo 握手早已开启（`stdio-codex-transport.ts`） |

**代码模式**：模型目录里 `gpt-6-sol` 的 `tool_mode` 是 `code_mode_only`。所有工具（含自定义工具）都包在一个 `exec` JS 环境里，模型写 `await tools.<name>(args)` 调用；声明是 `Promise<unknown>`，**实际返回字符串**：文本项按行拼接，图片项变成一行 `data:image/...` 地址。模型要用 `text()` / `image()` 把结果交回给自己。

- 工具说明不写返回格式时：模型先 `text()` 打印了整串 data URL（多花约 1.4 万 token），再调第二次才用 `image()` 看图——**每个工具都被调了两次**。写操作若也重复，会出现两张确认卡。
- 工具说明写明返回格式和查看写法后（「第一行是说明，图片随后每行一个 data:image 地址，用 `image()` 查看」）：两次实测都是**每个工具只调一次**、图片一次看到。

## 二、决策

1. **取数用 `dynamicTools`**：需求会话与项目会话（项目已关联远程项目）在 `thread/start` 时挂一组 `suduo_*` 工具；`item/tool/call` 由本机服务执行并回包。工具在本机服务进程里执行，不受 Codex 沙箱档位影响，询问 / 自动 / 完全访问三档行为一致；工具只挂在这些线程上，其他会话看不到。
2. **返回格式按代码模式设计，同时兼容直出模式**：
   - 文本结果用一个 `inputText`，内容是精简的 Markdown；
   - 图片用 `inputText`（说明）+ `inputImage`（data URL）；代码模式下变成「说明行 + data URL 行」，直出模式下是真图片；
   - 工具说明里写明返回格式与 `text()` / `image()` 的写法；写工具的说明再加「会停住等用户确认，等待期间不要输出进度消息」；
   - 大内容（非图片附件、确认版文件、超长文本）存到项目目录 `.suduo/requirements/<需求>/materials/`，返回路径。
3. **对外写操作（发评论、发布确认版）在工具调用里停住**，复用现有审批表与审批坞做确认卡（`kind = other`，载荷标明是 SuDuo 工具）：确认后执行并把结果回给模型；拒绝回「用户未同意」；本机服务重启、Codex 连接断开、Codex 发 `serverRequest/resolved`（回合被中断）时确认卡作废。这是 ADR-0004「共享服务上的 append-only 写入须经用户显式确认」红线的执行器。
4. **同一会话里重复的写请求不拒绝，只告知**：确认卡上标出「本会话 X 时已发过相同内容」（ADR-0004：检测保留，响应改为告知，由人决定）。
5. **工具执行不在 Codex 订阅循环里 await**：循环是串行的，所有会话共用；工具异步执行，完成后按连接 ID 回包，连接已换代则丢弃并记日志。
6. **协议漂移**：`DynamicTool*`、`item/tool/call`、`serverRequest/resolved` 已在 `client/codex-protocol/baseline-manifest.json` 的覆盖范围内，升级 Codex 时 `pnpm protocol:diff` 会报出变化；另加一条真实 Codex 的工具调用检查（gate-a 步骤），升级时一起跑。
7. **备选方案保留但不实现**：每会话挂一个 MCP 服务。只有当 `dynamicTools` 在后续 Codex 版本被移除或行为不再满足上面三点时才启用，工具清单与返回格式不变。

## 三、否决的方案

| 方案 | 为什么没选 |
|------|------------|
| 维持「快照文件 + 现状文件 + 简报规则 + 注释标记」 | 就是要拆掉的绕路：开头 33 秒走流程、截图看不到、术语外泄、标记裸露、刷新即失效 |
| skill 里让模型调本机 HTTP 接口 | 询问档沙箱不能联网，必须开完全访问；端口、凭据、shell 差异各要处理；实测开发环境与 Linux 根本没装上 |
| 每会话挂一个 MCP 服务 | 要按会话起停进程或长连接、往线程配置里注册、写操作要走 MCP elicitation；`dynamicTools` 实测已满足要求，没必要多一层 |
| 自制模型目录关掉代码模式 | ADR-0007 已撤掉自制目录；`gpt-6-sol` 被声明为只走代码模式，强行改成直出是在跟模型的训练方式对着干 |
| 写操作「先返回待确认，确认后界面补发结果」 | 模型拿不到真实结果，要靠用户再说一遍；实测挂起等待可行（见第六节），不需要 |

## 四、影响

- **好处**：开场只给一张几百字的需求卡；图片附件一次调用就能看到；只读操作不再弹确认；写操作的确认刷新页面后还在；不再有探测、现状文件刷新、注释标记解析这些易碎环节。
- **代价 / 风险**：
  - `dynamicTools` 是实验性接口，Codex 升级可能改字段——用 `protocol:diff` + gate-a 真实检查兜住，备选是每会话 MCP 服务；
  - 代码模式的返回格式依赖工具说明里的写法提示，模型偶尔仍可能多调一次只读工具（无副作用）；写工具靠确认卡兜底，并在卡上告知重复；
  - 旧需求会话的线程创建时没有工具，续接也加不上，只能标「旧版会话」，提示新建。
- **受影响**：`client/server` 的 Codex 运行时（`item/tool/call`、`serverRequest/resolved`）、会话创建、审批服务；`client/web` 审批坞、时间线、Markdown 链接；需求会话上下文闭环与 PM 需求前置闭环两份旧方案中的「现状文件」「skill 拉取 / 发布」部分。

## 五、关联

| 关系 | 对象 |
|------|------|
| 相关决策 | ADR-0003（默认不预拉材料，保留）、ADR-0004（写操作确认是红线执行器；重复只告知不拒绝）、ADR-0007（Codex 0.159.2，代码模式来自它的内置模型目录） |
| 取代 / 修订 | 修订 [会话需求上下文闭环](../02_需求设计/v2-会话需求上下文闭环-需求.md) 的「现状文件」方案与 [PM 需求前置闭环](../02_需求设计/v2-PM需求前置闭环-需求.md) 的「skill 调本机服务」方案 |
| 相关文档 | [需求会话上下文重做 需求](../02_需求设计/v2-需求会话上下文重做-需求.md)、[技术设计](../03_开发计划/v2-需求会话上下文重做-技术设计.md) |

## 六、决策依据

- 实测脚本与日志：会话 scratchpad `dyn/probe.mjs`（basic / introspect / wait / resume 四个场景）。关键原始事件：`custom_tool_call name="exec" input="const r = await tools.zj_attachment_view(...)"`，第一次 `text(r)` 输出 data URL 文本，第二次 `image(m[0])`。
- 模型目录：`codex debug models` 中 `gpt-6-sol` 的 `tool_mode: "code_mode_only"`。
- 协议：`ThreadStartParams.dynamicTools`、`DynamicToolCallParams { threadId, turnId, callId, namespace, tool, arguments }`、`DynamicToolCallResponse { contentItems, success }`、`ServerRequestResolvedNotification { threadId, requestId }`（`codex app-server generate-ts --experimental`）。
- T4 挂起等待：

| 挂起时长 | 工具说明 | 结果 |
|---|---|---|
| 10 分钟 | 只写「需要用户确认」 | 不超时；回包后正确回报；等待期间模型写了 9 句「仍在等待」 |
| 200 秒 | 加「等待期间不要输出进度消息，把等待时间设到最大」 | 不超时；一次调用；等待期间没有任何消息 |
