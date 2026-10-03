---
id: suduo-v2-t2-bff-workbench-task
task_id: SUDUO-V2-T2-BFF-WORKBENCH-001
title: SuDuo V2 T2 本机 BFF 与工作台开发任务
doc_type: dev_task
requirement_id: suduo-v2-requirements-workbench-001
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
section_id: t2-bff-workbench
order: 2
implementation_owner: ccb_codex
dependencies: ["SuDuo V2 T1 共享契约与远程基础服务"]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-requirements-workbench-001.json
source_draft_hash: c66e83bb28d2d39f76f9176f2e1d53cc5c856edf010dbd7e60901eb990289468
created: 2026-08-13
created_at: 2026-08-13T00:00:00.000Z
updated_at: 2026-08-16T05:55:50.986Z
updated_by: ccb_claude
---

# SuDuo V2 T2 本机 BFF 与工作台开发任务

> 一句话：在本机 BFF 安全持有远程登录态，并在唯一的 `/` 工作台壳中完成远程需求协作、目录映射、项目/需求会话与既有 Codex 运行时的闭环。｜最后更新：2026-08-14（已验收）

## 一、任务概述

**目标对齐**：消费 T1 已交付的 `requirements-v2` 契约和远程 API，浏览器始终只访问 localhost。`/` 是唯一的 SuDuo V2 工作台壳；远程项目配置当前电脑的工作目录后，所有已登录用户均可从项目创建会话，或从需求创建带固定无附件快照的本机 Codex 会话。

| 项 | 说明 |
|----|------|
| 交付目标 | `/api/v2` BFF、SQLite 009、不可变快照、V2 会话关联，以及统一工作台壳内的需求/会话/设置模式。 |
| 需求来源 | `docs/02_需求设计/v2-需求协作工作台-需求.md`。 |
| 技术来源 | `docs/03_开发计划/v2-工程实施技术设计.md` 第 4.2、6.3、7.3～7.4、9.2、12 节。 |
| 本期范围 | 本机 token/config、明确远程 API 调用、项目目录映射、无附件快照、项目/需求会话编排，以及统一工作台内三种模式的 UI。 |
| 不含范围 | `requirements-service` 与其 PostgreSQL migration、附件上传/下载、服务器硬盘读写、SSE、TAPD/旧 WorkItem 清理、Codex runtime 改造。 |
| 预计工期 | 3 人天。 |
| 分工 | Codex 负责实现与人工闭环；用户提供可访问的远程服务环境进行最终联调。 |

## 二、任务分解

### 2.1 本机 BFF 与持久化

- [x] **任务 2.1.1：补充 V2 BFF 错误、配置、凭证与远程客户端**
  - 内容：规范化远程地址，使用 0700 数据目录和 0600 原子 JSON 文件保存配置/token；仅实现冻结的 T1 API 调用，处理过期与 401 清态。
  - 产出：`client/server/src/infrastructure/requirements-v2/*` 和 BFF 应用编排。
  - 依赖：T1 `@suduo/cloud-contracts`。

- [x] **任务 2.1.2：新增 SQLite 009 映射和会话引用**
  - 内容：新增两张 V2 本地表及双向唯一约束，基于既有本机项目路径真相保存、校验和删除映射。
  - 产出：009 migration、映射与会话引用 repository。
  - 依赖：任务 2.1.1。

- [x] **任务 2.1.3：无附件快照和 V2 会话创建**
  - 内容：先读取并核验远程需求、实时校验目录，再原子写入三个快照文件，创建 taskId 为 null 的既有 runtime 会话并持久化引用；重建 thread 时恢复 V2 简报。
  - 产出：material service、requirement briefing、`SessionService.createFromRequirement()`、`MessageService` V2 重建分支。
  - 依赖：任务 2.1.2。

### 2.2 HTTP 与工作台

- [x] **任务 2.2.1：注册限制性的 `/api/v2` BFF 路由**
  - 内容：仅注册技术设计 7.4 的 auth、项目、需求、评论、审计、映射和需求会话端点，维持 LoopbackGuard 与同源写保护。
  - 产出：HTTP server 路由与应用装配。
  - 依赖：任务 2.1.1～2.1.3。

