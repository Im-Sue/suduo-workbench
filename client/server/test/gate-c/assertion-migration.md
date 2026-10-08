# Gate C 断言迁移矩阵

基线：`client/server/test/gate-c.real.ts`（当时在 apps/server 下）在 pr1 前的旧壳路径。`replacement` 必须由指定责任片核销；仅 `retired` 可在 pr13 保留且必须保留理由。

| 旧断言标识 | 处置 | 原因 | 责任片 | 新步骤模块与 testid | 证据位置 |
|---|---|---|---|---|---|
| `add-project` | retired | 本地建项目是已删除旧壳路径；V2 使用远程项目，不为测试恢复本地入口。 | pr1 | `v2-user-path`：登录后远程项目选择器 `aria-label=当前远程项目` | `steps/v2-user-path.ts` |
| `project-path` / `project-submit` | retired | 本地项目对话框属于旧壳；V2 只在映射时输入本机目录。 | pr1 | `v2-user-path`：`dialog[配置当前项目工作目录]`、`保存并继续` | `steps/v2-user-path.ts` |
| 旧 `suduo.projectId` / `suduo.sessionId` localStorage | replacement ✅**已核销** | V2 以 URL 的 `projectId`/`sessionId` 与 `suduo.v2.remoteProjectId` 为状态载体。 | pr1 | `steps/v2-user-path.ts:33-35` 断言 URL query 的 `projectId`/`sessionId` 与 `localStorage` 的 `suduo.v2.remoteProjectId` 三者齐备，缺一即抛错 | `steps/v2-user-path.ts`（**pr13 核对：断言早已存在并随 gate-c 通过，此前只是漏标核销**） |
| `new-session` | replacement ✅**已核销** | 该 testid 属孤儿 `LeftRail`（pr8 已删除）；V2 新会话入口由稳定三段 rail 接管。 | pr8 | `SessionsRail` 的 `new-session`（同名保留，语义换为 V2 项目会话入口） | `steps/sessions-rail.ts` |
| `rail-tab-sessions` | replacement ✅**已核销** | 旧 rail 的 tab 形态被同屏三段导航取代，不再需要在会话/文件间切换。 | pr8 | `sessions-rail` / `session-row` / `session-search`；三段常驻无需 tab | `steps/sessions-rail.ts`，截图 `08-sessions-rail.png` |
| `rail-tab-files` / `.file-row .blue-dot` | replacement ✅**已核销** | 文件树已迁至右侧改动面板标签页；蓝点为旧壳专有，永久退役。 | pr8 | `side-tab-files` / `side-file-tree` / `side-tab-changes` | `steps/sessions-rail.ts` |
| `change-item` / `diff-view` | replacement ✅**已核销** | Diff 能力仍在，且已在 V2 同屏形态下持续验证。 | pr8 | `steps/changes-and-diff.ts:8-12` 在 V2 会话页内点 `change-item` 并断言 `diff-view` 出现 | `steps/changes-and-diff.ts` + 截图 `02-diff-view.png`（**pr13 核对：pr8 把会话页改为同屏形态后该步骤仍全绿，等于已在 V2 形态下核销，此前只是漏标**） |
| 需求状态拖拽与冲突分支 | replacement ✅**已核销** | 看板为本需求新能力，旧 gate-c 无等价断言。 | pr7 | `steps/requirements-board.ts`：`board-column-*` / `board-card` / `board-count-*`；含六列独立加载、拖拽改状态、409 冲突后落真实列三项断言 | `steps/requirements-board.ts`，截图 `06-requirements-board.png` / `07-board-conflict-resolved.png` |
| 设置页 hash 深链接与审批锁定态 | replacement ✅**已核销** | 设置页六组和锁定态为本需求新形态。 | pr9 | `settings-page` / `settings-nav-*` / `settings-group-*` / `settings-group-placeholder` / `settings-lock-reason` / `settings-approval-full`；含深链接刷新、未落地组占位不崩、cap=auto 时 full 不可选且写明锁来源 | `steps/settings-shell.ts`，截图 `10-settings-shell.png` |
| `file-tree` | replacement ✅**已核销** | 属已删除的 `LeftRail`。**pr1 矩阵漏列本条，pr8 发现后补入**——它在 testid 基线里，无声消失会让 pr13 的只增不删核对失真。 | pr8 | `side-file-tree`（文件树迁至右侧改动面板标签页） | `steps/sessions-rail.ts` |
| `capability-center` | retired | 属已删除的 `LeftRail`，原为「Codex 能力」入口。V2 有独立设置页（pr9／pr10 六组），会话内不再内嵌第二套设置，否则出现两套真相。会话头的 `onOpenSettings` 已改为跳设置页。**pr1 矩阵漏列本条，pr8 发现后补入。** | pr8 | 无等价 testid；入口改为设置页 | `SessionRuntime.openSettingsPage` |
| Codex 状态投影可见性 | replacement ✅**已核销** | pr3 建了全局状态投影但当时只能证明「不报错」；本条证明它端到端到达界面。 | pr10 | `settings-status-bar` / `status-projection-note` / `status-item-model`；断言投影计数 >0 且模型栏显示「有配置告警」 | `steps/settings-codex.ts`，截图 `11-settings-model.png` |
| MCP 故障可见性 | replacement ✅**已核销** | MCP 是全仓唯一零实现能力，无旧断言可迁；本条确保故障不静默。 | pr12 | `mcp-panel` / `mcp-server-row[data-startup]` / `mcp-diagnose` / `mcp-failure-reason` / `status-item-mcp`；断言坏服务器不显示已连接、诊断区不留空且不编造原因 | `steps/mcp-settings.ts`，截图 `13-mcp-failure.png` |
| `open-vscode` / `open-settings` | retired | 属 pr13 删除的孤儿 `TopBar.tsx`（V2 用 `RequirementsTopBar`）。「用 VS Code 打开」在 V2 由 `Drawer` 的系统打开入口承担；「打开设置」由顶栏的设置模式承担，两者都不再需要独立 testid。**pr1 矩阵漏列，pr13 补入。** | pr13 | 无等价 testid；能力由既有入口承担 | `dev/UIKitPage.tsx` demo 已改为静态骨架 |
| `model-provider-notice` | retired | 属 pr10 删除的 `SettingsPanel.tsx`。模型配置的告警在 V2 由设置页状态条的「有配置告警」与组 3 的来源徽章承担，表达比原先单条 notice 更完整。**pr1 矩阵漏列，pr13 补入。** | pr13 | `status-item-model` / `model-origin-badge` | `steps/settings-codex.ts` |

