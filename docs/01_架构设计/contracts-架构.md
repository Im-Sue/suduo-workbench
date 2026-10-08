---
doc_type: architecture
updated: 2026-10-02
architecture_scope: contracts
scope_source_roots: ["client/contracts", "cloud/contracts"]
---

# client/contracts 与 cloud/contracts 架构

> 一句话定位：两份零运行时依赖的契约包——云端 API 契约归 `cloud/contracts`，客户端内部（前端 ↔ 本机后端）契约归 `client/contracts`；依赖只能从客户端指向云端。｜最后更新：2026-10-02

---

## 一、概述与定位

| 项 | 内容 |
|----|------|
| 名称 | `@suduo/cloud-contracts`（`cloud/contracts`）、`@suduo/client-contracts`（`client/contracts`）；均 v0.1.0，private，ESM，`sideEffects: false` |
| 定位 | 各端的类型、常量、错误码与少量纯映射函数 |
| 架构模式 | 无运行时依赖的类型 / 常量库，各自只有一个包根导出 `.` |
| 覆盖范围 | `client/contracts`、`cloud/contracts` |
| 不覆盖 | 契约的实现方 `client/server`、`client/web`、`cloud/server`；系统全景见《SuDuo V2 系统架构》 |

两包按「谁定义这份接口」划分（[ADR-0010](../06_决策记录/ADR-0010-仓库按客户端云端两端拆分-品牌更名SuDuo.md)）：

| 包 | 内容 | 使用方 |
|---|---|---|
| `@suduo/cloud-contracts` | 云端 `/v2` API：认证、项目、需求（含优先级）、评论（含评论文件）、附件、产物版本（只读历史）、活动、统计、审计、房间（消息 / 文件 / Agent / 共享 / 任务）、分页、状态、错误、健康（含云端功能声明）、限额与 schema | `cloud/server`、`client/server`、`client/web`、`client/contracts` |
| `@suduo/client-contracts` | 会话运行时（事件信封、运行时接口、JSON-RPC 传输、审批模式、版本常量、会话工具），以及只在本机 BFF 与前端之间的 `local`（本机字段、目录浏览、路径检查）、`workbench`（我的工作）、`attachment-preview`（附件在线预览白名单） | `client/server`、`client/web` |

2026-10-02 之前两者是同一个包 `@zjwork/contracts`：根导出对应现在的客户端契约，`./requirements-v2` 子路径对应现在的云端契约（其中 local / workbench / attachment-preview 三份搬到了客户端）。

---

## 二、整体结构

```
        cloud/                                   client/
 ┌──────────────────────────┐         ┌───────────────────────────────┐
 │ @suduo/cloud-contracts    │◀─link:──│ @suduo/client-contracts        │
 │ auth / projects /         │         │ api / config / events /        │
 │ requirements / collab /   │         │ runtime / registry / transport │
 │ rooms / stats / ...       │         │ session-tools / local /        │
 └────────────┬─────────────┘         │ workbench / attachment-preview │
              │ workspace:*           └───────────────┬───────────────┘
              ▼                                       │ workspace:*
        cloud/server                    client/server、client/web
                                       （同时 link: 引用 cloud-contracts）
```

- 云端工作区里 `cloud/server` 以 `workspace:*` 依赖 `cloud-contracts`。
- 客户端工作区里 `client/{contracts,server,web}` 以 `link:../../cloud/contracts` 引用云端契约（pnpm 只建软链接，不装它的依赖；契约包零运行时依赖）。
- 云端的 package.json 里没有任何客户端包，方向由此强制。

---

## 三、技术栈

| 类别 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 语言 / 构建 | TypeScript（`tsc -b`） | 6.0 | 输出 ESM + `.d.ts` 到 `dist/` |
| 运行时依赖 | 无 | — | `client-contracts` 只依赖 `cloud-contracts`（同为零依赖） |
| 测试 | vitest + 类型测试 | 4.1 | `test` = `test:types`（`tsc --noEmit`）再 `vitest run` |

---

## 四、项目结构

