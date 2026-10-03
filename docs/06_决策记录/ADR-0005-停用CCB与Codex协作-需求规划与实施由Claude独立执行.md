---
id: ADR-0005
title: 停用 CCB 机制与 Codex 协作，需求的规划与实施全部由 Claude 独立执行
doc_type: adr
status: accepted
supersedes: []
superseded_by:
date: 2026-09-29
---

# ADR-0005: 停用 CCB 机制与 Codex 协作，需求的规划与实施全部由 Claude 独立执行

> 一个决策一篇，记下"为什么这么定"，防止以后反复扯 / 误改
>
> **状态**：accepted ｜ **拍板人**：用户（2026-09-29）

---

## 一、背景

用户原话（2026-09-29）：

> "记录一个决策，这个项目所有需求的规划和实施全部由你claude来执行，不再使用ccb机制和发给codex沟通了"

在此之前，本项目按 CCB 双角色协作运行（`CLAUDE.md` 的「CCB 协作角色」托管块 + `AGENTS.md`）：

- **Claude**：需求理解、方案设计、协商、任务拆分、审查决策、文档决策；不写大块代码、模块规格、经验沉淀和代码注释。
- **Codex**：按 Claude 的任务 Spec 实施、验证、写详细文档，回执给 Claude 审查。
- **流程机制**：`/ccb:su-*` 节点入口 + plugin 侧 `references/kernel/` 节点 manifest（ADR-0030）；每个业务节点至少 1 轮 `mode: consult` Codex 协商；`ccb ask` 异步派工；每需求一个 git worktree，由 CCB 合并与归档；Console indexer 生成 `docs/00_文档地图.md` 与 `docs/.ccb/` 索引、流水账。

用户未展开理由，本 ADR 不代为补写。

---

## 二、决策

用户拍板的部分：

1. 本项目**所有需求**的规划与实施——需求分析、方案设计、任务拆分、编码、测试验证、文档——**全部由 Claude 执行**。
2. **不再使用 CCB 机制**：不走 `/ccb:su-*` 节点流程，不受 `references/kernel/` 约束，不再依赖 CCB 的 worktree 合并/归档、Console indexer 与事件流水账。
3. **不再与 Codex 沟通**：不派工（`ccb ask`），也不做 consult 协商。

Claude 为落地补充的执行细则（用户可随时修订）：

4. **文档体系保留**：`docs/` 人读文档仍是真相源；目录结构与命名沿用现状，落点参考 `docs/.ccb/docs-structure-contract.yaml`；需求 / ADR 的 frontmatter `status` 由 Claude 手动维护。项目 ADR（0001–0004）不受影响，ADR-0004 一致性边界照常执行。
5. **分级处理**：简单任务直接实施；中等任务先写需求文档，复杂任务再加技术方案，均经用户确认后实施。开发任务文档（dev_task）原本是给 Codex 的派工单，不再强制。
6. **决策权**：需求范围、业务规则与高影响技术决策由用户拍板，Claude 给推荐。原「协商达上限再升级用户」的路径随 Codex 协商一并取消。
7. **质量门**：实施后跑与改动相关的 typecheck / lint / test（涉及端到端链路时跑对应 gate 脚本）；高影响改动提交前用独立 subagent 或 `/code-review` 复核；未验证项显式说明。

---

## 三、否决的方案

| 方案 | 为什么没选 |
|------|------------|
| 保留 Codex 只做 consult（第二意见），实施改由 Claude | 用户明确"不再发给 Codex 沟通" |
| 保留 CCB 节点流程，只把执行者从 Codex 换成 Claude | 用户明确"不再使用 CCB 机制"；节点、派工、回执、worktree 编排本是为协调两个 agent 设计的，单方执行时是纯开销 |

---

## 四、影响

- **好处**：从需求到代码由一方负责到底，省掉任务 Spec → 派工 → 回执 → 审查的往返和上下文搬运。
- **代价 / 风险**：
  - **失去独立第二视角**。Codex 协商曾实质性纠正过方案，例如 ADR-0004 定稿前复核 8 个守卫点，一致性守卫退役需求里提示"勿顺手删行锁"。第 7 条的复核只能部分弥补。
  - **状态投影停摆**。Console 不再实时显示需求状态；`docs/00_文档地图.md` 停在 2026-09-21 的生成版本；`docs/.ccb/` 不再更新。
  - **托管块可能被覆盖**。若日后再运行 CCB 初始化，可能重写 `CLAUDE.md` 协作段，届时需以本 ADR 为准恢复。
- **受影响**：
  - 已更新：`CLAUDE.md` 协作段（去掉 CCB 托管标记）、`docs/00_项目总览.md` 项目约定。
  - 保留原样、处于休眠：`AGENTS.md`、`ccb.config`、`.claude/hooks/` 两个 CCB 钩子（均已核实当前不会触发）、`docs/.ccb/`、`docs/00_文档地图.md`。是否清理另行决定。

---

## 五、过渡

| 在途项 | 决策时状态 | 处理 |
|---|---|---|
| 一致性守卫退役 `suduo-v2-consistency-guard-retirement-001` | delivering，代码已合入 main | Claude 核对后手动置 delivered，不再走 `su-archive` |
| 对话界面的交互设计 `cmto2qafxd2362785ef3af281` | delivering，代码已合入 main | 同上 |
| V2 缺陷修复与体验优化 | drafting | 按新方式继续，待用户补清单 |
| 遗留 token 文档漂移与 runtime 事件噪音 | planning | 按新方式继续 |
| 架构：Stream 模式接入钉钉 | deferred | 不变 |

---

## 六、关联

| 关系 | 对象 |
|------|------|
| 相关决策 | ADR-0004（一致性边界，继续有效） |
| 在本项目内停用 | CCB plugin 侧 ADR-0030（节点范式）；ADR-0037（文档驱动架构）中的 plugin / indexer 接线部分，目录结构约定继续沿用 |
| 相关文档 | `CLAUDE.md`、`docs/00_项目总览.md` |

---

## 七、决策依据

- 第 1–3 条：用户 2026-09-29 原话（见一、背景）。
- 第 4–7 条：Claude 为让第 1–3 条可执行而补的默认安排，未经 Codex 协商（本决策本身即取消协商）；用户修订时直接改本节与 `CLAUDE.md`。