## 反馈断言迁移约定（pr8）

| 步骤位置 | 迁移原因 | 语义定位 |
|---|---|---|
| `requirements-board.ts` 发布成功 | 「已发布产物版本」是可调整的中文呈现文案，不能作为 toast 出现的唯一证据。 | `[data-testid="global-message"][data-feedback-kind="success"][data-feedback-result="global"]` |
| `requirements-board.ts` 附件删除 409 | 该链路由统一分类器生成 `version_conflict`，旧中文文案已经失效；需精确区分于其他错误 toast。**UI/UX 重设计 P2 起退役**：删除不再携带版本、没有拒绝式守卫（ADR-0004），该 toast 不再出现。 | —— |
| `requirements-board.ts` 拖拽改状态失败 | P2 起失败分支是 PATCH 503：乐观更新回滚并提示「未能保存 · 重试」。 | `[data-testid="global-message"][data-feedback-result="global"]` 且含「未能保存」；落位以列内卡片为准 |

文案可作为业务规则的辅助断言，但不得作为反馈节点出现或故障分类的唯一定位依据。

## UI/UX 重设计 P1 / P2 迁移（2026-09-29）

P1 换了外壳（左侧栏 + 项目切换器 + ⌘K 命令面板、TanStack Router 路由、新登录页），P2 重做需求模块（看板 / 列表 / 速览 / 详情 / 开始会话对话框）。依据 ADR-0006，新设计为准，旧界面约束只作参考。会话页内部（P3）与设置 / 我的工作 / 概览内部（P4）的断言本轮不动，只修入口。

