---
doc_type: lessons
title: pr5 设置页主壳反馈收口走查
updated: 2026-08-27
---

# pr5 设置页主壳反馈收口走查

以下逐项记录原 12 处 `showMessage` 与 5 处 `window.confirm`。标签严格区分：3 项调用点有运行用例实证；13 项夹具可构造但本轮未做；「打开配置文件」的真实系统编辑器行为受运行环境限制，标为未验证并说明原因。静态阅读不计为实证。

| 调用点 | 故障构造方式 | 判定结果 | 实际出口 / 确认结论 | 观察证据 | 无副作用 |
| --- | --- | --- | --- | --- | --- |
| `SettingsPage.tsx:158` 读取本机设置 | 实证：`api.getSettings` 分别返回 502 `DEPENDENCY_UNAVAILABLE`、409 `AUTH_INVALID` | 502 → `upstream_unavailable`；AUTH → `auth_expired` | 502 → `RegionError`（region，常驻）；AUTH → page（常驻） | `settings-feedback.test.tsx`：`upstream_unavailable` / `region`；page store 的 `auth_expired` / `page` | 实证：502 未调用 error toast；AUTH 没有 region 回退 |
| `SettingsPage.tsx:169` 读取映射 | 可构造但未做：夹具让 `listRequirementsMappingsVerified` 返回 502 | 预期 `upstream_unavailable` | 预期 `RegionError`（region，常驻） | 未做：需观察 `region-error` 属性 | 未做：需确认旧映射列表不清空 |
| `SettingsPage.tsx:190` 保存本机设置 | 可构造但未做：夹具让 `updateSettings` 返回 502 | 预期 `upstream_unavailable` | 预期 global，8000ms | 未做：需观察 `global-message` 属性 | 未做：需确认保存中状态复位 |
| `SettingsPage.tsx:391` 保存需求服务地址失败 | 可构造但未做：夹具让 `updateRequirementsSettings` 返回 400 `VALIDATION_ERROR` | 预期 `validation` | 预期 `InlineError`（field，常驻） | 未做：需观察 `inline-error` 属性 | 未做：需确认地址草稿保留 |
| `SettingsPage.tsx:412` 退出登录失败 | 可构造但未做：夹具让 `logoutRequirements` 返回 502 | 预期 `upstream_unavailable` | 预期 global，8000ms | 未做：需观察 `global-message` 属性 | 未做：需确认登录态不被前端误清空 |
| `SettingsPage.tsx:548` 解除映射失败 | 可构造但未做：夹具让 `removeRequirementsMapping` 返回 502 | 预期 `upstream_unavailable` | 预期 global，8000ms | 未做：需观察 `global-message` 属性 | 未做：需确认映射行保留 |
| `SettingsPage.tsx:654` 新增映射失败 | 可构造但未做：夹具让 `saveRequirementsMapping` 返回 400 `VALIDATION_ERROR` | 预期 `validation` | 预期 `InlineError`（field，常驻） | 未做：需观察 `inline-error` 属性 | 未做：需确认项目/目录草稿保留 |
| `SettingsPage.tsx:851` 运行自检失败 | 可构造但未做：夹具让 `runDoctor` 返回 502 | 预期 `upstream_unavailable` | 预期 global，8000ms | 未做：需观察 `global-message` 属性 | 未做：需确认运行按钮复位 |
| `SettingsPage.tsx:881` 复制诊断成功 | 可构造但未做：夹具 resolve `navigator.clipboard.writeText` | 非故障 | success/global，5000ms | 未做：需观察 `success` / `global` | 未做：不影响诊断结果 |
| `SettingsPage.tsx:883` 剪贴板拒绝 | 可构造但未做：夹具 reject `navigator.clipboard.writeText` | 不适用（浏览器 API 无 `(status, code)`） | 保留 warning/global，5000ms | 未做：需观察 `warning` / `global` | 未做：不改诊断结果，提示用户手动选择文本 |
| `SettingsPage.tsx:991` 打开配置成功 | 未验证（客观障碍：需真实系统编辑器） | 非故障 | success/global，5000ms | 未验证：需观察系统编辑器与成功 toast | 未验证：服务端固定目标路径，不接受任意路径 |
| `SettingsPage.tsx:993` 打开配置失败 | 可构造但未做：夹具让 `openCodexConfigFile` 返回 502 | 预期 `upstream_unavailable` | 预期 global，8000ms | 未做：需观察 `global-message` 属性 | 未做：不触发系统编辑器 |
| 原 `:260` 修改需求服务地址 | 实证：有登录态、编辑地址、点击保存后确认 | 非故障；`needsConfirm("change-requirements-service")` 为真 | 保留并迁 `ConfirmDialog`：变更清除本机远程登录态，账户影响且恢复成本高 | `修改服务地址在确认后才保存，并继续触发登录态刷新`：确认前未调用，确认后 `updateRequirementsSettings` 与 `onChanged` 各一次 | 实证：确认前零写入；登录态刷新链路保留 |
| 原 `:343` 退出登录 | 可构造但未做：夹具点击退出并选择确认 | 非故障；`needsConfirm("logout-requirements")` 为真 | 保留并迁 `ConfirmDialog`：账户影响、恢复需重新认证 | 未做：需断言取消默认焦点与确认后 `logoutRequirements` | 未做：需确认取消零调用 |
| 原 `:411` 解除映射 | 可构造但未做：夹具提供映射行并点击解除 | 非故障；`needsConfirm("unlink-workspace-mapping")` 为真 | 保留并迁 `ConfirmDialog`：项目影响，恢复要重新配置目录 | 未做：需断言取消默认焦点与确认后删除 | 未做：需确认取消不影响映射 |
| 原 `:525` 设为完全访问 | 实证：点击 `full` 单选并点击取消 | 非故障；安全影响按 account / costly 计，`needsConfirm` 为真 | 保留并迁 `ConfirmDialog`：完全放行命令与网络；改回默认值无法收回既有完全访问会话 | `完全访问确认默认聚焦取消，取消绝不写入设置`：焦点在取消，`updateSettings` 为 0 | 实证：取消零写入 |
| 原 `:778` 用系统编辑器打开配置 | 未验证（客观障碍：真实系统编辑器不可在 jsdom 观察） | 非故障；`needsConfirm` 不适用 | **去掉确认**：仅请求打开固定配置文件，不修改数据、不抬升权限；失败走 action/global | 代码与夹具未模拟真实系统打开 | 未验证：需人工确认系统编辑器返回后不改变其他设置 |