- [x] **任务 2.2.2：将 V2 UI 收口到统一 `/` 工作台壳**
  - 内容：移除需求、会话、设置各自独立 App 壳的交互模型；以原生 history 让 `/` 和三个深链接进入同一个 `SuDuoApp`，复用顶部栏、左栏框架、会话消息/工具/审批/Composer。未登录时在该壳主区显示直接登录/注册，不增加“前往设置”的登录链路。
  - 产出：统一模式状态、深链接恢复、复用后的 V2 业务组件与样式；原独立 `RequirementsV2App` 只可作为待拆出的业务内容来源，不能作为交付入口。
  - 依赖：任务 2.2.1。

- [x] **任务 2.2.3：补齐项目会话与映射原地续办**
  - 内容：新增项目级会话 BFF 编排和 UI 入口；项目级与需求级会话都先实时校验当前电脑的项目目录映射。无映射、目录不存在或权限失效时，在当前操作上下文打开“配置当前项目工作目录”，保存、校验成功后自动继续原操作。
  - 产出：`POST /api/v2/projects/:projectId/sessions`、统一映射阻断/续办状态、项目与需求会话入口；项目会话不创建需求快照或伪造需求引用。
  - 依赖：任务 2.1.2、2.2.1、2.2.2。

### 2.3 验证与审查

- [x] **任务 2.3.1：L3 不变量与人工闭环验证**
  - 内容：审查六项冻结不变量，执行 build/typecheck/lint，并以可用远程服务验证登录、协作、URL 清态、映射冲突、快照和旧会话 smoke。
  - 产出：L3 审查与人工 API/UI 验证记录；因文档仓与代码仓分离，未生成 framework final receipt，改由用户确认后手工合并。
  - 依赖：任务 2.2.2。

## 三、执行顺序 / 里程碑

- 关键顺序：已完成本机持久化与客户端、SQLite 映射/快照/需求会话、BFF 路由 → 统一工作台壳 → 项目会话与映射原地续办 → L3 审查与人工验证。
- 返工边界：复用已完成的 BFF、SQLite、快照和需求域组件；只替换独立 V2 App 壳、路由入口及会话编排，不改 T1、附件/SSE、TAPD 或 Codex runtime。

| 里程碑 | 目标 |
|------|------|
| M1 | 本机 token 与远程 API 不向浏览器泄露。 |
| M2 | 已映射项目可生成不可变无附件快照并创建需求级 V2 本机会话。 |
| M3 | `/` 统一工作台壳完成需求/会话/设置模式、项目级会话及映射原地续办的 localhost 闭环。 |
| M4 | L3 不变量审查、构建检查和人工 API/UI 验收完成。 |

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 08-13 | 门②方案已冻结，用户确认编码前轻停；创建隔离车间。 | 根文档仓与 `suduo` Git 仓分离，机械 checkpoint 无法在根目录运行。 | 在车间实施本机 BFF 与工作台代码；根目录仅保留文档/状态。 |
| 08-13 | 已完成 BFF、SQLite 映射、无附件需求快照、需求会话和独立 V2 页面初版。 | 初版把 `/requirements`、`/sessions`、`/settings` 做成独立壳，偏离“`/` 是唯一工作台”的产品决定。 | 按本任务 2.2.2～2.2.3 收口到统一壳，并补项目级会话和映射原地续办。 |
| 08-13 | 已收口为统一工作台：`/`、`/requirements`、`/sessions`、`/settings` 共用顶栏；项目/需求会话均经映射原地配置后自动续办，运行区复用既有 Codex 会话 UI。 | 增量审查发现 session POST 会静默忽略多余字段、显式 `null` 也会被当作空 body。 | 两条 V2 session POST 已限制为仅缺省 body 或 `{}`；多余字段和 `null` 均返回 `400 VALIDATION_ERROR`，复审与构建检查通过。 |
| 08-13 | 在本机 T1 requirements-service 和隔离 BFF（18788）完成真实 API/UI 闭环；提交车间代码 `237f496`。 | 根文档目录不是 Git 仓，`zj-dev-run verify` 不能生成机械 final receipt。 | 将本次实际命令、API/UI 证据和该流程限制写入本任务；待门③验收后再决定合并/关闭车间。 |
| 08-14 | 用户确认后，将车间提交 `237f496` 合并至 `suduo/main`，合并提交为 `2f43b1e`；以合并后产物重建并重启本机工作台。`http://127.0.0.1:8787/healthz` 与 `http://127.0.0.1:4100/v2/health` 均返回正常。 | 标准交付脚本仍不支持外层 `docs/` 与嵌套 `suduo/` Git 仓分离的布局，未生成 framework final receipt。 | 保留 T2 车间，等待用户体验确认后再关闭；下一开发阶段为 T3 附件与实时协作，需先完成该阶段的需求/技术方案确认。 |
| 08-14 | 用户明确确认 T2、T3 可以验收；T2 交付归档。 | 用户要求继续保留 T2 车间，不关闭或删除。 | T4 处理旧数据与旧运行时能力清理；T5 再处理部署发行与完整环境验收。 |

