---
doc_type: dev_task
task_id: subtask-2d21da6ae36f
title: 设置页 BFF 支撑端点三件
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: medium
requirement_id: suduo-v2-workbench-ui-refit-001
section_id: pr5-settings-bff-endpoints
order: 5
implementation_owner: ccb_codex
dependencies: [subtask-39aa6a8addc5, subtask-0fbe7dd923c7]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-workbench-ui-refit-001.json
source_draft_hash: 539ebf4a8c5b66964ac2fa8fc30c204413962ad59f4434dc555ca2b11972a8a6
created_at: 2026-08-16T15:13:00.518Z
updated_at: 2026-08-17T03:00:32.210Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-workbench-ui-refit-001","branch":"ccb/req-suduo-v2-workbench-ui-refit-001"}
---

# 设置页 BFF 支撑端点三件

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 补齐设置页需要但当前不存在的三个只读/系统端点：需求服务地址试连、映射目录可用性校验、用系统编辑器打开 Codex 配置文件。 |
| 需求来源 | suduo-v2-workbench-ui-refit-001 |
| 本期范围 | pr5-settings-bff-endpoints · 设置页 BFF 支撑端点三件 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### 设置页 BFF 支撑端点三件

#### 任务概述

设置页有三个按钮，如果没有对应端点就只能画一个假的或者干脆删掉。这一片把这三个端点补上——都很小，但都**必须在后端做**，浏览器做不到。

1. **需求服务地址「测试连通」**：现在只有 `GET/PUT /api/v2/requirements/settings`，没法试一个**还没保存**的地址。不加这个端点，组 1 的测试按钮就得删掉——不做假按钮。
2. **映射目录可用性灯**：项目映射的本机目录会被删掉或改权限，现在只在保存和建会话时校验，列表里看不出坏没坏。浏览器无法 `realpath`／`stat`／查 RWX，必须后端做。
3. **打开 Codex 配置文件**：设置页诊断组底部要有「高级 → 直接编辑配置文件」的逃生门。现有 `system/open-targets` 只列目标，实际打开端点受项目根 `path-guard` 限制，**打不开 `CODEX_HOME/config.toml`**，需要专用端点。

#### 任务分解

1. `POST /api/v2/requirements/settings/test`：试未保存的服务地址，返回可读的连通性结果。不写入任何配置。
2. `GET /api/v2/project-mappings?verify=1`：返回每个映射目录的可用性（存在／可读写执行）。**只读、无副作用**，复用既有 `path-guard`。
3. `POST /api/v1/codex/config-file/open`：用系统编辑器打开 `CODEX_HOME/config.toml`。**不复用**项目根 `path-guard` 的打开路径，走专用端点并限定只能开这一个目标。
4. 端点落点分两种情形，不可一概而论：
   - `requirements/settings/test` 与 `codex/config-file/open` 是**新路由**，按 pr3 建的缝落到各自 `http/routes/*-routes.ts`，`http-server.ts` 每处只加 1 行注册。
   - `GET /api/v2/project-mappings` 的处理块**已内联**在 `http-server.ts:940`，`verify=1` 是给既有路由加查询参数，**无法**靠新增注册完成。**准许本片窄范围抽取并替换该既有块**、迁入 `http/routes/`，但不得顺带改其它路由。

#### 验收标准

- 三个端点各有 server 侧 vitest：成功路径 + 失败路径（地址不可达／目录不存在／目录无权限／配置文件缺失）。
- `verify=1` 确认无副作用：调用前后文件系统与配置零变化。
- `config-file/open` 只能打开 `CODEX_HOME/config.toml`，传其它路径被拒绝（防止变成任意文件打开器）。
- 失败一律返回可读诊断，不静默。

#### 边界

- 不做内嵌配置编辑器——内嵌就要负责语法校验与冲突处理，本期只提供「用系统编辑器打开」。
- 不改既有 `/api/v2/requirements/settings` 的读写语义。
- 不动 `path-guard` 既有规则，只新增受限的专用路径。
- 界面归 pr9。

#### 依赖

pr3（`http/routes/` 接线缝）、pr4（中央装配串行前序——pr4 先完成 model-provider 内联块的抽取，本片再改 `project-mappings` 块，避免两片同时重排 `http-server.ts` 与 `server-application.ts`）。

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-39aa6a8addc5, subtask-0fbe7dd923c7
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
- Section: pr5-settings-bff-endpoints
- Owner: ccb_codex
- Priority: medium
- Dependencies: subtask-39aa6a8addc5, subtask-0fbe7dd923c7

## 审查记录 · 2026-08-16（ccb_claude）

**Review decision: pass** — 归档。

执行：slot2_codex，job `job_a17960afa195`，commit `201d6ef`，8 文件 +615/-8。

### 逐条验收判定

| # | 验收标准 | 判定 | 证据 |
|---|---|---|---|
| 1 | 三端点各有成功 + 失败路径 vitest | **pass** | `http.test.ts` +319 行；覆盖地址不可达、目录不存在、目录无权限（`000`）、配置文件缺失 |
| 2 | `verify=1` 无副作用 | **pass** | `project-mapping-routes.ts` grep 无任何写操作；service 侧仅 `stat`/`access`/`realpath`，注释明写「不触网也不清理过期凭证」；测试对目录树、V2 配置快照、映射记录前后比对一致 |
| 3 | `config-file/open` 只能开 `CODEX_HOME/config.toml` | **pass** | 目标由服务端从 `codexHome` 计算，**从不采用请求传入路径**；body 带任何不等于该常量的 `path` 一律 400；即使相等也仍打开服务端常量。不可能退化为任意文件打开器 |
| 4 | 失败返回可读诊断不静默 | **pass** | 不可达 503、缺文件 404、路径越界 400、打开失败 503，各带中文可读消息 |

### 落点规则核查（两种情形分别核）

- **新路由**：`registerRequirementsSettingsRoutes`、`registerCodexConfigFileRoutes` —— `http-server.ts` 各加 **1 行注册**，共 2 行 ✅
- **既有内联块**：`http-server.ts:940` 的 `GET /api/v2/project-mappings` 已按授权窄范围抽取，替换为 `registerProjectMappingRoutes(server, dependencies)` ✅
- **未顺带改其它路由** ✅

新增的 `codexHome`、`openCodexConfigFile` 两个依赖字段均为 optional，保持旧测试工厂兼容。

### 审查方独立验证（未采信回执）

Node 24.10.0 下 `build`/`typecheck`/`lint` 全 exit 0；**server 94/94（21 文件）**，较 pr4 后的 88 净增 6。

未触碰 `/home/sue/.codex`、`docs/`、`.ccb/`。

### 剩余风险

目录权限判定按运行服务进程的实际权限得出——同一目录在不同用户/容器下结论可能不同。Linux 非特权场景已用 `000` 权限目录覆盖；Windows ACL 语义未覆盖（既有跨平台缺口，非本片引入）。
