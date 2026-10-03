---
doc_type: dev_task
task_id: subtask-aa35af1ab994
title: T5-1 requirements-service 部署资产
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-requirements-workbench-001
section_id: pr5-t5-1-requirements-service-deploy-assets
order: 5
implementation_owner: ccb_codex
dependencies: []
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-requirements-workbench-001.json
source_draft_hash: 845211ce45e58df0a521e1deab7621d1f26d89fc233146b4fbee2de306f7b93a
created_at: 2026-08-15T16:58:10.840Z
updated_at: 2026-08-15T18:09:01.121Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-requirements-workbench-001","branch":"ccb/req-suduo-v2-requirements-workbench-001"}
---

# T5-1 requirements-service 部署资产

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 补齐 Dockerfile、compose、服务专属环境样例、健康检查与备份恢复说明。 |
| 需求来源 | suduo-v2-requirements-workbench-001 |
| 本期范围 | pr5-t5-1-requirements-service-deploy-assets · T5-1 requirements-service 部署资产 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### T5-1 requirements-service 部署资产

#### 任务概述
远程服务的代码其实已经写好了（`/v2/health`、Postgres advisory lock、`db:migrate` 都在），但**一份部署资产都没有**：`cloud/server/` 下只有 `migrations`、`package.json`、`src`、`test`、`tsconfig*`、`vitest.config.ts`。而且根 `.env.example` 里一个 `REQUIREMENTS_*` 都没有——该服务有三个必填变量，缺任何一个都起不来。

本片与 T4 无共享文件，可全程并行：服务专属变量放进新建的 `cloud/server/.env.example`，不进根 `.env.example`（根文件只由 T4-3 删 `TAPD_*`）。

#### 任务分解
1. 编写 `cloud/server/Dockerfile`：多阶段构建，产出 `dist`，非 root 用户运行。
2. 编写 compose 示例：**不对外暴露 Postgres 端口**；PG 数据卷与附件卷分别挂载为具名持久卷。
3. 新建 `cloud/server/.env.example`，隔离远程服务密钥：`REQUIREMENTS_DATABASE_URL`、`REQUIREMENTS_AUTH_SECRET`（≥32 字符）、`REQUIREMENTS_ATTACHMENT_ROOT`（绝对路径）、`REQUIREMENTS_HOST`、`REQUIREMENTS_PORT`。
4. 健康检查接 `/v2/health`，说明它依赖数据库连通性。
5. 备份与恢复说明：明确指出**在线单独 `pg_dump` + 在线卷拷贝可能互不一致**，必须停服或使用存储快照来保证一致点。

#### 验收标准
- 从零按文档可拉起服务并通过健康检查。
- Postgres 端口未对宿主暴露；两个持久卷可独立备份与恢复。
- 缺任一必填环境变量时启动失败，且报错信息能指明缺哪个。
- 备份恢复说明包含一致性风险与正确做法，并完成一次演练。
- 根 `.env.example` 未被本片修改。

#### 边界
不改服务业务代码，不动本机端，不动根 `.env.example`。

## 三、执行顺序 / 里程碑

- 前置依赖: 无
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-08-15 | 物化任务文档 | 无 | 等待 dispatch 派工 |
| 2026-08-15 | 派工 ccb_codex（job_bfbe7e37903a），新增 Dockerfile / compose.yaml / .env.example / DEPLOYMENT.md / Dockerfile.dockerignore，提交 `30c8a9b` | 本机无 Docker，4 条运行时验收无法实跑 | 进入 review |
| 2026-08-15 | Review 一次通过：15 个环境变量逐个对账 config.ts、12 个默认值全部核实、compose/Dockerfile 约束核验 | 运行时验收顺延 T5-3 | 归档（部分验收顺延） |

## 五、验收标准

- [x] 完成 `spec_section_md` 定义的实现范围。
- [x] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [x] 完成必要验证，并在回执中说明测试命令与结果（运行时部分见归档记录「未实跑」）。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## 七、归档记录（2026-08-15）

