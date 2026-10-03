---
doc_type: dev_task
task_id: subtask-7f83290ffa2d
title: pr1 auto 档 loopback 可达性实测与 skill 档位结论
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-pm-requirement-intake-001
section_id: pr1-auto-loopback-probe
order: 1
implementation_owner: ccb_codex
dependencies: []
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-pm-requirement-intake-001.json
source_draft_hash: 5654ce687bb41fee3b28e53498d01f5fcb5d45a3044798f4fb1bdef682d17d88
created_at: 2026-08-21T17:19:54.263Z
updated_at: 2026-08-22T04:58:54.489183Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-pm-requirement-intake-001","branch":"ccb/req-suduo-v2-pm-requirement-intake-001"}
---

# pr1 auto 档 loopback 可达性实测与 skill 档位结论

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 实测 codex 沙箱 auto 档（workspace-write + networkAccess:false）下能否 curl 通本机 BFF，确定官方 skill 最低可用档位并回写技术设计 §5.4。不改任何代码。 |
| 需求来源 | suduo-v2-pm-requirement-intake-001 |
| 本期范围 | pr1-auto-loopback-probe · pr1 auto 档 loopback 可达性实测与 skill 档位结论 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### pr1 auto 档 loopback 可达性实测与 skill 档位结论

#### 任务概述

官方 skill 要「发上去」和「拉下来」，靠的是在会话里用 curl 调本机 BFF（`http://127.0.0.1:<port>`）。问题是：会话跑在 codex 沙箱里，`auto` 档的配置是 `workspace-write` + `networkAccess: false`（`client/contracts/src/config.ts:25-27`）。**沙箱把「访问 127.0.0.1」算不算「访问网络」，官方文档没有声明例外。** 如果算，auto 档下 skill 根本调不通 BFF，pr7 写出来的 skill 只能在 full 档用——这会直接改变 pr7 的交付形态。

所以这件事必须**实测**，不能推定，而且要在写 skill 之前测完。这片不改任何代码，只跑命令、记结果、给结论。放在最前面是为了：万一不可达，替代路径能在早期暴露，而不是等 pr7 做完才发现。

#### 任务分解

1. **起 BFF**：在宿主机把 client/server 跑起来，记下实际端口。
2. **宿主机基线**：跑 healthz，确认服务本身没问题。这是对照组，排除「其实是服务没起来」这种误判。
3. **auto 档会话内实测**：在一个 `auto` 档会话里跑同一条命令，记录三件事：HTTP 状态码、**是否弹出审批**、失败时的错误文本。
4. **Origin 头必要性验证**：`loopback-guard`（`client/server/src/infrastructure/http/loopback-guard.ts`）对写方法强制同源。分别跑带 `-H 'Origin: http://127.0.0.1:<port>'` 与不带的 POST，确认前者非 403、后者 403。
5. **写结论**：结果回写技术设计 §5.4，明确写出「skill 的最低可用档位是 X」。若 auto 档不可达，额外给 1–2 条替代路径建议（例如把发布做成需求页 UI 动作，或在 skill 文档标注需 full 档）。

命令（技术设计 §5.4）：

```bash
curl --noproxy '*' -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/healthz
```

判定口径：**宿主机 200，且 auto 会话内无审批弹窗也得到 200**，才算 loopback 可用。

#### 验收标准

- [x] 宿主机与 auto 档会话**各跑一次**，两条结果都有记录（状态码 + 是否弹审批）。
- [x] Origin 头的两种情况都跑过，结果符合「带 = 非 403、不带 = 403」，或如实记录不符之处。
- [x] 技术设计 §5.4 补上结论行，明确 skill 最低可用档位。
- [x] auto 档不可达时给出替代路径建议，并标注这会影响 pr7 的交付形态。

#### 边界

不改 `client/contracts/src/config.ts` 的档位定义，不改 `loopback-guard`，不写 skill，不改任何产品代码。这片只产出**结论**。

## 三、执行顺序 / 里程碑

- 前置依赖: 无
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-08-21 | 物化任务文档 | 无 | 等待 dispatch 派工 |
| 2026-08-21 | 实测完成，结论回写技术设计 §5.4 | 执行 agent 自身是 full 档，无法自证 auto 档；改用 `codex sandbox` 子命令直接在指定策略下跑命令 | 归档；结论交 pr7 采用 |

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
- Section: pr1-auto-loopback-probe
- Owner: ccb_codex
- Priority: high
- Dependencies: none

## 七、实测记录（pr1 交付）

**结论：auto 档 loopback 不可达；官方 skill 的最低可用档位是 `full`。**

测量仪器：`codex sandbox`（codex-cli 0.147.0），在指定沙箱策略下直接执行命令，
不经 LLM 回合。这比「另起一个 auto 会话再肉眼看审批 UI」更精确、可复现。

| # | 沙箱策略 | 档位 | exit | HTTP | 结果 |
|---|---|---|---|---|---|
| 基线 | 宿主机无沙箱 | — | 0 | 200 | 可达（对照组） |
| A | `workspace-write`，network 默认 | auto | 7 | 000 | 不可达 |
| B | `workspace-write` + `network_access=false` | auto | 7 | 000 | 不可达 |
| C | `danger-full-access` | full | 0 | 200 | 可达 |
| D | `workspace-write` + `network_access=true` | 非标准 | 0 | 200 | 可达 |
| E | `read-only` | ask | 7 | 000 | 不可达 |

失败文本一律 `curl: (7) Failed to connect to 127.0.0.1 port 8787 after 0 ms`。
**无审批弹窗**——连接在 0 ms 内被沙箱直接拒绝，根本走不到审批环节。

`network_access` 是唯一决定因素（A/B 关网不可达，D 开网可达，其余条件不变）。
网络白名单不存在：`allowed_domains` / `allow_loopback` / `network_allowlist`
三种键名均无效，沙箱网络是二元开关，无法只放行 127.0.0.1。

Origin 头（同批实测）：不带 POST → 403 `ORIGIN_REJECTED`；带同源 → 非 403（404 路由不存在）；
带异源 → 403；GET 不带 → 非 403。符合预期，写请求必须带同源 Origin。

详细结论、替代路径与对 pr7 的影响见技术设计 §5.4。
本片未改任何产品代码（边界要求）。