## 五、验收标准

- [x] 浏览器仅请求 localhost；V2 BFF 的响应与 Web state 不含 access token。
- [x] 远程 URL 改变、token 过期或远程 401 后旧登录态被清除。
- [x] 两个远程项目不能映射到相同本机路径；无有效映射不能创建会话。
- [x] 会话前完整原子写入仅含 `requirement.json`、`requirement.md`、`manifest.json` 的无附件快照，且 session `task_id` 为 null。
- [x] `/`、`/requirements`、`/sessions`、`/settings` 始终渲染同一个工作台壳；后者仅恢复模式，不产生重复顶栏、左栏或第二套会话运行态。
- [x] 未登录时在统一壳主区完成直接登录/注册；登录后回到先前模式，响应与 Web state 不含 access token。
- [x] 需求、评论、状态、映射、项目会话和需求会话均可在统一工作台完成；任意已登录用户创建任一会话前都必须通过映射校验，无效时可原地配置并续办。
- [x] 项目级会话只运行于映射目录，不带伪造的需求快照或需求引用；需求会话仍满足无附件快照和 `task_id = null` 约束。
- [x] 旧运行时和 TAPD 入口仍可访问。
- [x] `pnpm build`、`pnpm typecheck`、`pnpm lint` 通过；不新增自动化测试（用户确认的范围约束）。

## 五点一、交付验证记录（2026-08-13）

| 类别 | 结果 | 证据 / 备注 |
|---|---|---|
| 代码提交与合并 | 通过 | 车间分支 `zj-dev/SUDUO-V2-T2-BFF-WORKBENCH-001` 的 `237f496 feat: unify V2 workbench sessions` 已用户确认手工合并至 `suduo/main`，合并提交 `2f43b1e`；主分支内容与车间提交一致。未改 `cloud/server`、TAPD 或 Codex runtime 源码。 |
| 静态质量 | 通过 | 在车间执行 `pnpm typecheck`、`pnpm lint`、`pnpm build`，均 exit 0；Vite 仅报告既有大 chunk 建议，无构建失败。 |
| 会话 POST 契约 | 通过 | 项目与需求两条 POST：携带 `rootPath`、`taskId`、`accessToken` 返回 `400 VALIDATION_ERROR`；显式 JSON `null` 也返回 `400`；Web 仅发送 `{}`。 |
| 认证与协作 | 通过 | 本机 T1 服务 `http://127.0.0.1:4100` 上完成注册→退出→登录；创建项目、需求、评论、状态变更和审计展示；远程服务无 Bearer 调用返回 `401 AUTH_REQUIRED`。 |
| 统一壳与登录 | 通过 | 浏览器依次访问 `/`、`/requirements`、`/sessions`、`/settings`，均为同一顶栏壳且无 JavaScript console error；未登录直接在壳主区注册/登录，注册后退出再登录均成功。 |
| 映射与续办 | 通过 | 未映射项目/需求的 POST 返回 `409 WORKSPACE_MAPPING_REQUIRED`；UI 点击项目会话后原地弹出“配置当前项目工作目录”，保存有效目录后自动创建并进入既有运行区；同目录映射冲突返回 `409 WORKSPACE_MAPPING_CONFLICT`。 |
| 会话隔离与快照 | 通过 | 项目会话 `task_id=null` 且没有需求引用；需求会话 `task_id=null`、有 `v2_requirement_session_refs`。快照目录只含三个文件，manifest `attachments: []`。 |
| token 边界 | 通过 | 浏览器 cookie 与 localStorage 未发现远程 access token；BFF 私有目录/文件权限为 `0700/0600`，token 仅存在本机 `auth-session.json`。 |
| L3 审查 | 通过 | 安全 lane 无 P0/P1/P2；数据/会话 lane 修复映射竞态；集成 lane 修复分页、并发和类型问题；本轮 S5 复审发现并关闭显式 `null` 请求体边界。无未决 P0/P1/P2。 |

