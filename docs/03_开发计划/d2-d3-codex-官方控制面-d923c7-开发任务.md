---
doc_type: dev_task
task_id: subtask-0fbe7dd923c7
title: D2/D3 · Codex 官方控制面
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-workbench-ui-refit-001
section_id: pr4-codex-official-control-plane
order: 4
implementation_owner: ccb_codex
dependencies: [subtask-39aa6a8addc5]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-workbench-ui-refit-001.json
source_draft_hash: 539ebf4a8c5b66964ac2fa8fc30c204413962ad59f4434dc555ca2b11972a8a6
created_at: 2026-08-16T15:13:00.518Z
updated_at: 2026-08-17T02:41:47.785Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-workbench-ui-refit-001","branch":"ccb/req-suduo-v2-workbench-ui-refit-001"}
---

# D2/D3 · Codex 官方控制面

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 在 CodexRuntime 上建出 Config/Model RPC 面，重写 model-provider-service 与 doctor-service 的 Codex 侧，清掉四处自建实现，并处理 testModelProvider 三处调用点的兼容。 |
| 需求来源 | suduo-v2-workbench-ui-refit-001 |
| 本期范围 | pr4-codex-official-control-plane · D2/D3 · Codex 官方控制面 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### D2/D3 · Codex 官方控制面

#### 任务概述

这一片落实用户 2026-08-16 定的接入原则（U3）：**引入 Codex CLI 就是为了用它自带的机制，官方能力最完整最强**。现在代码里有四处自己造的替代实现，全部有官方等价路径：

| 自建实现 | 官方替代 |
|---|---|
| 正则改写 `config.toml` | `config/read`（`includeLayers:true`）／`config/batchWrite` |
| 直写 `auth.json` | `codex login --with-api-key`（stdin） |
| 自己 `fetch` provider 的 `/models` | `model/list` |
| `doctor-service` 自己 regex 解析 `config.toml` | `codex doctor --json` |

**为什么是本片先做**：`CodexRuntime` 目前**零 Config/MCP RPC 面**（已 grep 核实，`ListMcpServerStatus`/`ConfigRead`/`ModelList` 一个都没有）。MCP 那一片（pr11）要用的 RPC 也在这套面上，两片都去改 `codex-runtime.ts` 必然抢。所以由本片统一建出来。

**D2 顺带修一个缺陷**：`codexBin = SUDUO_CODEX_BIN ?? "codex"` 会裸落 PATH，在开发机上撞到全局 0.147，于是 doctor 报 fail。项目实际钉的是 workspace 的 `@openai/codex@0.143.0`。这是**二进制解析缺陷，不是版本策略问题**——`CODEX_VERSION=0.143.0` 与协议 sha256 基线一律不动。

#### 任务分解

1. `codex-runtime.ts`：建出 Config/Model RPC 面——`config/read`（支持 `includeLayers`）、`config/batchWrite`（支持 `expectedVersion`、`reloadUserConfig`）、`model/list`。这套面同时是 pr11 的地基。
2. `model-provider-service.ts`(375) 重写：删 TOML 正则改写与 `auth.json` 直写，改走上述 RPC 与 `codex login --with-api-key` / `codex login status`。
3. **D3-a 配置层级**：读取一律 `includeLayers:true` 并保留来源信息；写入带 `expectedVersion`；`ConfigWriteResponse` 返回 `okOverridden` 时**绝不能当成保存成功**，要能区分「已写入你的配置」与「当前生效值仍是 X」。同一表单多字段用 `batchWrite + reloadUserConfig:true` 一次写完。
4. **D3-b 保存并验证**：`ModelListParams` 只有 `cursor/includeHidden/limit`，**不收草稿凭据**，所以原「测试连接」语义无法保留。`PUT /api/v1/settings/model-provider` 改为「保存并验证」：`batchWrite` → `model/list` 验证 → 失败时用保存前读到的旧值一键还原（还原能力由 `config/read` 读值 + `expectedVersion` 保证，不额外存储）。
5. **`testModelProvider` 三处调用点兼容**（Codex 复核后补出，原设计漏列）：`api/client.ts:462`、`ModelSwitcher.tsx:74`、`SettingsPanel.tsx:101` 与 `:360`。`ModelSwitcher` 是**会话头**组件不是设置页，删掉 `/test` 会直接打断它——本片负责给出替代调用并改完三处。
6. 新增官方模型清单读取端点（如 `GET /api/v1/codex/models`，底层 `model/list`），供 pr10 的模型 Select 与 `ModelSwitcher` 共用。
7. `doctor-service.ts` 重写 Codex 侧：改调 `codex doctor --json`，删掉自建的 `config.toml` regex 解析。**`checks` 是以 check id 为键的对象、不是数组**（0.143 实测 18 项），按 `Object.values(checks)` 取；每项含 `id/category/status/summary/details/remediation`。SuDuo 自身检查项（Node／pnpm／better-sqlite3／端口）**保留不动**。
8. D2：`codexBin` 优先解析安装包/workspace 钉版，不裸落 PATH。