## 交互与 loading 证据

| 项 | 标签 | 证据 |
| --- | --- | --- |
| 两处空态 | 实证 | `工作目录空态与占位组均使用 EmptyState`：映射空态与 `GroupPlaceholder` 共两个 `empty-state`，均为 `prerequisite`。 |
| 状态条 loading | 实证 | `状态条 150ms 后才显示 aria-busy 的读取提示`：149ms 不出现，150ms 出现 `settings-status-loading[aria-busy=true]`；阈值来自 `FEEDBACK_TIMING_MS.backgroundRefresh`。 |
| 未保存内容离开拦截 | 实证 | `服务地址有草稿时切换分组提供取消、放弃与继续编辑`：三选一对话框出现；继续编辑回焦地址输入框；放弃后切到工作目录且不写入服务地址。 |

## 统计与冻结契约

- 三分标签（17 调用点）：实证 3、可构造但未做 13、未验证（客观障碍）1。
- 组件用例共 7 条：完全访问确认、服务地址确认、region 出口、两处空态、未保存离开拦截、`auth_expired → page`、150ms `aria-busy`。
- `settings-kit.tsx` 的 `DirtyBar` / `SettingsGroup` / `SettingsRow` 导出 props 签名未改；`skill-project-context.ts` 无 diff，`SkillProjectOption` / `skillProjectOptions` / `defaultSkillProjectId` 签名未改。