| 旧断言 / 定位 | 处置 | 新步骤与定位 |
|---|---|---|
| 登录页 `登录 SuDuo` / `登录名` / `密码` / 「登录」 | replacement | `v2-user-path`：未登录访问 `/` 先断言落到 `/login`，登录后回到 `/my` |
| `aria-label=当前远程项目` 下拉框 | retired | `project-switcher` → 选项「Gate C 远程项目」；选中后记入 `suduo.v2.remoteProjectId` |
| 「项目操作」菜单 →「新建会话」 | retired | ⌘K（`ControlOrMeta+K`）命令面板 →「在本机开始项目会话」 |
| `dialog[配置当前项目工作目录]` / `本机绝对目录` / 「保存并继续」 | replacement | `start-session-dialog` 目录步：「手动输入路径」→ 等「可以读写」→「使用这个目录」（`helpers.completeStartSessionDialog`） |
| 会话路由 `/sessions?projectId=&sessionId=` | replacement | `/sessions/<id>`；`localProjectId` 取自 `GET /api/v1/sessions/:id` 并与 `/api/v2/project-mappings` 交叉核对；旧深链接的重定向由 `overview-workbench` 断言 |
| `/requirements`、`/requirements/<uuid>`、`/overview`、`/?sessionId=` | replacement | `overview-workbench` 断言分别落到 `/p/<项目>/requirements`、`/p/<项目>/requirements/<编号>`、`/p/<项目>/overview`、`/sessions/<id>` |
| 各步骤 `pushState("/requirements")` 回需求页 | replacement | 主导航链接「需求」（`helpers.openSection`） |
| `board-column-*` / `board-card` / `board-count-*` / `board-load-more-*` | replacement | `[data-status-column="<状态>"]` / `[data-testid="requirement-card"][data-requirement-id]`；七列各自请求改为同时统计列表请求的 `status` 参数 |
| 七列在 1440 宽度不得横向滚动 | retired（ADR-0006；技术设计 §7） | 列宽一致且在 240–340px；看板在内容面板内自行横向滚动，最右一列可滚进可视区 |
| HTML5 `DragEvent` 拖放 | replacement | dnd-kit 指针拖拽：`page.mouse` 按下 → 越过 5px → 移到目标列放置区 → 等读屏播报「移到「列名」上方」→ 松开 |
| 409 冲突后落真实列 | replacement | PATCH 503 + 同事已改到 in_testing：回滚并重新拉取后只出现在 in_testing |
| （新增）键盘改状态、速览、URL 筛选 | 新增 | 聚焦卡片按 1–7；点卡片开 `requirement-peek`、URL 带 `peek`、Esc 关闭且速览在内容面板内；按编号搜索、负责人「我负责的」 |
| `detail-back` | retired | 详情页用面包屑；步骤直接按 URL 进出 |
| 「实时已连接」文案 | retired | 整页加载前等待 `/api/v2/events` 响应，确保主窗口 SSE 已建立 |
| 发布对话框「发布产物版本」/「变更说明（可选）」/「发布版本」 | retired | 确认版停用（需求附件评论文件与优先级 S2）：附件区不再有发布入口，断言「没有发布确认版按钮」 |
| `artifact-version-item` / `artifact-published-comment` /「查看产物版本」 | replacement | `historical-versions` 里「历史确认版（1）」展开后「第 1 版」只读 + 活动「发布了确认版 · 第 1 版」；跨窗口实时改用评论（`comment.created`） |
| `comment-item` | replacement | `activity-comment` |
| 详情 `v1` / `v2` 版本号文案 | retired（文案规范禁止版本号） | 带外改描述后删除附件，删除后回查到新描述 |
| 附件 `article` +「删除」+ `dialog[删除附件]` | replacement | 行内 `aria-label=删除「文件名」` → `confirm-dialog`「删除「文件名」？」→「删除」 |
| 详情「在本机开始对话」 | replacement | 详情 / 速览「开始会话」→ `start-session-dialog`（已有会话时「新开一个会话」） |
| 视觉基线需求页 `/requirements`、会话页 `?projectId=&sessionId=` | replacement | `/p/<项目>/requirements?view=board`、`/sessions/<id>` |