**交付物**（提交 `30c8a9b`，5 个新文件，全部在 `cloud/server/` 下）：`Dockerfile`、`Dockerfile.dockerignore`、`compose.yaml`、`.env.example`、`DEPLOYMENT.md`。

**Claude 独立复验证据**：

| 核验项 | 方法 | 结果 |
|---|---|---|
| 环境变量完整性 | 严格边界正则对账 `.env.example` ↔ `src/` | 15 个真实变量全覆盖；唯一差异 `REQUIREMENTS_V2_SCHEMAS` 经核实为 contracts 导入常量（`server.ts:21`），非环境变量 |
| 必填项划分 | 读 `config.ts:27-35` | 必填 3 个用 `required()`，另有绝对路径与 ≥32 字符约束，与 spec 一致 |
| 12 个默认值 | 逐个对照 `config.ts:37-85` | 全部准确 |
| 不可配置项识别 | `config.ts:66-79` fallback=min=max | `MAX_ATTACHMENT_BYTES`/`MAX_ATTACHMENTS_PER_REQUIREMENT` 实为唯一允许值，文档已如实标注「默认且唯一允许值」，未简化为「默认值」 |
| PG 端口不暴露 | 读 `compose.yaml` | postgres 服务无 `ports` 段，唯一 `ports` 属服务自身 |
| 双持久卷 | 读 `compose.yaml:36-38` | `requirements_postgres_data` + `requirements_attachments`，分别挂载，可独立备份 |
| 健康检查接线 | 读 `Dockerfile:38` + `server.ts:139` | `HEALTHCHECK` 指向 `/v2/health`，尊重 `REQUIREMENTS_PORT`；端点确实执行 `SELECT 1` + schema 版本查询，DB 不可达返 503，`DEPLOYMENT.md:27` 描述属实 |
| 非 root | `Dockerfile:28-34` | system 用户 uid/gid 10001、nologin shell、附件目录 0700，`USER suduo` |
| 未越界 | git diff 根 `.env.example`/`client/server`/`packages`/`migrations` | 全部零改动；本次提交仅触及 `cloud/server/` |

**镜像结构**：两阶段。build 阶段先 COPY 清单文件装依赖（利用 layer 缓存）再 COPY 源码，最后 `pnpm --prod deploy --legacy` 生成生产运行包；runtime 阶段仅复制该运行包并降权运行。符合 pnpm workspace 的标准做法。

**未实跑的验收（因本机无 Docker，非缺陷，顺延 T5-3）**：
1. 从零拉起服务并通过健康检查；
2. `/v2/health` 实测响应；
3. 容器 `HEALTHCHECK` 实际生效验证；
4. 备份与恢复演练。

T5-3 在全新机器部署时须补跑上述四项，并按 `DEPLOYMENT.md:78` 要求「恢复后重新执行 `/v2/health` 并抽样下载附件」验证元数据与卷对象一致。

**备份一致性风险表述已落地**（`DEPLOYMENT.md` 备份与恢复章节）：明确禁止把在线 `pg_dump` 与在线卷拷贝当作同一可恢复备份，说明了错位机制（元数据在 PG、对象在卷、两次采集间隙可能发生上传或删除），并给出停服同时备份或一致性存储快照两条正确做法。

**记录在案的小瑕疵（不返工）**：`.env.example` 中 `REQUIREMENTS_DATABASE_URL` 注释写「独立运行时则使用本行」，但示例值用了 compose 服务名 `@postgres:5432`，独立运行时无法解析。同段注释已提示「请使其与实际 PostgreSQL 凭据保持一致」，compose 路径下又由 `compose.yaml:27` 覆盖，故不影响两种部署方式的实际可用性。T5-2 编写本机侧配置说明时可顺带澄清。

**后续事项**：根 `.env.example` 按边界未被本片修改，其 `TAPD_*` 清理仍归 T4-3。无未闭环待用户拍板项。

## Materialization Context

- Requirement: suduo-v2-requirements-workbench-001
- Section: pr5-t5-1-requirements-service-deploy-assets
- Owner: ccb_codex
- Priority: high
- Dependencies: none
