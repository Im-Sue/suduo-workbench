---
doc_type: architecture
updated: 2026-09-29
architecture_scope: client-web
scope_source_roots: ["client/web"]
human_verified: false
---

# client/web 架构

> 一句话定位：SuDuo 的前端单页应用。左侧栏 + 内容区的外壳下，按功能划分「我的工作 / 需求 / 会话 / 概览 / 设置」五个区域；服务端数据走 TanStack Query，需求实时变化经一条 SSE 精确失效，Codex 会话经事件投影渲染成按回合的时间线。｜最后更新：2026-09-29
>
> 本文按 UI/UX 产品化重设计（P0–P5）完成后的代码重写，取代 2026-08 版（旧版描述的是顶栏 + 三栏工作台）。设计决策与取舍见 `docs/03_开发计划/v2-UIUX产品化重设计-技术设计.md`。

---

## 一、概述与定位

- **做什么**：团队成员在这里看需求、推进状态、从需求开 Codex 会话、确认 Codex 的改动、看项目流转；本机设置（模型服务、代理、MCP、代码目录）也在这里。
- **不做什么**：不直接连需求服务或 Codex——一切经本机服务（`client/server`，仅 loopback）转发；不保存业务数据（浏览器里只有 UI 偏好与草稿）。
- **运行形态**：Vite 构建的静态资源，由本机服务同源托管。

## 二、整体结构

```
浏览器
 └─ AppRoot（QueryClient、Router、Tooltip、消息出口、错误兜底）
     └─ 根路由：读需求服务设置 → 未配置去 /setup，未登录去 /login?redirect=
         └─ AppShell（侧栏 + 内容区 + 连接横幅 + 命令面板 + 快捷键一览 + 需求实时连接）
             ├─ /my                      我的工作
             ├─ /p/$projectId/requirements[/$number]   需求看板 / 列表 / 速览 / 详情
             ├─ /p/$projectId/rooms[/$roomId]   讨论（项目默认房间 + 需求房间；?thread=&run= 打开话题与运行详情）
             ├─ /p/$projectId/overview   概览
             ├─ /sessions[/$sessionId]   会话（跨项目列表 + 会话运行时）
             └─ /settings/$section       设置（12 个分组）
```

数据来源只有两条：

| 通道 | 用途 | 实现 |
|---|---|---|
| HTTP（`/api/v1`、`/api/v2`） | 读写一切资源 | `api/client.ts` 一个请求层；按功能在 `features/*/queries.ts` 封装查询键与 mutation |
| SSE | 需求实时变化与房间事件（同一条 `/api/v2/events`）、会话事件流、Codex 全局状态 | 需求：`features/requirements/realtime.tsx`（外壳级一条，默认 message 事件）；房间：同一个 EventSource 上的命名事件 `room` / `room-resync`，`features/rooms/realtime.ts` 写缓存；会话：会话运行时自己的通道；Codex 状态：`features/settings/codex-status.ts` |

## 三、技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 框架 | React 19 + TypeScript + Vite | |
| 路由 | TanStack Router（代码式路由表 `app/router.tsx`） | URL 是项目上下文与筛选条件的唯一真相；旧路径全部重定向 |
| 服务端数据 | TanStack Query v5 | 查询键按前缀组织，实时事件与 mutation 精确失效；乐观更新失败回滚 |
| 样式 | Tailwind CSS v4（不含 preflight）+ 设计令牌 `design/tokens.css` | 亮 / 暗 / 密度三组令牌；页面样式一律工具类 |
| 组件 | Radix 原语 + 自有组件源码（`components/ui`，shadcn 方式） | 命令面板 cmdk、消息 sonner、图标 lucide |
| 布局 | react-resizable-panels（会话三栏）、@tanstack/react-virtual（长消息流） | |
| 其他 | dnd-kit（看板拖拽）、recharts（概览趋势，按需加载）、monaco-editor（文件查看，按需加载）、react-markdown + rehype-highlight | |

## 四、项目结构