```
cloud/contracts
├── src/
│   ├── index.ts              包根导出聚合
│   ├── auth.ts  projects.ts  requirements.ts  collaboration.ts  artifact-versions.ts
│   ├── activity.ts  stats.ts  status.ts  pagination.ts  errors.ts  health.ts  limits.ts
│   ├── rooms.ts  rooms-schemas.ts  schemas.ts
└── test/contracts.test.ts

client/contracts
├── src/
│   ├── index.ts              包根导出聚合
│   ├── api.ts  config.ts  events.ts  registry.ts  runtime.ts  transport.ts  session-tools.ts
│   ├── local.ts              本机字段、目录浏览、路径检查（引用云端需求 DTO）
│   ├── workbench.ts          我的工作聚合（引用云端需求状态）
│   └── attachment-preview.ts 附件在线预览白名单
└── test/contracts.test.ts  local.test.ts
```

---

## 五、核心模块 / 组件

| 模块 | 包 | 职责 |
|------|------|------|
| `config.ts` | client | `CODEX_VERSION`、`DEFAULT_CODEX_RUNTIME_ID`、`DEFAULT_CODEX_TRANSPORT`、`M1_RUNTIME_SECURITY_POLICY`、`SUDUO_DEFAULTS`，以及 `ApprovalMode` 与其策略 / 文案表 |
| `events.ts` / `runtime.ts` / `registry.ts` / `transport.ts` | client | 事件信封、Agent 运行时接口族、运行时注册表、JSON-RPC 传输 |
| `api.ts` | client | `ErrorCode` 与本机会话、项目、文件、审批等 `/api/v1` 契约 |
| `session-tools.ts` | client | SuDuo 会话工具名（`suduo_*`）、动作名与写工具确认卡（ADR-0008） |
| `local.ts` / `workbench.ts` / `attachment-preview.ts` | client | 本机 BFF 在云端 DTO 之外补充的字段与本机专属接口 |
| `requirements.ts` / `projects.ts` / `collaboration.ts` / ... | cloud | 云端 `/v2` 需求协作域 |
| `rooms.ts` / `rooms-schemas.ts` | cloud | 项目 / 需求聊天房间与共享 Agent（ADR-0009） |

---

## 六、关键流程 / 数据流

契约变更的传导：

- 改 `cloud/contracts`：云端 `pnpm build` 经 `workspace:*` 拿到；客户端的 `pnpm build` / `typecheck` / `test` 都先执行 `build:contracts`（`tsc -b contracts`：经 `client/contracts` 的项目引用连带编译 `cloud/contracts`，用客户端自己的 TypeScript；全新检出没有任何产物时也能直接跑），`client/contracts` 与 `client/server` 的 tsconfig 也以 `references` 指向它。**两端都要跑 typecheck / test。**
- 改 `client/contracts`：只影响客户端工作区。

---

## 九、部署 / 运行

本包不独立运行，仅参与构建：

- 云端构建：`cd cloud && pnpm --filter @suduo/cloud-contracts build`（Docker 构建同此）
- 客户端构建：`cd client && pnpm build`（顺带编译 `../cloud/contracts`）
- 类型检查 / 测试：各包 `typecheck`、`test`

---

## 十、边界 / 不做项

- 不含运行时依赖，也不做 I/O：没有 HTTP、数据库或文件访问。
- 云端契约不引用客户端任何东西；只在客户端用的类型放 `client/contracts`，不要回塞到云端。
- 不承载业务实现，只定义类型、常量与少量纯映射函数。

---

## 十一、相关文档

| 想深入 | 看 |
|--------|-----|
| 系统总架构 | `docs/01_架构设计/v2-系统架构.md` |
| 本机 BFF 与会话运行时 | `docs/01_架构设计/client-server-架构.md` |
| 远程需求服务 | `docs/01_架构设计/cloud-server-架构.md` |
| 前端 SPA | `docs/01_架构设计/client-web-架构.md` |
| Codex 协议基线（`CODEX_VERSION` 的另一半） | `docs/01_架构设计/client-codex-protocol-架构.md` |

---

## 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-08-15 | v1.0 | `/ccb:su-init` 依据仓库证据生成初版（未经人工校验） |
| 2026-08-15 | v1.1 | 区分两个导出面的现状：`./requirements-v2` 为 V2 主线，`work-items` 归旧线 |
| 2026-08-15 | v1.2 | 按 T4 清理后的分支代码移除已删除的 `work-items.ts`、TAPD 错误码与相关根导出描述 |
| 2026-10-02 | v2.0 | 按 ADR-0010 拆成 `cloud/contracts` 与 `client/contracts` 两包，重写全文 |
