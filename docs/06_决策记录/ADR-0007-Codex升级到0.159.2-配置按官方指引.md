---
id: ADR-0007
title: SuDuo 锁定的 Codex 从 0.143.0 升级到 0.159.2，模型服务配置按 OpenAI 官方指引
doc_type: adr
status: accepted
supersedes: []
superseded_by:
date: 2026-09-30
---

# ADR-0007: SuDuo 锁定的 Codex 从 0.143.0 升级到 0.159.2，模型服务配置按 OpenAI 官方指引

> 一个决策一篇，记下「为什么这么定」，防止以后反复扯 / 误改
>
> **状态**：accepted ｜ **拍板人**：用户（2026-09-30「升级codex，按照openai的官方指引配置即可」）

---

## 一、背景

- SuDuo 一直锁定 `@openai/codex` 0.143.0（`CODEX_VERSION`、`client/codex-protocol/VERSION`、安装器、Windows 安装包、doctor 一致）。
- 用户的中转站模型 `gpt-6-sol` 不在 0.143 的内置模型清单里，Codex 走兜底元数据：会话里提示「模型元数据未找到」，**还不发推理强度、不开并行工具与改文件工具**；只填 `model_context_window` 消不掉提示，也调不高上限（兜底上限 272000）。当时用 `model_catalog_json` 自制清单临时顶上。
- 用户的桌面端 Codex（内置 0.158）与 CLI（0.157）内置清单里已有 `gpt-6-sol`（上下文 272000 / 最大 872000）。

## 二、决策

1. 升级到当时最新稳定版 **0.159.2**，所有版本锁一起改（依赖、`CODEX_VERSION`、协议基线、安装器、Windows 安装包的地址与 sha256、doctor、gate-a/b 的版本检查）。
2. 模型服务按 OpenAI 官方配置文档写：`[model_providers.<id>]` 的 `name` / `base_url` / `wire_api = "responses"`，Key 用 `[model_providers.<id>.auth]` 的 `command` / `args` 提供；新版内置清单已有 `gpt-6-sol`，**撤掉自制的 `model_catalog_json`**。
3. Linux 沙箱按 OpenAI 的沙箱前置条件：装系统 bubblewrap；Ubuntu 24.04 再加载官方的 `bwrap-userns-restrict` AppArmor 配置（`apt install bubblewrap` 单独不够）。
   - SuDuo doctor 新增「Codex 沙箱（Linux）」一项，异步真跑一条沙箱命令；起不来时记为「需留意」并给出上述处理办法（分清没装 bubblewrap / AppArmor 限制 / 容器 / Codex 本身没跑起来 / 超时），**不阻断安装与启动**（ADR-0004：去掉拦截最坏是需要沙箱的命令失败，人照处理办法能自己恢复）。诊断页顶部单列「命令沙箱」。
   - `install.mjs` 生成的 systemd 用户服务**去掉 `PrivateTmp`**：用户级 systemd 为它建的用户命名空间会被 Ubuntu 24.04 的 AppArmor 切到受限的 `unprivileged_userns` 配置，服务里的 Codex 沙箱随之失效（即使已按官方说明配好）。