```
client/web/src
├─ app/                 应用骨架
│  ├─ AppRoot.tsx       Provider 装配、错误兜底
│  ├─ router.tsx        路由表、根路由拦截、旧路径重定向
│  ├─ shell/            侧栏、项目切换、命令面板、快捷键一览、连接横幅、会话启动器、项目对话框
│  ├─ pages/            首启向导、登录、启动屏；首启跳过项（setup-pending）
│  ├─ SessionRuntime.tsx 会话运行时（消息流 + 输入框 + 检查面板），会话页内嵌
│  ├─ shortcuts.ts      快捷键清单（「?」一览的唯一来源）
│  ├─ mapping-cache.ts  「项目 ↔ 本机代码目录」变更后的统一失效出口
│  └─ queries.ts        QueryClient 默认策略、全局查询（设置、项目）
├─ features/            按功能区划分；每个区自带页面、组件、查询键与纯逻辑
│  ├─ my-work/          我的工作（需要你处理 / 我的需求 / 会话 / 最近动态）
│  ├─ requirements/     看板、列表、速览、详情、材料、活动、开始会话；需求实时连接
│  ├─ sessions/         会话列表、会话头、审批坞、消息流（stream/）、模型切换、完成提醒
│  ├─ overview/         概览（状态分布 / 流转趋势 / 停滞需求 / 最近动态）
│  ├─ rooms/            讨论：房间列表、消息流、输入框（@ 与文件）、话题面板、Agent 任务状态与运行详情、共享 Agent 面板；需求详情「讨论」区块
│  └─ settings/         设置分组、保存条、测试连接、诊断
├─ event-projection/    Codex 事件 → 按回合的时间线（纯函数，单测覆盖）
├─ session/             会话运行态、排队等会话域状态
├─ components/          会话运行时沿用的业务组件（输入框、检查面板、抽屉、Monaco 等）
│  └─ ui/               基础组件（按钮、对话框、分段选择、状态图标…）
├─ feedback/            失败分类、反馈出口（行内 / 区域 / 页面 / 消息）、确认策略
├─ design/tokens.css    设计令牌
├─ ui/                  跨功能的小工具（格式化、主题、密度、Markdown、diff、偏好记忆）
├─ dev/                 /__design 设计系统页（开发用）
└─ styles.css           全局入口：Tailwind 导入、基础 reset、Markdown 与代码高亮
```

约定：新代码放 `features/<区>/`；`components/` 下只剩会话运行时仍在用的组件，不再往里加。

## 五、核心模块

| 模块 | 职责 | 关键点 |
|---|---|---|
| `app/router.tsx` | 路由与拦截 | 根路由统一判断「未配置 / 未登录」；项目分区 `/p/$projectId` 校验项目存在；`/settings#组` 等旧地址重定向 |
| `features/requirements/realtime.tsx` | 需求实时同步 | 外壳级只开一条 SSE；事件只带资源标识，按类型精确失效查询（`invalidateForEvent`）；重连成功后全量失效补齐断线期间的变化；他人改动高亮约 2 秒 |
| `features/requirements/queries.ts` | 需求数据层 | 编号 → id 解析、看板列 / 列表、乐观改状态（逐项回滚）、卡片计数原地刷新 |
| `event-projection/` | 会话事件投影 | 文字按 itemId 分段并与步骤组按时间交错；计划、改动卡、审批步骤、回合内错误卡、回合摘要 |
| `features/rooms/` | 讨论（项目聊天房间与共享 Agent） | 房间事件带内容，直接写缓存（`cache.ts` 唯一出口，保留本地「我的视角」）；发消息先放本地占位、按 clientId 与回执 / 推送对齐；断线或 `room-resync` 后按房间序号 `after` 补拉；运行详情复用会话时间线投影（`projectEvents` + `ConversationStream`）；未读由前端按序号算 |
| `features/sessions/` | 会话页 | 跨项目列表（10 秒轮询 + 与侧栏共用缓存）、审批坞（固定在输入框上方）、完成提醒（标题前缀、侧栏计数、可选系统通知） |
| `features/settings/` | 设置 | 分组即路由；开关即时保存（失败回滚）；多字段表单用保存条（⌘S，离开前提醒）；测试连接统一组件；导航提示点与诊断共用各分组的查询 |
| `feedback/` | 反馈契约 | `classifyFailure` 把错误归类成用户能读懂的说法；按出口（行内 / 区域 / 页面 / 消息）上报 |

## 六、关键流程 / 数据流

**需求被别人改了**：需求服务 → 本机服务 SSE → `invalidateForEvent` → 对应查询重取 → 看板卡片就地更新并高亮；概览的统计与动态、「我的工作」的指派列表挂在项目查询键下，一并刷新。不弹窗、不拦截编辑（ADR-0004）。

**从需求开始会话**：看板 / 速览 / 详情的「开始会话」→ 会话启动器检查本机代码目录（没有就先选）→ 本机服务建会话 → 跳到 `/sessions/$id`；同一需求已有会话在后台时提示「仍要新开」。

**会话运行**：会话事件流 → `event-projection` 投影成回合时间线 → 消息流虚拟列表渲染；等你确认时审批坞出现在输入框上方；焦点在确认卡上、或没停在任何控件上时，⏎ / Esc 即同意 / 拒绝（在输入框里打字不会误触）。发评论、发布确认版的确认卡（SuDuo 工具，ADR-0008）逐字展示内容，⏎ 不代发、必须点按钮，Esc 仍是「不发」。回答里的项目文件链接点开在右侧文件面板定位到行。