#### 验收标准

- 全仓 grep 不到对 `config.toml` 的正则改写与对 `auth.json` 的直写（只读诊断展示除外，R3 允许的例外）。
- 配置迁移前后逐字段比对一致：`providerId/baseUrl/model/reasoningEffort/contextWindow`，在含嵌套 `model_providers.<id>` 的真实 `config.toml` 上验。
- `okOverridden` 有独立处理路径与独立文案，单测覆盖；不得复用「已生效」提示。
- 「保存并验证」失败时能一键还原到保存前的值。
- `ModelSwitcher` 与 `SettingsPanel` 三处调用点全部改完且功能不回归。
- `doctor` 的 Codex 侧改用官方结果并能显示官方 `remediation`；SuDuo 侧检查项行为不变；`codexBin` 不再落 PATH（在装有全局 0.147 的机器上 doctor 不再误报）。
- server 侧 vitest 覆盖：RPC 参数拼装、`expectedVersion` 冲突、`okOverridden` 分支、`checks` 对象解析。
- `codex login --with-api-key` 走 stdin，复用既有 `decodeWindowsCommandOutput` 范式处理 Windows 编码/管道差异。

#### 边界

- **不**改 `CODEX_VERSION=0.143.0` 与协议 sha256 基线；不升级 Codex。
- **不**做 `config.toml` 全量字段可视化、`codex plugin`/marketplace、多 profile 切换。
- **不**用 `modelProviderCapabilities` 取上下文窗口——0.143 实测只返回 `imageGeneration`／`namespaceTools`／`webSearch`，上下文窗口保持用户显式输入。
- **不**为「测试未保存凭据」起隔离 `CODEX_HOME` 探测——那要暂存密钥，与 R4 冲突。
- MCP 相关 RPC 的**使用**归 pr11，本片只把 RPC 面建出来。
- **中央文件窄范围例外**：`/api/v1/settings/model-provider` 的三个处理块当前**内联**在 `http-server.ts`（`:323` GET／`:327` PUT／`:333` POST /test），本片改的正是它们的语义，因此**准许本片窄范围抽取并替换这三个既有块**（迁入 pr3 建的 `http/routes/` 缝），不受「只加 1 行注册」约束。除这三个块外，不得触碰 `http-server.ts` 其余存量路由。
- 设置页界面归 pr10。
- **跨 owner 边界**：第 5 点的三处前端调用点（`api/client.ts`、`ModelSwitcher.tsx`、`SettingsPanel.tsx`）虽是前端文件，仍**留在本片**由本片 owner 改完——它们是本片删除 `/test` 语义的直接后果，拆给前端片会出现「后端已删、前端还在调」的空窗。

#### 依赖

pr3（`http/routes/` 接线缝）。

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-39aa6a8addc5
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
- Section: pr4-codex-official-control-plane
- Owner: ccb_codex
- Priority: high
- Dependencies: subtask-39aa6a8addc5

## 审查记录 · 2026-08-16（ccb_claude）

**Review decision: pass** — 归档。

执行：slot2_codex，job `job_4e2f7c54ae05`，commit `520e231` + `df2b7da`（补 Windows CLI 解码），19 文件 +1320/-496。

### 逐条验收判定

