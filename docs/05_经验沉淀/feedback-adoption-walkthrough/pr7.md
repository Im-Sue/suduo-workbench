---
doc_type: lessons
title: pr7 应用壳与页面级失败纳管走查
updated: 2026-08-27
---

# pr7 应用壳与页面级失败纳管走查

本片记录 `RequirementsV2App` 原 4 处 `showMessage`、鉴权页面级闭环、登录表单与全局边界。实证均来自隔离 jsdom 夹具；没有触发真实远程需求服务、MCP、stdio 或系统操作。其余能由 API mock 构造但未写专项用例的场景明确标为「可构造但未做」。

| 调用点 | 故障构造方式 | 判定结果 | 实际出口 | 观察证据 | 无副作用 |
| --- | --- | --- | --- | --- | --- |
| `RequirementsV2App.tsx:91` 壳层读取设置或远程项目失败 | 可构造但未做：`requirementsSettings` / `listRequirementsProjects` 拒绝 502 `DEPENDENCY_UNAVAILABLE` | `upstream_unavailable` | page（常驻） | 未做：观察 `page-failure` 的 `upstream_unavailable` / `page` | 不清空上一次已加载项目；不发第二个 toast |
| `RequirementsV2App.tsx:224` 创建需求会话前映射检查或创建失败 | 可构造但未做：`listRequirementsMappings` 或创建接口拒绝可分类响应 | 依响应 `classifyFailure` | action → error/global，8000ms；AUTH → page | 未做：观察对应属性 | `WORKSPACE_MAPPING_REQUIRED` 仍只打开映射表单，不误报失败 |
| `RequirementsV2App.tsx:230` 未选择远程项目时新建会话 | 实证：无项目时触发 `onCreateProjectSession` | 非故障，前置条件未满足 | 行内 prerequisite / field，常驻 | `无远程项目时给行内前置条件提示而非 toast`：`data-feedback-kind=prerequisite`，toast 0 次 | 不发映射查询或创建会话请求；选择项目后清除提示 |
| `RequirementsV2App.tsx:252` 登出失败 | 实证：先触发 AUTH 页面失败，再让 `logoutRequirements` 拒绝 `TypeError` | `transport_unknown` | error/global，8000ms | `裸 TypeError 的错误 toast 文案不归因本机 BFF 故障`：含「暂时无法连接工作台」，不含网络/启动/CORS/防火墙/代理 | page failure 保留，不把错误伪装成已登出 |

## 鉴权、登录与历史行为

| 项 | 标签 | 证据 |
| --- | --- | --- |
| 409 `AUTH_INVALID` → PageFailure → 可用去登录 → logout | 实证 | `409 AUTH_INVALID 显示可用去登录，点击后登出并清除页面失败`：`page-failure` 的按钮未 disabled，`logoutRequirements` 1 次。 |
| logout 成功清理页面失败 | 实证 | 同上：`getPageFeedback()` 最终为 `null`，随后读取无 session 的 settings。 |
| 登录成功清理页面失败 | 实证 | `登录成功也会清除已有页面失败`：提交后 `loginRequirements({ loginName:"sue", password:"secret" })`，`getPageFeedback()` 为 `null`。 |
| 409 AUTH 不进版本冲突刷新 | 实证 | 同首条：发布 page feedback 后，点击去登录前 `listRequirementsProjects` 调用数不变；没有刷新分支。 |
| 登录失败 | 实证 | `登录失败在表单内渲染 InlineError`：400 `VALIDATION_ERROR` 呈现 `inline-error` 的 `validation` / `field`。 |
| 退出需求详情 | 实证 | `退出需求详情仍调用 history.back 而非创建新历史项`：`history.back()` 恰好 1 次。 |

## 故障分级镜像

| 类别 | 判定方式 | 打扰级别与出口 | 文案 / 操作 |
| --- | --- | --- | --- |
| 鉴权失效 | 401 或 code `AUTH_INVALID`（code 优先） | assertive；page 常驻 | 「登录状态已失效，请重新登录」；`registerAuthExpiredHandler(logout)` 提供可用「去登录」。logout 成功、登录成功均 `clearPageFeedback()`。 |
| 浏览器 → 本机 BFF 不通 | 裸 `TypeError`；壳层、登录和映射表单丢弃原始 TypeError message 后分类 | 壳层 action 为 error/global 8000ms；表单为 InlineError | 「暂时无法连接工作台，请稍后重试」；不归因网络、启动、CORS、防火墙或代理，不给启动动作。 |
| BFF → 远端不通 | `DEPENDENCY_UNAVAILABLE` 或 502/503/504 | 壳层读取为 page；动作失败为 error/global 8000ms；有字段的表单按 field | 「依赖服务暂时不可用，请稍后重试」；保留当前内容或草稿。 |
| SSE 断连 | 会话侧 `EventSource` 无 `onerror`，沿用既有静默处理 | silent；不新增连接指示器 | 不弹 toast；本片不修改 sessions 域。 |

## 壳层层级与在途规则

| 项 | 结论 |
| --- | --- |
| `MessageHost` | 保持原挂载行 `<MessageHost />` 零修改；仅通过 page store 注册 handler。 |
| AppErrorBoundary | 仅改文案与层级说明：它只承接未捕获渲染错误；可恢复的 page/region 错误留在原上下文。`reload` / `clearCacheAndReload` 的实现与 localStorage 清理规则未改。 |
| 详情与模式切换 | 读取/写入并发语义仍由各域拥有；壳层不回写已离开的详情。`closeRequirement` 继续使用 `history.back()`，避免「看板→详情→看板」历史死循环。 |
| 工作区映射弹窗 | **FormDialog**：需要填写本机目录、保存时校验并保留草稿，非不可逆确认；400 等校验失败走 `InlineError`。 |

## 统计与已知缺口

- 4 个调用点三分标签：实证 2、可构造但未做 2、未验证（客观障碍）0。
- 组件夹具共 6 条：AUTH/logout/clear/无刷新、登录成功 clear、登录 InlineError、前置条件行内提示、`back()`、TypeError 中性文案。
- 未覆盖的两条壳层 API 失败路径可由同一 mock 构造；本片没有触发真实外部服务。