**未验证项**：用户明确要求本阶段不新增或执行自动化测试，故没有单元/集成/E2E 测试结果。机械 `zj-dev-run verify --mode final` 因本机 `docs/` 根不是 Git 仓而拒绝（`not-a-git-repository`），无法生成 framework final receipt；以上质量命令与人工闭环已在代码车间实际执行。T3 附件流、服务器硬盘读写、SSE 与 T4 部署/旧 TAPD 清理均不属于本期。

## 五点二、续接锚点（2026-08-14）

- **当前代码基线**：`suduo/main` 的合并提交 `2f43b1ea8993363fc3c120d152bf75a4de9dd740`；如需撤回本次集成，执行 `git -C suduo revert 2f43b1e`。
- **本机运行环境**：工作台为 `http://127.0.0.1:8787/`（健康检查 `/healthz`）；T1 requirements-service 为 `http://127.0.0.1:4100`（健康检查 `/v2/health`）。工作台使用 `/home/sue/.local/share/suduo` 作为既有本机数据目录，远程服务默认地址为本机 `4100`。
- **保留的车间**：`zj-worktrees/suduo/SUDUO-V2-T2-BFF-WORKBENCH-001`，分支 `zj-dev/SUDUO-V2-T2-BFF-WORKBENCH-001`；已合并，暂不关闭，避免用户体验验收前丢失可比对环境。
- **验收归档**：用户已确认 T2 交付验收通过。T2 车间按用户要求继续保留，不关闭或删除。
- **后续阶段**：T3 已同步验收；T4 只处理旧 SQLite/TAPD 数据及对应旧运行时能力清理，T5 再处理部署发行与完整环境验收。T4/T5 均尚未开始。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 远程 token 发往错误地址 | 账号泄露 | URL 规范化、baseUrl 绑定、改地址清态、禁重定向和 401 清态。 |
| 目录映射失效或重复 | Codex 在错误目录运行 | SQLite 双向唯一 + 保存/创建前 realpath、stat、R/W/X 校验。 |
| 独立 V2 页面壳残留 | 需求、会话、设置与既有运行态割裂 | 以 `/` 唯一壳和深链接同壳渲染作为实现及人工验收约束；不得保留第二套顶栏。 |
| 项目会话绕过映射 | Codex 在未确认目录运行 | 项目与需求会话共用同一映射预检，BFF 不接受客户端提交的工作目录。 |
| 同版本快照被覆盖 | 上下文不可复现 | staging/fsync/rename；已存在目录只校验复用，绝不覆写。 |
| 无自动化测试 | 回归发现延后 | 按冻结 L3 人工 API/UI 清单执行并显式记录未验证项。 |
| 远程服务环境不可达 | 无法完成人工联调 | 先完成静态检查及 BFF 本地错误路径；最终报告环境阻断。 |

## 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-08-13 | v1.0 | 按 T2 冻结方案创建开发任务。 |
| 2026-08-13 | v1.1 | 修正为统一 `/` 工作台壳，增加项目级会话及目录映射原地配置/续办；如实记录独立 V2 页面初版需收口返工。 |
| 2026-08-13 | v1.2 | 完成统一壳、项目会话、映射续办与 L3/API/UI 验证；补充 session POST 空请求体严格契约及交付证据。 |
| 2026-08-14 | v1.3 | 记录用户确认后的 `main` 合并提交、本机运行服务、标准回执环境限制，以及 T3 续接锚点。 |
| 2026-08-14 | v1.4 | 用户确认 T2 交付验收通过；任务归档，T2 车间按要求保留。 |

<!-- ZJ_DECISIONS_V1_BEGIN -->
{"gate":3,"id":"G3-T2-D1","topic":"acceptance","decision":"T2 本机 BFF 与工作台交付验收通过；主分支合并提交为 2f43b1ea8993363fc3c120d152bf75a4de9dd740；按用户要求保留 T2 车间，不关闭或删除。","source":"docs/03_开发计划/v2-t2-bff与工作台-开发任务.md#五点一、交付验证记录（2026-08-13）","proposalDigest":"ec403771f6c67dd81ed418672938418a300ce6957f705f201eafc02c8a66e6de","approvedAt":"2026-08-14T17:42:39+08:00","approvalEvidence":{"userMessage":"T2 T3已经可以验收了。T4再拆一下，部署发行、完整环境放到T5，旧数据清理放到T4","interpretation":"明确确认 T2 交付验收"}}
<!-- ZJ_DECISIONS_V1_END -->