| # | 验收标准 | 判定 | 证据 |
|---|---|---|---|
| 1 | 全仓无 `config.toml` 正则改写、无 `auth.json` 直写 | **pass** | grep 实核：`model-provider-service.ts` 原 `:140/:144` 的两条路径拼装已消失；残留仅 `codex-home.ts` 的 seed 整файл拷贝（既有机制，非正则改写）与一条注释 |
| 2 | 配置迁移前后五字段逐字段一致 | **pass** | `codex-config-rpc.fixture.test.ts` 在含嵌套 `model_providers.<id>` 的隔离夹具上验 `batchWrite`/读回 |
| 3 | `okOverridden` 独立路径与独立文案，单测覆盖 | **pass** | `model-provider-service.ts:199/204` 独立分支；`model-provider.test.ts:105`「okOverridden 走独立返回路径，绝不显示已生效」；`ModelSwitcher.tsx:85` 前端同步区分 |
| 4 | 保存并验证失败可一键还原 | **pass** | 回滚路径有覆盖 |
| 5 | 三处调用点改完且不回归 | **pass** | `api/client.ts`、`ModelSwitcher.tsx`、`SettingsPanel.tsx` 改走 `codexModels()`→`/api/v1/codex/models`；`testModelProvider` 全仓清零，旧 `/test` 仅留 404 回归断言 |
| 6 | doctor 用官方结果、SuDuo 侧不变、`codexBin` 不落 PATH | **pass** | 新增 `platform/codex-bin.ts` 锁版解析；`doctor-service.test.ts` 覆盖 checks 对象解析 |
| 7 | server vitest 覆盖 RPC 拼装／`expectedVersion` 冲突／`okOverridden`／checks 对象 | **pass** | 新增 `codex-runtime.test.ts`、`codex-config-rpc.fixture.test.ts`、`doctor-service.test.ts`、`platform.test.ts` |
| 8 | `login --with-api-key` 走 stdin，复用 Windows 解码范式 | **pass** | `df2b7da` 补齐 `decodeWindowsCommandOutput` |

### 中央文件与跨 owner 边界核查

**`http-server.ts` 严格落在窄范围例外内**：diff 实核仅移除内联三块（GET/PUT/POST test）+ 随之失效的 import 与 `modelProvider` 依赖字段，新增 1 行 `registerModelProviderRoutes` + import 块。**存量其余路由一条未动。**

**`client/web/src` 只改了授权的三个文件**，无越界。

`CODEX_VERSION` 未改（`contracts/src/config.ts:3` 仍为 `0.143.0`）；把散落的 `"0.143.0"` 字面量替换为该常量属收敛，非版本变更。协议 sha256 基线未触碰。

### 审查方独立验证（未采信回执）

`build`/`typecheck`/`lint` 全 exit 0；**server 84/84（21 文件）**；**contracts 3/3**；**`protocol:diff` clean，`codexVersion: 0.143.0`，1005 文件**。

**真实 `/home/sue/.codex` 未被触碰**：`auth.json` mtime 仍 `Jul 5 01:31`、`config.toml` 仍 `Aug 16 03:15`，与实施前一致。

### 剩余风险

- **真实凭证/供应商可用性未验证**：按本片派工边界，测试一律用隔离夹具与 stub，未使用真实 key、未发真实模型调用。这是设计内的取舍，不是缺陷；真实链路由 gate-c 侧覆盖。
- **本机 Node 22.20.0 低于 `package.json` 声明的 `>=24.10.0`**（既有环境条件，非本片引入）。全部命令在 Node 22 下通过，但与声明不符，建议单独处置。
- pr3 遗留的 MCP/OAuth 数据面缺口仍在，pr10/pr12 需按 slot2_codex 复核建议**显式展示 unknown/unavailable 或主动查询**，不得默认健康。

---

## 审查纠正 · 2026-08-16（ccb_claude）—— 归档撤回，验收 6 实为 fail

**上面那条 `Review decision: pass` 的验收 6 判错了，本片退回 implementation。**

### 怎么发现的

pr4 归档后跑 gate-c（隔离 `SUDUO_CODEX_HOME`），**挂在 pr4 新写的 doctor 段**：

```
Codex 官方诊断  fail
codex doctor --json 执行失败 status=1；stderr：bytes=0 base64= utf8="" gbk=""
```

### 真实缺陷

