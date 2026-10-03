---
doc_type: lessons
title: pr3 需求模块反馈收口走查
updated: 2026-08-26
---

# pr3 需求模块反馈收口走查

以下按原 14 处 `reportError`、7 处 `reportErrorMessage` 与 7 处成功提示逐项记录。4 项由本文件的 mock API 组件夹具实证；其余仍未覆盖。未验证项不以静态路径推断代替走查证据。

| 调用点 | 故障构造方式 | 判定结果 | 实际出口 | 观察证据 | 无副作用 |
| --- | --- | --- | --- | --- | --- |
| `RequirementsWorkbench.tsx:291` 拖拽后回查也失败 | 未验证：需让更新与回查请求同时失败 | 未验证（预期 `unknown`） | 未验证（预期 global，8000ms） | 未验证：需观察 `global-message` | 未验证：需确认仅一条提示且卡片回原列 |
| `:420` 初次打开详情失败 | 未验证：需让详情/评论/附件/审计任一请求失败 | 未验证（预期依响应而定） | 未验证（预期 global 或 page） | 未验证：需观察对应出口 | 未验证：需确认序号守卫仍生效 |
| `:494` 刷新评论审计失败 | 未验证：需在选中详情后断开评论或审计服务 | 未验证（预期 `transport_unknown`） | 未验证（预期 global，8000ms） | 未验证：需观察 `global-message` | 未验证：需确认旧评论保留 |
| `:524` 刷新附件区失败 | 未验证：需在选中详情后让附件请求返回 502 | 未验证（预期 `upstream_unavailable`） | 未验证（预期 global，8000ms） | 未验证：需观察 `global-message` | 未验证：需确认旧附件不清空 |
| `:673` 加载更多评论失败 | 未验证：需保留下一页游标并使分页请求失败 | 未验证（预期依响应而定） | 未验证（预期 global，8000ms） | 未验证：需观察 `global-message` | 未验证：需确认 loading 复位 |
| `:694` 加载更多审计失败 | 未验证：需保留下一页游标并使分页请求失败 | 未验证（预期依响应而定） | 未验证（预期 global，8000ms） | 未验证：需观察 `global-message` | 未验证：需确认 loading 复位 |
| `:712` 新建需求的 400 校验失败 | 自动化：`api.createRequirement` 返回 400 `VALIDATION_ERROR` | `validation` | `InlineError`（field，常驻） | `requirements-feedback.test.tsx`：`validation` / `field` | 自动化未断言 toast；人工副作用未验证 |
| `:726` 新建项目失败 | 未验证：需让创建项目接口返回可分类错误 | 未验证（预期依响应而定） | 未验证（预期 global 或 page） | 未验证：需观察对应出口 | 未验证：需确认对话框草稿保留 |
| `:749` 保存或归档项目失败 | 未验证：需让项目更新返回可分类错误 | 未验证（预期依响应而定） | 未验证（预期 global 或 page） | 未验证：需观察对应出口 | 未验证：需确认项目列表不误刷新 |
| `:784` 保存需求失败 | 未验证：需让需求更新返回可分类错误 | 未验证（预期依响应而定） | 未验证（预期 global 或 page） | 未验证：需观察对应出口 | 未验证：需确认编辑对话框内容保留 |
| `:812` 切换状态失败 | 未验证：需让状态更新返回可分类错误 | 未验证（预期依响应而定） | 未验证（预期 global 或 page） | 未验证：需观察对应出口 | 未验证：需确认乐观状态回滚 |
| `:828` 新增评论失败 | 未验证：需让评论创建请求失败 | 未验证（预期依响应而定） | 未验证（预期 global 或 page） | 未验证：需观察对应出口 | 未验证：需确认草稿保留、pending 复位 |
| `:925` 删除附件的非冲突失败 | 未验证：需让删除返回非 `VERSION_CONFLICT` 的错误 | 未验证（`AUTH_INVALID` 时为 `auth_expired`） | 未验证（`AUTH_INVALID` 时 page） | 未验证：需观察 `page-failure` | 未验证：需确认不刷新附件 |
| `:954` 发布 409 `AUTH_INVALID` | 自动化：`api.publishArtifactVersion` 拒绝 409 `AUTH_INVALID` | `auth_expired` | page（常驻） | `发布 AUTH_INVALID 路由 page 且不会刷新`：page store `auth_expired` / `page` | `listRequirements`、`getRequirement` 调用数均不变 |
| `:280` 拖拽冲突后成功回查 | 未验证：需先让更新冲突、再让回查成功 | 非故障，保留 `info` | 未验证（预期 global，5000ms） | 未验证：需观察 `info` / `global` | 未验证：需确认按真实列归位 |
| `:288` 拖拽回查 404 | 未验证：需先让更新冲突、再让回查返回 404 | 非故障，保留 `info` | 未验证（预期 global，5000ms） | 未验证：需观察 `info` / `global` | 未验证：需确认卡片移除且关闭详情 |
| `:375` 详情持续版本不一致 | 未验证：需连续三次返回不一致版本 | 非故障，保留 `warning` | 未验证（预期 global，5000ms） | 未验证：需观察 `warning` / `global` | 未验证：需确认不再递归拉取 |
| `:870` 上传附件版本冲突 | 未验证：需在上传时返回 `VERSION_CONFLICT` | 未验证（预期 `version_conflict`） | 未验证（预期 global，8000ms） | 未验证：需观察 `version_conflict` / `global` | 未验证：需确认附件区刷新一次 |
| `:886` 附件数量本地预检 | 未验证：需填满附件后再选文件 | 非故障，保留 `warning` | 未验证（预期 global，5000ms） | 未验证：需观察 `warning` / `global` | 未验证：需确认不发上传请求 |
| `:926` 删除附件版本冲突 | 未验证：需让删除返回 `VERSION_CONFLICT` | 未验证（预期 `version_conflict`） | 未验证（预期 global，8000ms） | 未验证：需观察 `version_conflict` / `global` | 未验证：需确认附件区刷新一次 |
| `:953` 发布产物版本冲突 | 自动化：`api.publishArtifactVersion` 拒绝 409 `VERSION_CONFLICT` | `version_conflict` | global，8000ms | `发布版本冲突经页面链路产出 version_conflict/global 并刷新`：`version_conflict` / `global` | `listRequirements`、`getRequirement` 均增量调用 |
| `:708` 新建需求成功 | 未验证：需连接可写项目并成功创建需求 | 成功 | 未验证（预期 success/global，5000ms） | 出口函数测试见 `feedback-message.test.tsx`；页面链路未验证 | 未验证：需确认刷新后打开新详情 |
| `:724` 新建项目成功 | 未验证：需连接可写服务并成功创建项目 | 成功 | 未验证（预期 success/global，5000ms） | 未验证：需观察 `success` / `global` | 未验证：需确认只切换新项目 |
| `:740` 保存、归档或恢复项目成功 | 未验证：需成功更新项目 | 成功 | 未验证（预期 success/global，5000ms） | 未验证：需观察 `success` / `global` | 未验证：需确认项目列表同步 |
| `:781` 保存需求成功 | 未验证：需成功更新需求 | 成功 | 未验证（预期 success/global，5000ms） | 未验证：需观察 `success` / `global` | 未验证：需确认评论审计刷新 |
| `:807` 切换状态成功 | 未验证：需成功更新状态 | 成功 | 未验证（预期 success/global，5000ms） | 未验证：需观察 `success` / `global` | 未验证：需确认卡片和详情同步 |
| `:919` 删除附件成功 | 未验证：需成功删除附件 | 成功 | 未验证（预期 success/global，5000ms） | 未验证：需观察 `success` / `global` | 未验证：需确认附件区刷新 |
| `:949` 发布产物版本成功 | 自动化：`api.publishArtifactVersion` resolve | 成功 | global，5000ms | `发布成功经页面链路产出 success/global`：`success` / `global` | 发布接口恰好调用一次 |

