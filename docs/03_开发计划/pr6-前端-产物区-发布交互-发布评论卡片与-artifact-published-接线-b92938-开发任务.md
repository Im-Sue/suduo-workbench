---
doc_type: dev_task
task_id: subtask-2a43c0b92938
title: pr6 前端：产物区、发布交互、发布评论卡片与 artifact.published 接线
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-pm-requirement-intake-001
section_id: pr6-web-artifact-area
order: 6
implementation_owner: ccb_codex
dependencies: [subtask-bc7e58e94f84, subtask-ff50bd246828]
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-pm-requirement-intake-001.json
source_draft_hash: 5654ce687bb41fee3b28e53498d01f5fcb5d45a3044798f4fb1bdef682d17d88
created_at: 2026-08-21T17:19:54.263Z
updated_at: 2026-08-23T08:14:01.688321Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-pm-requirement-intake-001","branch":"ccb/req-suduo-v2-pm-requirement-intake-001"}
---

# pr6 前端：产物区、发布交互、发布评论卡片与 artifact.published 接线

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 详情页产物区与发布交互、发布评论卡片、上限跟随 100；重点是 artifact.published 的两道前端关卡（parseEvent 白名单 + 分发链）都要加，只加一道是静默失效。 |
| 需求来源 | suduo-v2-pm-requirement-intake-001 |
| 本期范围 | pr6-web-artifact-area · pr6 前端：产物区、发布交互、发布评论卡片与 artifact.published 接线 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### pr6 前端：产物区、发布交互、发布评论卡片与 artifact.published 接线

#### 任务概述

把产物这件事在界面上呈现出来：需求详情页多一块**产物区**（按版本倒序列出，每版能看文件清单），能手动发布新版本，评论流里发布产生的那条评论渲染成**发布卡片**、点得回那一版。

这片有一个**特别容易漏、漏了整片就白做**的点：新事件类型 `artifact.published` 在前端有**两道**硬编码关卡，不是一道。

```
SSE 事件到达
  └─ 第一道：parseEvent 类型白名单
       RequirementsWorkbench.tsx:1085-1087   ← 技术设计 §3.2 漏写了这一处
       白名单里没有的类型直接 return null
            └─ 第二道：事件分发 if-else 链
                 RequirementsWorkbench.tsx:506-540
```

第一道在**解析阶段**。只加第二道分发分支的话，事件在第一道就被丢掉，界面永远收不到发布事件，**而且不会报任何错**——是静默失效。本机 BFF 那侧的 SSE 是透明转发、不做二次过滤（`http-server.ts:927-958`），所以前端这两处就是**仅有的**关卡。

#### 任务分解

1. **两道关卡都加**：`parseEvent` 的类型白名单（`:1085-1087`）加 `artifact.published`；事件分发链（`:506-540`）加对应分支，刷新看板卡片版本、详情、产物区与评论流。

2. **产物区 UI**（`RequirementsDetailPage.tsx`）：按版本号倒序列出，每版显示版本号、发布人、发布时间、文件数，可展开看文件清单，单个文件可下载。未被任何版本引用的附件仍显示在「其他材料」区，与产物区区分开。

3. **发布交互**：从**已上传**的附件里勾选这一版包含哪些文件，可填变更说明，提交时带上 `expectedVersion` 与 `operationKey`。
   - **不做"选本机文件直接发布"**——发布只接受已上传附件（技术设计 §3.9）。界面上要让 PM 清楚看到"先上传、再发布"这两步，而不是给一个会失败的入口。
   - 收到 409 时提示"需求已被他人改动"并刷新，不静默失败。

4. **发布评论卡片**：评论带 `artifactVersionId` 时渲染成发布卡片（可点回该版），普通评论保持原样渲染。发布说明**不可编辑**（评论 append-only，业务规则 N5）——界面上不要给编辑入口，更正靠追加评论或发新版本。

5. **容量上限跟随 100**：`RequirementsWorkbench.tsx:791-794`（`每个需求最多保留 20 个附件` 这句文案与预检）、`RequirementsDetailPage.tsx:138`（`attachmentFull` 判定）、`:191`（`xx/20` 计数显示）三处写死的 `20` 改为读 contracts `limits.ts` 的前端预检常量，**不要再写字面量**。

6. **`api/client.ts`** 补产物版本相关方法。

7. **顺手清理陈旧的"六列"陈述**：`RequirementsWorkbench.tsx` 里有 6 处写死"六列"的注释与文案（`:47`、`:49`、`:142`、`:185`、`:719`、`:753`）。pr2 加第七列时被明确禁止碰这个文件（那时它由 pr3 持有），所以这些陈述留到本片一并改掉。纯注释/文案修正，不改逻辑。

#### 验收标准

- [x] 另一个浏览器窗口发布一版之后，本窗口**不刷新页面**就能看到：看板卡片版本更新、详情产物区多一版、评论流多一张发布卡片。
- [x] 上一条必须**确认事件真的走通了两道关卡**（例如临时打日志确认事件通过了 `parseEvent`），而不是靠别的轮询碰巧刷出来了。
- [x] 产物区按版本倒序，能展开文件清单并下载单个文件。
- [x] 发布交互只能从**已上传附件**里选；发布成功后产物区与评论流都出现新内容。
- [x] 带过期版本发布收到 409，界面给出可理解提示并刷新。
- [x] 发布评论渲染为发布卡片且能点回该版；普通评论渲染不回归；界面上没有编辑历史发布说明的入口。
- [x] 附件上限提示与计数显示 100，且代码里不再有写死的 `20`。
- [x] `RequirementsWorkbench.tsx` 里不再有"六列"字样（应为七列或不写死列数）。
- [x] build / typecheck / lint 通过。

