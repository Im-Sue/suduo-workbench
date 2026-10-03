---
doc_type: lessons
title: pr4 会话模块反馈收口走查
updated: 2026-08-27
---

# pr4 会话模块反馈收口走查

以下按 8 处 `SessionRuntime` 失败调用和 2 处 `SessionsWorkbench` 原 warning 调用逐项记录。当前组件夹具实证 4 个场景（其中终态错误同时验证 region 出口和 N4 持久性）；其余 9 个失败调用点未构造，均明确标为未验证，未以静态路径推断替代。

| 调用点 | 故障构造方式 | 判定结果 | 实际出口 | 观察证据 | 无副作用 |
| --- | --- | --- | --- | --- | --- |
| `SessionRuntime.tsx:219` 初次读取会话失败 | 自动化：`api.getSession` 返回 502 `DEPENDENCY_UNAVAILABLE` | `upstream_unavailable` | `RegionError`（region，常驻） | `sessions-feedback.test.tsx`「终态错误以持久 RegionError 留在会话上下文」：`upstream_unavailable` / `region`，fake timer 60s 后仍在 | 自动化：未调用 error toast；关闭前错误仍留在会话 pane |
| `SessionRuntime.tsx:416` 展开未加载目录失败 | 未验证：展开一个尚未加载的目录并让 `listFiles` 返回 502 | 未验证（预期 `upstream_unavailable`） | 未验证（预期 region，常驻） | 未验证：需观察 `region-error` 属性 | 未验证：需确认目录展开状态保留且不发 toast |
| `SessionRuntime.tsx:443` 打开 diff 失败 | 未验证：选择变更文件并让 `diff` 返回 502 | 未验证（预期 `upstream_unavailable`） | 未验证（预期 region，常驻） | 未验证：需观察 `region-error` 属性 | 未验证：需确认 busy 复位、抽屉不误开 |
| `SessionRuntime.tsx:450` 用系统应用打开失败 | 未验证：选择文件并让 `openFile` 返回 502 | 未验证（预期 `upstream_unavailable`） | 未验证（预期 global，8000ms） | 未验证：需观察 `global-message` 的 `upstream_unavailable` / `global` | 未验证：需确认不覆盖已有本地错误块 |
| `SessionRuntime.tsx:472` 审批决定失败 | 未验证：对待决审批提交决定并让 `decideApproval` 返回 502 | 未验证（预期 `upstream_unavailable`） | 未验证（预期 global，8000ms） | 未验证：需观察 `global-message` 属性 | 未验证：需确认 busy 复位、不新增决定记录 |
| `SessionRuntime.tsx:489` 重命名失败 | 未验证：编辑标题并让 `updateSession` 返回 502 | 未验证（预期 `upstream_unavailable`） | 未验证（预期 global，8000ms） | 未验证：需观察 `global-message` 属性 | 未验证：需确认会话标题不被错误回写 |
| `SessionRuntime.tsx:563` 切换审批模式失败 | 未验证：切换审批模式并让 `updateSession` 返回 502 | 未验证（预期 `upstream_unavailable`） | 未验证（预期 global，8000ms） | 未验证：需观察 `global-message` 属性 | 未验证：需确认当前会话状态未替换 |
| `SessionRuntime.tsx:571` 中断回合失败 | 未验证：运行中点击中断并让 `interrupt` 返回 502 | 未验证（预期 `upstream_unavailable`） | 未验证（预期 global，8000ms） | 未验证：需观察 `global-message` 属性 | 未验证：需确认不中断其他运行态渲染 |
| `SessionsWorkbench.tsx:108` 初次/刷新会话列表失败 | 未验证：让 `listRequirementsSessions` 返回 502 | 未验证（预期 `upstream_unavailable`） | 未验证（预期 global，8000ms） | 未验证：需观察 `global-message` 属性 | 未验证：需确认旧左栏树不清空 |
| `SessionsWorkbench.tsx:221` 归档或删除请求失败 | 未验证：在确认后让更新/删除接口返回 502 | 未验证（预期 `upstream_unavailable`） | 未验证（预期 global，8000ms） | 未验证：需观察 `global-message` 属性 | 未验证：需确认不关闭未删除的当前 pane |
| `SessionRuntime.tsx:219` 中途 abort | 自动化：`api.getSession` 拒绝 `AbortError` | `cancelled` | silent | `sessions-feedback.test.tsx`「AbortError 归类为 cancelled 后不产生任何反馈」：无 `region-error`、`page-failure`、error toast | 自动化：无任何反馈出口 |
| `SessionsWorkbench.tsx:289` 删除确认 | 自动化：点击删除，再点击对话框确认 | 非故障；`needsConfirm("delete-session") = true` | `ConfirmDialog`（取消默认焦点） | `sessions-feedback.test.tsx`「删除会话由 ConfirmDialog 默认聚焦取消，确认后才调用 API」 | 自动化：确认前 `deleteSession` 未调用；当前会话为空时未调用 `onCloseSession` |
| `SessionsRail.tsx:125` / `:155` 会话空态 | 自动化：传入空树 | `prerequisite` / `empty` | 两个 `EmptyState` | `sessions-feedback.test.tsx`「需求会话与项目会话的两个空态均通过 EmptyState 呈现」：两个节点及两个动作 | 自动化：均提供新建项目会话入口；需求会话文案明确需从需求页发起 |
| `TablePreview.tsx:99` xlsx 解析失败 | 未验证：让 `fetch` 或动态导入拒绝 | 未验证（依 cause 而定） | 未验证（预期 region，常驻） | 未验证：需观察 `region-error` 属性 | 未验证：需确认不影响加载/多 sheet 状态机 |

## 策略与已知缺口

| 项 | 结论与依据 |
| --- | --- |
| 归档确认 | 保留并迁 `ConfirmDialog`：`needsConfirm("archive-session")` 为真；归档虽可逆，但影响项目且恢复成本高。 |
| 删除确认 | 保留并迁 `ConfirmDialog`：不可逆、影响项目、恢复不可能；危险动作默认焦点在取消。 |
| SSE 断连 | `SessionRuntime.tsx:287` 文件 watcher 与 `:377` 会话流均未注册 `onerror`；断连当前完全静默、无 toast。会话侧无连接状态标识；依裁决不新建，作为已知缺口记录。 |
| 重复告警 N5 | 本模块无短时间重复的反馈调用；SSE 断连无 handler，故不存在可加 `MessageOptions.id` 的重复告警场景。 |
| 组件测试统计 | 4 个场景已实证（终态 region+持久、cancelled 静默、删除确认、两个空态）；9 个失败调用点与 TablePreview 解析失败未验证，原因及所需构造方式见表。 |