4. 协议兼容：逐项对比 0.143 与 0.159.2 的 app-server schema 与 CLI（SuDuo 用到的请求、审批、通知全部保留，握手不变），并随升级修正：
   - 官方 doctor 的 warning 记为「需留意」不阻断（新版多了桌面端相关的 warning 项）；
   - 审批以外的服务端请求要回包：`currentTime/read` 回当前时间，其余回 -32601（不回会让回合一直等）；
   - 旧式审批四种决定对上 `ReviewDecision`（`approved` / `approved_for_session` / `{ denied: { rejection } }` / `abort`）；权限审批「批准」只授予这一回合、「本会话都允许」授予整个会话、拒绝授予空权限（`permissions` 必须是对象，旧实现的字符串从未生效）；审批卡与时间线显示要的权限范围；
   - 回了「不支持」的请求（如 Codex 请你作答、MCP 工具确认）在时间线上说明已跳过；认不出会话的审批也回包；
   - 命令审批新增 `writeStdin`（向运行中的命令输入），审批卡单独说明；
   - MCP 状态的 `toolsError` 带启动失败原文，据此判为失败并透出（收回 0.143 时的验收豁免）；
   - 推理强度按模型清单声明的档位（`gpt-6-sol` 为 low～ultra，没有 minimal），默认推理强度的服务端校验改为格式校验；**ultra（极致+）暂不提供**：它会自动分派子代理，子代理线程的审批与事件还挂不回父会话，实测支持前不开放；
   - 诊断汇总的「网络」只在可达性检查 fail 时判连不上（新版在这一项里以 warning 报桌面端更新 CDN 不可达）；
   - 安装配置里的 `SUDUO_CODEX_VERSION` 与锁定版本不一致时只提醒、不让服务起不来；配置模板去掉新版不认识的 `preferred_auth_method`；
   - 新提示（忽略了不认识的配置项、bubblewrap / 命名空间）与新错误种类本地化；无 threadId 的全局通知不再挂到唯一的会话上。

## 三、否决的方案

| 方案 | 为什么没选 |
|------|------------|
| 留在 0.143，长期用自制 `model_catalog_json` | 清单会整体替换内置目录，写错一处所有会话都起不来；要自己维护每个模型的元数据与提示词模板，偏离官方指引 |
| 让中转站的 `/models` 按 Codex 自己的格式返回 | 影响其他走 OpenAI 兼容接口的客户端，且不在 SuDuo 控制范围内 |
| 只填 `model_context_window` | 实测消不掉提示，也超不过兜底上限，推理强度照样不发 |
| Linux 上直接放开 `kernel.apparmor_restrict_unprivileged_userns` | 整机放宽安全限制；官方把它列为最后的退路，doctor 的处理办法里也放在最后 |

## 四、影响

- **好处**：`gpt-6-sol` 用上官方元数据（推理强度、并行工具、改文件工具都正常），不再需要自制清单；MCP 启动失败能看到原因；Linux 沙箱问题在 doctor 里就能发现并照着处理。
- **代价 / 风险**：0.159 会在 CODEX_HOME 里新建 `queue_1`、`thread_history_1` 等状态库，回退到 0.143 需注意；配置里有 Codex 不认识的键时每次启动都会提醒（SuDuo 已本地化说明）。
- **受影响**：`package.json`、`client/contracts`、`cloud/contracts`、`client/codex-protocol`、`client/server`（运行时、审批、doctor、MCP、模型服务）、`client/web`（提示、审批卡、设置页推理强度）、`scripts/`（安装器、Windows 安装包、gate-c 虚拟机）。

## 五、关联

| 关系 | 对象 |
|------|------|
| 相关决策 | ADR-0004（本次没有新增拒绝式守卫：doctor 的沙箱检查只告知 + 给处理办法、不阻断；版本号不一致从「拒绝启动」改为提醒） |
| 相关文档 | `docs/00_项目总览.md`、`docs/01_架构设计/client-codex-protocol-架构.md`、`docs/03_开发计划/v2-UIUX产品化重设计-技术设计.md`（变更记录） |

## 六、决策依据

- OpenAI 官方配置文档（自定义模型服务、`[model_providers.<id>.auth]`）与沙箱文档（Linux 前置条件、Ubuntu 24.04 的 AppArmor 配置）。
- 0.143 ↔ 0.159.2 的 schema / CLI 逐项对比（产物在本机 `/Volumes/Sue-SSD/Dev/tmp/suduo/codex-upgrade/`）。
- 实测：
  - 中转站真实回合在 0.159.2 上完成，无「模型元数据未找到」提示，上下文 258400；
  - 0.143 时建的旧会话能在 0.159.2 上恢复并继续；
  - Ubuntu 24.04（默认限制）虚拟机里：没装系统 bwrap、只装 bwrap 时沙箱都失败（`bwrap: loopback: Failed RTM_NEWADDR`，官方 doctor 仍报 ok），按官方步骤加载 AppArmor 配置后可用。
- 验证：见技术设计变更记录 2026-09-30「Codex 升级」一行。