#### 边界

不改服务端与 BFF。不做产物历史清理界面。不做主文档标记。不做需求正文编辑器——标题描述与产物解耦（业务规则 N6），`summary` 就是描述。**不做权限、归属或隐藏（N8）；看板视图默认属呈现层，不得实现成访问控制。** 不做「随本次发布上传」的入口。

#### 依赖与顺序提示

依赖 **pr4**（契约 DTO 与事件类型）与 **pr5**（BFF 路由）。本片会改 `RequirementsWorkbench.tsx` 与 `RequirementsDetailPage.tsx`，**pr3 必须已经合入**（pr3 也改这两个文件的附件调用处）。

## 三、执行顺序 / 里程碑

- 前置依赖: subtask-bc7e58e94f84, subtask-ff50bd246828
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-08-21 | 物化任务文档 | 无 | 等待 dispatch 派工 |
| 2026-08-23 | 分 2 块交付，9 条验收全通过，并清偿 pr2/pr3 两笔结转债 | gate-c 会话步骤仍被模型网关阻塞，需求页断言用临时前移取证后还原 | 归档 |

## 五、验收标准

- [x] 完成 `spec_section_md` 定义的实现范围。
- [x] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [x] 完成必要验证，并在回执中说明测试命令与结果。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## Materialization Context

- Requirement: suduo-v2-pm-requirement-intake-001
- Section: pr6-web-artifact-area
- Owner: ccb_codex
- Priority: high
- Dependencies: subtask-bc7e58e94f84, subtask-ff50bd246828

## 七、验收证据

3 个提交：`3f03b6c`（两道关卡 + 产物区 + 发布交互）、`060644a`（发布卡片 + 上限 + 浏览器取证）、
`f85180f`（评审收尾：清陈旧注释）。

| # | 验收项 | 证据 |
|---|---|---|
| 1 | 跨窗口发布后本窗口无刷新更新 | Gate-C 真浏览器，断言看板 v2、产物区与发布卡片出现。截图 `08-artifact-published-sse.png`、`09-artifact-published-board.png` |
| 2 | 确认事件真走通两道关卡 | 第 1 块 `artifact.published 通过类型白名单，未知类型仍被拒绝`；第 2 块真实事件驱动详情回查断言 |
| 3 | 产物区倒序、展开、下载 | `产物区模型·按版本号倒序，且已引用文件不会混入其他材料`；截图显示展开的文件清单与下载按钮 |
| 4 | 发布只能选已上传附件 | `产物发布请求·透传 expectedVersion 与 operationKey，且只包含已勾选附件`；第二窗口真实勾选发布 |
| 5 | 过期版本发布 409 提示并刷新 | 第 1 块处理链路 |
| 6 | 发布评论渲染为卡片、可回跳、普通评论不回归、无编辑历史发布说明入口 | `artifact-published-comment` + 回跳展开 + 普通评论断言 |
| 7 | 附件上限显示 100 且无写死 20 | 改用 contracts 常量；浏览器显示 `2/100` |
| 8 | `RequirementsWorkbench.tsx` 无「六列」字样 | 已清空 |
| 9 | build / typecheck / lint | 全绿 |

### 控制器独立复核

**两道关卡的抽取重构经重点核验。** 执行方把解析逻辑抽到新模块
`requirements-events.ts`。抽取最易出的事故是「新模块加了白名单、旧的内联白名单
却留在原地继续过滤」——那样事件照样被丢且更难查。核实：
- `parseRequirementsEvent` 确在 `RequirementsWorkbench.tsx:512` 的 SSE handler 中调用
- 新白名单含 `artifact.published`
- **旧的内联白名单已移除，无重复过滤器**
- 分发分支在 `:564`

抽成独立模块是改进——白名单从此可单测。

**registry.ts 确已还原且从未提交**：其最后一次提交是 `bd030ba`（本需求之前）。

### 清偿的两笔跨片结转债

| 来源 | 债务 | 兑现 |
|---|---|---|
| pr2 | `RequirementsWorkbench.tsx` 6 处写死「六列」（pr2 当时被禁止触碰该文件，同波次 pr3 持有它） | 已清 |
| pr3 | 附件 409 的真浏览器断言（pr3 时 gate-c 无覆盖需求附件 UI 的步骤，仅有代码实证） | 已补，截图 `10-attachment-version-conflict-refreshed.png`，断言提示出现且自动刷新至 v3 |

### 评审收尾修正（`f85180f`）

验收第 8 条只点名 `RequirementsWorkbench.tsx`，该文件确已清干净、条款满足。
但 `api/client.ts:778` 与 `components/AppNav.tsx:30` 仍写着「六列」——
看板加档后这两句已与事实矛盾，且属本需求改动的直接后果，批次结束后无人再捡。
由控制器在评审收尾时一并修正（两处注释用词），避免代码库自相矛盾。

### 最终验证（控制器独立复跑）
typecheck 四包全 Done；lint exit 0；test **50 files / 244 tests 全通过**。

### 遗留（非本片范围）
Gate-C 完整链路在需求页取证后，仍在既有 `assistant-approval` 的
`message-input` 30 秒超时处停止，与 `gate_c_blocked_by_gateway` 一致，
属模型网关长流式稳定性问题，不影响本片浏览器断言。