## 并发语义确认

| 项 | 确认方式与依据 |
| --- | --- |
| 写入 single-flight | 代码走查：`pendingMoves` 在 `RequirementsWorkbench.tsx:87` 保存资源键；`:262-267` 先以 `canStartMutation` 拒绝重复，再登记在途；`:294-299` 仅在 finally 删除该键。既有 `requirements-board.test.ts` 覆盖同卡第二次被拒绝。 |
| 读取 latest-wins + abort | 代码走查：`:217-244` 每次 refresh 先 abort 旧 controller，只有当前 controller 才清理 loading；`:230-236` 将新 signal 传给所有列请求。 |
| 切换/卸载后不回写 | 代码走查：`:321-328` 为详情和子资源递增请求序号；`:360-363`、`:390-405` 仅当前序号写回；`:433-438` 清理切换中的 pending id。 |
| abort 静默 | 代码走查：列请求成功与 catch 分支在 `:182`、`:192` 均先检测 `signal.aborted` 返回，故不调用 `reportFailure`。 |

补充组件证据：`RequirementsWorkbench.tsx:193-205` 的列读取路径由 `列读取 502 经 Workbench 链路渲染 RegionError` 直接实证，实际属性为 `upstream_unavailable` / `region`，且不调用 error toast；它不是原 28 行内的 `:524` 附件区刷新调用，故不挪用为该行的证据。另以 fake timers 实测已有卡片的后台刷新在 149ms 无 `board-background-refresh`、150ms 后出现 `aria-busy="true"`，卡片未清空，刷新按钮禁用且文案为「刷新中…」。
