---
doc_type: dev_task
task_id: subtask-f9475ab9b719
title: PR4 · BFF 工作台聚合端点与远程代理
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-overview-and-my-workbench-001
section_id: pr4-bff-workbench-aggregation
order: 4
implementation_owner: ccb_codex
dependencies: [subtask-678ced53f433]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-overview-and-my-workbench-001.json
source_draft_hash: f085302ae21d25ec6aa04855f88f18aadb68c0d1bf80e8028f3f28a645e51337
created_at: 2026-08-25T09:41:14.245Z
updated_at: 2026-08-26T03:27:25.741Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-overview-and-my-workbench-001","branch":"ccb/req-suduo-v2-overview-and-my-workbench-001"}
---

# PR4 · BFF 工作台聚合端点与远程代理

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 实现跨库聚合服务与判别联合 envelope，注册 workbench / stats 代理 / audit 透传三条路由。 |
| 需求来源 | suduo-v2-overview-and-my-workbench-001 |
| 本期范围 | pr4-bff-workbench-aggregation · PR4 · BFF 工作台聚合端点与远程代理 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### PR4 · BFF 工作台聚合端点与远程代理

#### 任务概述
工作台的数据分散在三个够不着彼此的地方：会话、审批、目录映射在本机 SQLite，材料快照在本机文件，需求本体在远程 PostgreSQL。**只有本机 BFF 同时够得着这三边**，所以聚合必须落在这里。

这一片把 PR3 交付的能力组装成一个端点，并处理最关键的一件事：**三块数据来源不同，任何一块挂了，其余两块必须照常显示**。远程连不上的时候，用户仍然应该能看到自己的待审批和会话列表。

#### 任务分解

**1. 新增 `client/server/src/application/my-workbench-service.ts`**，按四步聚合：

1. **本机 SQLite**：ref 全量（剔除 archived / deleted 会话关联的 ref）→ 跨项目会话按活跃度取前 20 → 待审批全局分组计数 → 映射列表 + 预检 → 批量运行态（计算集合 = top20 会话 ∪ 有待审批的会话）

   注意：待审批的会话即使不在 top20 也要参与运行态计算，但**只扩展计算集合，不扩展展示列表**——否则「我的会话」的长度会跳变
2. **本机文件**：读选中 ref 的 `materials/<proj>/<req>/v3-<ver>/requirement.json`
3. **远程批量**：`GET /v2/requirements?ids=`，≤100 一批分批并发
4. **内存对齐**，输出三块：
   - **待我处理**：按 待审批 > 失败回合 > 映射失效 排序
   - **我在做的需求**：ref 去重（同一需求多个会话只出现一次），按最近会话活动排序，上限 50。漂移判定 = 快照的 `title`/`summary`/`status` 与远程当前值比对，**任一不同才标记**；**绝不能用 `version` 差值**（附件增删和产物发布也会 bump version，而会话材料压根不含附件，用版本号会产生不可行动的假警报）。同一需求多个活跃会话时取**最旧**快照比对。快照缺失或损坏 → 标「快照不可读取」，不误报为漂移
   - **我的会话**：top20 + 运行态 + 所属项目 + 关联需求

**2. 判别联合 envelope**：每块是 `{status:"ready", data}` 或 `{status:"unavailable", error:{code,message}}`，**HTTP 恒 200**。三块各自 try/catch，互不牵连。远程分批时任一批失败 → 整块 unavailable，不做半块。

**3. 注册三条路由**（本片独占 `http-server.ts` 与 `server-application.ts`）：
- `GET /api/v2/my/workbench`
- `GET /api/v2/projects/:projectId/stats` — 代理远程，补 `tz` 参数
- `GET /api/v2/audit?projectId=` — 既有代理透传 `projectId`，**记得把该参数加进查询参数白名单**，否则会被静默丢掉

**4. contracts**：新增 workbench envelope 类型，走 `requirements-v2/index.ts` 子路径导出。

#### 验收标准
- [ ] 三块**分别**失败时的 envelope 降级：远程不可达 → 只有「我在做」unavailable，另两块正常；本机文件读失败 → 单条标「快照不可读取」而不是整块塌
- [ ] 漂移判定三种情况：三字段任一不同 → 标记；**仅 version 变化 → 不标记**；快照缺失 → 「快照不可读取」
- [ ] 同一需求多个活跃会话时取最旧快照比对；archived / deleted 会话的 ref 被正确剔除
- [ ] 待我处理排序符合 待审批 > 失败回合 > 映射失效
- [ ] 有待审批但不在 top20 的会话：运行态被计算，但「我的会话」列表长度仍是 20
- [ ] `stats` 与 `audit` 代理的参数透传有测试覆盖，尤其 `projectId` 与 `tz` 不被白名单丢弃
- [ ] 映射预检走 PR3 抽出的 verifier，**不经过** `requireValidatedLocalProject`（失效映射不会导致 409 拖垮整页）

#### 边界
- 不改会话运行时、审批链路、`EventBroker`
- 不改前端
- 不新增本机数据表
- 不扩展本机事件广播机制——工作台刷新用轮询，属 PR7

#### 依赖
- **PR3**。聚合注入的仓储方法、归约纯函数与 verifier 都由 PR3 交付

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-678ced53f433
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-08-25 | 物化任务文档 | 无 | 等待 dispatch 派工 |

## 五、验收标准

- [ ] 完成 `spec_section_md` 定义的实现范围。
- [ ] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [ ] 完成必要验证，并在回执中说明测试命令与结果。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## Materialization Context

- Requirement: suduo-v2-overview-and-my-workbench-001
- Section: pr4-bff-workbench-aggregation
- Owner: ccb_codex
- Priority: high
- Dependencies: subtask-678ced53f433