手测 `codex doctor --json`（隔离 CODEX_HOME，codex-cli 0.143.0）：

| 观测 | 值 |
|---|---|
| exit code | **1** |
| stdout | **14954 字节，完整合法 JSON** |
| stderr | 0 字节 |
| `overallStatus` | `fail` |
| `checks` 数 | 18（与 spec 实测一致） |
| 非 ok 项 | `installation`、`updates.status` |

**`codex doctor --json` 的退出码表达的是「诊断结论」，不是「执行成败」**——任一 check 不过就退 1，同时照常把完整报告写进 stdout。

而 `doctor-service.ts:163` 是：

```ts
if (result.status !== 0) {
  checks.push({ name: "Codex 官方诊断", status: "fail",
    message: "codex doctor --json 执行失败 status=..." });
  return;                     // ← 14954 字节合法 JSON 被整个丢掉
}
```

### 后果

- 官方 18 项检查与 `remediation` **恰恰在有问题的时候全部看不到**——而这正是验收 6 要求的「能显示官方 remediation」。
- 讽刺的是，本片 D2 的初衷就是修「装了全局 0.147 导致 doctor 误报 fail」；现在两个失败项 `installation`/`updates.status` 正是 npm global prefix 不一致，等于**换了个位置把同类问题又造了一遍**。
- gate-c 被这一条卡死，pr1 的运行态验收连带无法推进。

### 我的 review 为什么没抓到

`doctor-service.test.ts:25-30` 唯一的 `codexDoctorRunner` stub **只返回 `status: 0`**。「任一 check 失败 → 退出码非 0 且 stdout 有效」这条**正常路径完全没有测试覆盖**，而我采信了单测绿灯，没有真实执行 doctor。

这是 review 节点明令警告的那种错误：**不要被"测试通过"四个字说服**。判罚记在我头上，不记在执行方头上。

### 状态变更

`status: done → reviewing`；`current_node: archive → implementation`；`review_status: passed → failed`。前一条 archive_completed 事件保留在流水账中，由本纠正事件覆盖，不删改历史。

---

## 复审与归档 · 2026-08-16（ccb_claude）—— 两轮返工后通过

**Review decision: pass** — 重新归档。

### 返工 1（`2f126f2`）：doctor 判读

改为「按有没有合法 JSON 判读」而非「按退出码判读」。**审查方实跑验证**（非采信单测）：SuDuo doctor 完整列出 **18 项官方检查**，`installation`/`updates.status` 的 remediation 原文可见。

### 返工 2（`f63ba24`）：官方 install/updates 不阻断

**我的设计判断**：这两项检查的是 npm 全局自更新机制，与「SuDuo 能否运行」无关，且在本项目既定的 workspace 锁版模型下**结构性必失败**。

判定依据（工程可判定，非用户权利项）：
- 本机 `/home/sue/.nvm/versions/node/{22.20.0,24.10.0,24.19.0}/lib/node_modules/@openai/codex` **三个版本下均不存在**——官方检查在拿一个不存在的路径做比较。
- SuDuo 刻意锁 workspace 版（`SUDUO_CODEX_BIN` + 本片新增 `platform/codex-bin.ts`）。
- D2 spec 原文即「在装有全局 0.147 的机器上 doctor 不再**误报** fail」。

实现核验：白名单 `NON_BLOCKING_OFFICIAL_CHECK_IDS = new Set(["installation", "updates.status"])` **严格只含这两项**，未被扩大；汇总算法改为「非白名单官方项失败 → fail；仅白名单异常 → warn；否则 pass」，仅 fail 阻断。两项仍完整展示为 `warn` 并保留 remediation，未伪装成 pass。

Codex 另行验证 `TERM=dumb` 会触发非白名单的 `terminal.env` 并**正确阻断**，证明不是笼统放行。

### 审查方最终独立验证

`build`/`typecheck`/`lint` 全 exit 0（Node 24.10.0）；**server 88/88（21 文件）**；**contracts 3/3**。doctor 实跑 `status=PASS`，两项呈 `WARN` 且 remediation 可见。

### 本次归档与上一次的差别

上一次（已撤回）是采信单测绿灯归档，被真实执行推翻。这一次的验收 6 判定建立在**实跑 doctor 输出**之上，不是单测。