**设置保存**：开关类先改界面、失败回滚；表单类点保存（或 ⌘S）→ 服务端验证 → 成功写回缓存。保存网络代理会让 Codex 重连，保存前说明会中断几个正在运行的会话，由用户决定。

## 七、布局与导航

- **外壳**：左侧栏（展开 240 / 收起 56，⌘\）自上而下：项目切换 → 搜索（⌘K）→ 我的工作 / 需求 / 会话 / 概览 → 设置、账号。我的工作旁显示待处理数，会话旁显示需要你处理的会话数。
- **页面**：内容区只放页面本身；页面根不用 `<main>`（外壳已有），标题用 `h1`。
- **弹层层级**：浮层高于对话框；有对话框、菜单开着时页面单键快捷键让位。
- **断点**：会话页 < 1280 时检查面板改为浮层；需求速览 ≥ 1440 并排，更窄时浮在看板上。
- **快捷键**：清单在 `app/shortcuts.ts`，「?」打开一览；新增或改动快捷键两处一起改（`test/shortcuts.test.tsx` 核对）。

## 八、样式体系约束

1. **令牌优先**：颜色、字号、间距、圆角、阴影、动效时长一律用 `design/tokens.css` 的令牌（Tailwind 里对应 `bg-card`、`text-subtle-foreground`、`duration-(--dur-fast)` 等）；不写死色值。
2. **对比度**：文字色在各层表面、语义色在自己的柔和底色上都 ≥ 4.5:1；`test/tokens-contrast.test.ts` 核令牌层，gate-c 的 `a11y-audit` 核真实页面。
3. **控件 reset 在 `@layer base` 里**：无 layer 的规则会压过所有工具类。
4. **动效**：进出场默认取 `--dur-*` / `--ease-*`；减少动效时令牌为 0，且全局关闭循环动画。
5. **局部主题**：`data-theme-scope` 可让一块区域按另一套令牌渲染（主题预览）；这类区域里不要用 `dark:` 变体（它只认根节点）。
6. **styles.css 只放全局的东西**：基础 reset、Markdown 渲染、代码高亮（`hljs-*` 由 rehype-highlight 运行时生成，源码里搜不到，勿删）。

## 九、测试与质量门

| 层 | 做法 |
|---|---|
| 单元 / 组件 | vitest + jsdom；页面级测试挂 `AppRoot` 走真实路由，桩掉 `fetch` / `api` |
| 端到端 | gate-c（`client/server/test/gate-c`）：需求链路、会话链路、设置、概览与我的工作、视觉基线（关键页 × 亮暗 × 1440/1280）、无障碍（axe，零 serious / critical） |
| testid | `pnpm testid:check` 维护基线；定位优先角色与可访问名，testid 只给无语义元素 |

## 十、部署 / 运行

- 构建：`pnpm --filter @suduo/web build` 输出 `client/web/dist`，由本机服务托管（CSP `default-src 'self'`，字体输出为同源文件）。
- 本机联调：`sh cloud/scripts/dev-postgres.sh start` 后 `sh client/scripts/dev-local.sh start`（需求服务 + 本机服务，数据长期放在 `SUDUO_DEV_DATA`；给 Codex 的配置在其中的 `codex-home/config.toml`）。
- 开发：日常联调用构建产物配本机服务（改完 `pnpm --filter @suduo/web build`，刷新即可）；在 `client/web` 下跑 `npx vite` 进入开发模式时，`/__design` 可看全部基础组件的亮暗效果（vite 没配 `/api` 代理，这个模式只适合看组件）。

## 十一、边界 / 不做项

- 不在浏览器里保存业务数据；localStorage 只放 UI 偏好（主题、密度、侧栏、上次的项目 / 设置分组、概览范围等）与首启跳过项，读取时一律校验。
- 不做拒绝式守卫（锁、版本校验、409）来「保护」并发编辑：检测保留，响应是告知 + 给选项（ADR-0004）。未保存的输入离开前提醒属于「不可逆字节损失」红线。

## 十二、相关文档

- 需求：`docs/02_需求设计/v2-UIUX产品化重设计-需求.md`
- 技术设计：`docs/03_开发计划/v2-UIUX产品化重设计-技术设计.md`
- 系统架构：`docs/01_架构设计/v2-系统架构.md`
- 本机服务：`docs/01_架构设计/client-server-架构.md`

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-08-17 | 初版（su-init 自动生成，描述顶栏 + 三栏工作台） |
| 2026-09-29 | 按 UI/UX 产品化重设计 P0–P5 完成后的代码重写：侧栏外壳、TanStack Router / Query、功能区目录、需求实时精确失效、会话回合时间线、设置分组路由、令牌与对比度约束、无障碍与视觉基线 |
