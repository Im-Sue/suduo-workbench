---
id: suduo-v2-uiux-productization-001-design
title: SuDuo V2 UI/UX 产品化重设计 技术设计
doc_type: technical_design
requirement_id: suduo-v2-uiux-productization-001
updated: 2026-09-29
---

# SuDuo V2 UI/UX 产品化重设计 技术设计

> 一句话：保留 React + Tailwind + Radix 的底座，补齐路由、数据层、面板布局和命令面板，建一套语义令牌驱动的亮暗双主题设计系统，再按「基座 → 外壳 → 需求 → 会话 → 其余页面 → 打磨」六个阶段替换全部界面。｜最后更新：2026-09-29
>
> 需求：[`v2-UIUX产品化重设计-需求.md`](../02_需求设计/v2-UIUX产品化重设计-需求.md) ｜ 决策：ADR-0006 ｜ 视觉原型：[SuDuo 界面重设计画布](https://claude.ai/artifact/JWsNwifyiN56kgNAonTr4W)

---

## 一、设计方向

**精密工作台（Precision Workbench）**：冷调中性灰作底，一个钴蓝强调色；信息密集但有呼吸；形状与颜色双重编码状态；键盘优先。它是每天开八小时的工具，不是营销页：克制、稳定、可预期，惊喜只留给少数高价值时刻（会话完成的回合摘要、拖拽落位、首启完成）。

| 取向 | 选择 | 不选 |
|---|---|---|
| 气质 | 精确、安静、专业 | 花哨渐变、玻璃拟态、大圆角卡片堆叠 |
| 密度 | 中高密度，正文 14px、控件 32px | 12px 正文 + 整页缩放 |
| 色彩 | 中性灰 90% + 单一强调色 + 语义色 | 多强调色、状态色当装饰 |
| 层级 | 用表面明度与细边框分层，阴影只给浮层 | 处处投影 |
| 动效 | 120–240ms，只服务于"东西从哪来、到哪去" | 装饰性动画 |

---

## 二、技术栈

### 2.1 结论

| 层 | 选择 | 状态 | 理由 |
|---|---|---|---|
| 框架 | React 19 + TypeScript + Vite | 保留 | 现状稳定，无迁移收益 |
| 样式 | Tailwind CSS v4（`@theme` 语义令牌） | 保留，重建令牌 | 原子类 + 设计令牌是目前维护成本最低的组合 |
| 组件底座 | Radix Primitives，以 shadcn/ui 方式把源码放进仓库 | 保留，补全 | 行为与无障碍由 Radix 负责，外观完全自有 |
| 路由 | **TanStack Router** | 新增 | 类型安全的路径与查询参数（筛选状态写进 URL）、嵌套布局、按路由懒加载；替换手写路由 |
| 服务端状态 | **TanStack Query** | 新增 | 统一加载 / 错误 / 缓存 / 乐观更新；SSE 事件转为精确失效；消灭各页自写的 loading 状态 |
| 表格 | TanStack Table | 新增 | 需求列表视图：排序、分组、多选 |
| 虚拟列表 | TanStack Virtual | 新增 | 长会话消息流、长列表 |
| 拖拽 | dnd-kit | 新增 | 看板拖拽，自带键盘传感器与读屏播报 |
| 命令面板 | cmdk | 新增 | ⌘K 搜索与动作，也用作 Combobox 内核 |
| 面板布局 | react-resizable-panels | 新增 | 三栏可拖拽、尺寸记忆、可折叠 |
| 提示 | sonner | 替换 react-hot-toast | 堆叠、动作按钮、Promise 态，和 shadcn 生态一致 |
| 表单 | react-hook-form + zod | 新增 | 字段级校验；zod schema 可与 contracts 对齐 |
| 图标 | lucide-react | 保留，删自写 icons.tsx | 一套图标 |
| 图表 | Recharts | 新增（概览按需懒加载） | 覆盖柱图、折线图即可 |
| 日期 | date-fns + zh-CN | 新增 | 相对时间、分组（今天 / 昨天） |
| Markdown | react-markdown + remark-gfm + rehype-highlight | 保留 | 需求描述与评论统一使用 |
| 代码 / diff | Monaco（懒加载） | 保留 | 文件查看与 diff |
| 字体 | @fontsource：IBM Plex Sans、JetBrains Mono | 新增 | 随安装包分发，内网离线可用；中文走系统字体 |

### 2.2 为什么不用成套组件库

| 候选 | 不选的原因 |
|---|---|
| Ant Design / Arco / Semi / TDesign | 视觉同质化，做成"又一个后台"；深度主题需要对抗其默认样式；CSS-in-JS 或自有 less 体系与 Tailwind 双轨；体积大 |
| MUI | Material 视觉语言与目标气质不符；定制成本同上 |
| Mantine / Chakra | 可行，但与现有 Radix + Tailwind 资产不兼容，迁移成本无对应收益 |

shadcn 方式的优势是**组件源码归我们所有**：外观、交互细节、无障碍都能按本设计精确落地，没有"库的默认样子"。

### 2.3 删除

手写路由（`RequirementsV2App.tsx:431-483`）、`icons.tsx`、全局 `.btn` / `.modal-backdrop` / 手写弹层、`[data-zoom]` CSS zoom、react-hot-toast、`/__ui-kit` 旧页、`styles.css` 中的死样式（msg-host、project-tab、approve-alert、settings-overlay、ui-kit-wave2/3/4）。

---

## 三、设计令牌

令牌分三层：**原始值**（只在 `tokens.css` 出现）→ **语义令牌**（组件唯一允许引用的层）→ **Tailwind 映射**（`@theme inline`）。组件里不写色值，不写 `dark:` 变体，亮暗切换只换语义令牌的值。

### 3.1 颜色

> **实现命名（P0 定稿）**：CSS 变量与 shadcn 约定对齐，便于直接复用 shadcn 组件源码。下表"语义令牌"列为设计名，对应的 CSS 变量为：
> `--bg`→`--background`、`--surface`→`--card`、`--surface-2`→`--muted`（`--accent`/`--secondary` 为其别名）、`--surface-3`→`--muted-strong`、`--overlay`→`--popover`（浮层内悬停用 `--popover-hover`）、
> `--fg`→`--foreground`、`--fg-muted`→`--muted-foreground`、`--fg-subtle`→`--subtle-foreground`、`--fg-disabled`→`--disabled-foreground`、
> `--accent`（品牌）→`--primary`、`--accent-hover`→`--primary-hover`、`--accent-soft`→`--primary-soft`、`--accent-fg`→`--primary-text`、`--on-accent`→`--primary-foreground`、`--danger-solid`→`--destructive`。
> 真相源：`client/web/src/design/tokens.css`；旧变量经 `styles.css` 的「存量变量桥」映射到新令牌，随页面重做删除。

| 语义令牌 | 用途 | 亮色 | 暗色 |
|---|---|---|---|
| `--bg` | 应用底色 | `#F5F6F8` | `#0D0F13` |
| `--surface` | 面板、卡片、输入框 | `#FFFFFF` | `#14171C` |
| `--surface-2` | 悬停、次级填充 | `#F0F1F4` | `#1A1E24` |
| `--surface-3` | 选中、按下 | `#E6E8ED` | `#232830` |
| `--overlay` | 菜单、弹窗 | `#FFFFFF` | `#1A1E24` |
| `--border` | 常规分隔 | `#E2E4E9` | `#242931` |
| `--border-strong` | 输入框、次按钮描边 | `#CBCFD7` | `#343A45` |
| `--fg` | 主要文字 | `#15171C` | `#E7E9ED` |
| `--fg-muted` | 次要文字 | `#4F5562` | `#A9B0BC` |
| `--fg-subtle` | 元信息、占位 | `#6A707C` | `#8A919E` |
| `--fg-disabled` | 禁用 | `#A2A7B1` | `#5A606B` |
| `--accent` | 主按钮、选中 | `#3451D1` | `#4C66E6` |
| `--accent-hover` | 主按钮悬停 | `#2A43B5` | `#435DDB` |
| `--accent-soft` | 强调浅底、焦点光晕 | `#ECEFFC` | `rgba(106,131,244,.16)` |
| `--accent-fg` | 链接、强调文字 | `#2A40A6` | `#9DB0FF` |
| `--success` / `-soft` | 成功 | `#1D7F48` / `#E6F4EC` | `#48C27F` / `rgba(72,194,127,.14)` |
| `--warning` / `-soft` | 警告、等待 | `#A65F00` / `#FBF0DD` | `#E6A23C` / `rgba(230,162,60,.14)` |
| `--danger` / `-soft` | 危险文字与图标 | `#C23636` / `#FBE9E9` | `#F07171` / `rgba(240,113,113,.14)` |
| `--danger-solid` | 危险按钮底（白字） | `#C23636` | `#C93C3C` |

对比度要求：`--fg` / `--fg-muted` / `--fg-subtle` 在 `--surface` 与 `--bg` 上均 ≥ 4.5:1；主按钮与危险按钮白字 ≥ 4.5:1。以上取值已按此校核；新增令牌必须过同样的校核。

### 3.2 需求状态

状态**同时**用形状与颜色编码，色弱与灰度打印下依然可分：

| 状态 | 图标形状 | 亮色 | 暗色 |
|---|---|---|---|
| 草稿 | 虚线圆环 | `#8A909B` | `#8A919E` |
| 梳理中 | 圆环 + 中心点 | `#7B4FD6` | `#A98BF5` |
| 待开发 | 实线圆环 | `#4F5562` | `#C3C8D1` |
| 开发中 | 圆环 + 半饼 | `#C27A0A` | `#E6A23C` |
| 测试中 | 圆环 + 3/4 饼 | `#0F8A8A` | `#3CC6C6` |
| 已完成 | 实心圆 + 对勾 | `#1D7F48` | `#48C27F` |
| 暂缓 | 圆环 + 暂停双竖线 | `#8C7560` | `#B39C86` |

会话状态：运行中（强调色实心点 + 呼吸动画）、等你确认（警告色实心点）、失败（危险色叉）、已完成（成功色对勾）、空闲（空心圆）、已停止（方块）。

### 3.3 字体

| 令牌 | 值 |
|---|---|
| `--font-sans` | `"IBM Plex Sans", "PingFang SC", "Microsoft YaHei UI", "Noto Sans SC", system-ui, sans-serif` |
| `--font-mono` | `"JetBrains Mono", "SF Mono", Consolas, monospace` |

| 级别 | 字号 / 行高 / 字重 | 用途 |
|---|---|---|
| title | 20 / 28 / 600 | 页面标题、详情标题 |
| heading | 16 / 24 / 600 | 区块标题、对话框标题 |
| body | 14 / 22 / 400 | 正文、描述、消息 |
| body-strong | 14 / 22 / 500 | 列表主文字、卡片标题 |
| small | 13 / 20 / 400–500 | 控件文字、次要信息 |
| caption | 12 / 18 / 400 | 时间、计数、元信息（最小字号） |
| code | 13 / 20 / 400 mono | 代码、命令、路径 |

令牌命名用 `--text-title` 等语义名，并注册进 `@theme`，不与 Tailwind 默认的 `--text-sm` 同名。

### 3.4 间距、圆角、阴影、动效、层级

| 类别 | 值 |
|---|---|
| 间距（4px 基准） | 2 / 4 / 6 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64 |
| 圆角 | xs 4（徽标、键帽）/ sm 6（按钮、输入）/ md 8（卡片、菜单）/ lg 12（对话框、面板）/ full |
| 阴影（亮） | sh-1 `0 1px 2px rgb(20 23 28/.06), 0 0 0 1px rgb(20 23 28/.04)`；sh-2 `0 8px 24px rgb(20 23 28/.10), 0 0 0 1px rgb(20 23 28/.06)`；sh-3 `0 24px 48px rgb(20 23 28/.16)` |
| 阴影（暗） | 靠 `--overlay` 提亮与 1px 边框分层；浮层加 `0 12px 32px rgb(0 0 0/.5)` |
| 动效时长 | fast 120ms（悬停、按下）/ base 180ms（菜单、提示）/ slow 240ms（面板、抽屉） |
| 缓动 | 进入 `cubic-bezier(.2,0,0,1)`；退出 `cubic-bezier(.4,0,1,1)`；`prefers-reduced-motion` 下只保留透明度 |
| 层级 | sticky 10 / 侧栏 20 / 抽屉 50 / 对话框 60 / 下拉、选择与浮层 70（必须高于对话框，才能在对话框里使用）/ 气泡提示 90；全局提示由 sonner 置顶 |
| 焦点 | `0 0 0 2px var(--surface), 0 0 0 4px var(--focus-ring)`（亮 `#7A90EE`，暗 `#7C93F5`） |

### 3.5 密度

| 令牌 | 舒适（默认） | 紧凑 |
|---|---|---|
| `--control-h` | 32px | 28px |
| `--row-h` | 36px | 32px |
| `--pad-x` | 12px | 10px |

密度通过根元素 `data-density` 切换，替代 CSS zoom。

### 3.6 主题实现

- 根元素 `data-theme="light|dark"` + `data-density`；`ui/theme.ts` 读取偏好（`system` 默认），解析后写入并监听 `prefers-color-scheme`。
- `index.html` 同步加载同源脚本 `/assets/theme-init.js`（服务端 CSP 为 `script-src 'self'`，不能内联），在样式生效前写入主题与密度，避免闪白 / 闪黑。
- 字体随构建输出为同源文件（`assetsInlineLimit` 排除字体），因 CSP 未放行 `data:` 字体。
- Tailwind v4：`@custom-variant dark (&:where(.dark, .dark *))`，只在极少数原始值场景使用；组件一律用语义令牌。
- Monaco、代码高亮、图表各自接入同一套令牌（主题切换时同步切换 Monaco 主题）。

---

## 四、布局框架

### 4.1 外壳

```
┌──────────┬───────────────────────────────────────────────┐
│ Sidebar  │ [ConnectionBanner]（断线时出现）              │
│ 240/56   ├───────────────────────────────────────────────┤
│ 项目切换 │ PageHeader 52px：面包屑 · 标题 · 视图 · 操作 │
│ 搜索 ⌘K  ├───────────────────────────────────────────────┤
│ 我的工作 │ PageToolbar 44px（可选）：搜索 · 筛选 · 排序  │
│ 需求     ├───────────────────────────────────────────────┤
│ 会话  ②  │ PageBody（独立滚动）                          │
│ 概览     │   单栏 / SplitView（可拖拽多栏）              │
│ ──────── │                                               │
│ 设置     │                                               │
│ 账号     │                                               │
└──────────┴───────────────────────────────────────────────┘
```

- `AppShell`：`display:grid; grid-template-columns: var(--sidebar-w) minmax(0,1fr); height:100dvh`。侧栏固定，内容区每页自管滚动。
- 没有全局顶栏。项目切换器在侧栏顶部，所有项目级路由的 URL 带 `projectId`，URL 是项目上下文的唯一真相，localStorage 只记"上次项目"用于重定向。

### 4.2 页面模板

| 模板 | 结构 | 用于 |
|---|---|---|
| `Page` | Header + Body | 我的工作、概览 |
| `Page + Toolbar` | Header + 筛选栏 + Body | 需求看板 / 列表 |
| `Page + Peek` | 主体 + 右侧速览面板（480px，可关闭，不改路由层级，`?peek=` 记录） | 需求看板 / 列表 |
| `DetailPage` | Header + 两栏（主栏自适应，内容最宽 760；属性栏 320） | 需求详情 |
| `SplitView` | 三栏可拖拽：列表 ｜ 主区 ｜ 检查面板 | 会话 |
| `SettingsLayout` | 分组导航 220 ｜ 内容（最宽 720） | 设置 |
| `FocusLayout` | 居中卡片，无侧栏 | 首启、登录 |

### 4.3 断点与让位

| 宽度 | 侧栏 | 会话三栏 | 速览面板 |
|---|---|---|---|
| ≥ 1600 | 展开 | 列表 280 ｜ 对话 ｜ 检查 400 | 并排 |
| 1280–1599 | 展开；**进入会话页时自动收起为 56** | 列表 280 ｜ 对话 ｜ 检查 400 | 并排 |
| 1024–1279 | 自动收起为 56 | 检查面板改为浮层 | 浮层 |
| < 1024 | 抽屉 | 单栏 + 浮层 | 浮层 |

首次加载即按当前宽度决定（修复现状"只在跨越断点时折叠"）；用户手动调整后记忆，不再自动覆盖。

---

## 五、组件清单

### 5.1 基础组件（`components/ui`，P0）

Button、IconButton、Input、Textarea、Field（标签 + 说明 + 错误）、Select、Combobox、Checkbox、Switch、RadioGroup、SegmentedControl、Tabs、Tooltip、Popover、DropdownMenu、ContextMenu、Dialog、AlertDialog、Sheet、Command、ScrollArea、Separator、Avatar / AvatarGroup、Badge、Kbd、Skeleton、Spinner、Progress、Toaster、Banner、Collapsible、Resizable、Table。

**Button 规格**：

| 维度 | 规格 |
|---|---|
| 变体 | primary（每处最多一个）/ secondary / ghost / danger / link |
| 尺寸 | sm 28 / md 32（默认）/ lg 36；IconButton 正方形同高，必须带 `aria-label` 与 Tooltip |
| 状态 | 默认、悬停、按下（下沉 1px 不做，改为 `--surface-3`）、焦点（焦点环）、禁用、加载 |
| 加载 | 前置图标位换成 Spinner，文字可换为进行时（"保存中…"），宽度锁定不跳动，`aria-busy`，重复点击无效 |
| 禁用原因 | `disabledReason` 属性：禁用时悬停显示原因（例："项目已归档，不能新建需求"） |

### 5.2 模式组件（`components/patterns`，P0）

| 组件 | 规格 |
|---|---|
| EmptyState | 三种尺寸：inline（一行淡色字）/ section（图标 + 一句话 + 可选按钮）/ page（插画位 + 标题 + 说明 + 主按钮） |
| ErrorState | section / page；一句人话原因 + "重试" + 可展开"技术详情"（含可复制的错误码） |
| LoadingState | 骨架屏按真实布局画，不用通用转圈占满区域 |
| ConfirmDialog | 危险确认：标题说后果，按钮文案用动词（"删除附件"），默认焦点"取消" |
| SaveBar | 底部固定"有未保存的更改 ［放弃］［保存］"；离开页面时拦截提醒 |
| ConnectionBanner | 断线、重连中、已恢复（2 秒后自动消失） |
| PageHeader / FilterBar / ViewSwitcher | 页面骨架 |
| RelativeTime | "3 分钟前"，悬停显示完整时间 |
| DropZone / UploadRow | 拖入高亮；每文件进度、取消、失败单独重试 |
| DirectoryPicker | 本机目录浏览（面包屑 + 列表 + 最近使用 + 手动输入），即时校验可读写 |

### 5.3 业务组件

需求：StatusIcon、StatusMenu、RequirementCard、RequirementRow、RequirementPeek、ActivityTimeline、MaterialsList、ArtifactVersions、PublishDialog、StartSessionDialog。
会话：SessionListItem、SessionHeader、MessageBubble、AssistantTurn、StepGroup、StepRow、CommandBlock、PlanChecklist、FileChangeCard、TurnSummary、ApprovalDock、Composer（含 Chip、QueueList、ContextRing）、Inspector（Changes / Requirement / Env / Files）、DiffView。
全局：ProjectSwitcher、CommandPalette、SetupChecklist、ThemeSwitcher。

---

## 六、交互模式

### 6.1 加载与等待（沿用反馈契约阈值，统一实现在 Query 层）

| 场景 | 规则 |
|---|---|
| 按钮提交 | 0ms 进入加载态 |
| 首次加载 | 0ms 显示按布局绘制的骨架；空态只在数据返回为空后出现 |
| 后台刷新 | 保留旧数据，不转圈、不禁用；超过 1s 仅在页面头刷新图标处显示细微指示 |
| 长操作 | 超过 1s 显示"仍在处理…"；超过 10s 显示进度或步骤，并给出取消 |
| 阻塞遮罩 | 只用于真正阻塞的流程（如开始会话的准备阶段），且必须展示分步进度 |

### 6.2 反馈出口

| 结果 | 出口 |
|---|---|
| 字段校验失败 | 字段下方红字 + `aria-invalid`，提交按钮不禁用（点了定位到第一个错误） |
| 区域读取失败 | 该区域 ErrorState，其他区域照常 |
| 页面读取失败 | 占据内容区的 page ErrorState（不叠在旧内容上） |
| 后台动作结果 | toast（成功 4s；失败 8s 且带"重试"）|
| 结果在原地可见 | 不弹 toast，原地状态变化即反馈（例：状态改了卡片就换列） |
| 会话回合失败 | 对话流内错误卡片，不进 toast |

### 6.3 乐观更新与撤销

改状态（拖拽 / 菜单）、发评论、重命名、开关类设置：先更新界面，失败回滚并 toast"未能保存 · 重试"。可逆操作（归档会话、移除队列项）不弹确认，改为 toast 带"撤销"（5s）。不可逆操作（删除附件、删除会话、解除目录、退出登录、切到完全访问）用 ConfirmDialog。

### 6.4 实时

SSE 事件 → 精确失效对应查询（附件事件只失效该需求的材料，不再全看板重拉）。被更新的卡片 / 字段用 `--accent-soft` 背景 1.5s 渐隐；活动时间线追加。正在编辑的字段收到远端更新时**不打断**，保存时后写生效（ADR-0004 与用户 2026-09-05 决策）。

### 6.5 键盘

| 键 | 动作 |
|---|---|
| ⌘K | 命令面板 |
| ⌘\ / ⌘J | 侧栏 / 右侧面板 |
| C | 新建需求（需求页） |
| / | 聚焦搜索 |
| J / K 或 ↑ / ↓ | 列表与看板中移动选中；速览中切上 / 下一条 |
| 1–7 | 选中需求时直接改状态 |
| Enter / Esc | 打开 / 关闭；会话中 Esc 停止运行（输入框为空时） |
| ⏎ / Esc | 审批卡获焦时批准 / 拒绝 |
| ↑ | 输入框为空时取回上一条消息 |
| ? | 快捷键一览 |

焦点管理：打开浮层时焦点进入，关闭后回到触发元素；看板拖拽有键盘替代（空格拿起、方向键移动、空格放下）并读屏播报。

---

## 七、页面规格要点

（完整视觉见原型画布；以下只写实现要点。）

| 页面 | 要点 |
|---|---|
| 首启 | `FocusLayout` 五步向导；每步独立校验；进度可恢复（刷新后回到未完成步骤）；Codex / 模型 / 代理检查复用诊断接口 |
| 我的工作 | 四区块各自一个查询、各自骨架与错误；"需要你处理"用列表而非卡片，每行一个直接动作 |
| 需求看板 | 列宽 280–320，横向滚动；卡片虚拟化（单列 > 50 条）；dnd-kit 拖拽 + 键盘；列头"+"带状态预填 |
| 需求列表 | TanStack Table，按状态分组，可折叠组；多选后底部浮出批量操作条 |
| 速览 | 读取与详情共用查询（进入详情页零等待）；↑↓ 切换不关闭面板 |
| 需求详情 | 描述原地编辑（Markdown，⌘Enter 保存，Esc 放弃）；材料区整区可拖放；活动时间线分页加载 |
| 开始会话 | 单一对话框承载：选择已有会话 / 新建 → 目录（缺失时）→ 准备进度（快照、附件逐个、建会话）→ 跳转；失败停在失败步骤并可重试 |
| 会话 | 投影层修复后再改渲染；消息流虚拟化；审批坞固定在输入框上方；回合结束时生成摘要行 |
| 设置 | 分组路由化（`/settings/$section`）；表单用 react-hook-form，SaveBar 统一；测试连接统一组件 |

---

## 八、文案规范

- **语气**：平实、具体、主动语态；按钮用动词短语（"开始会话""发布确认版"），不用"确定"。
- **错误**：说发生了什么 + 用户能做什么（"没能连上需求服务。检查地址是否正确，或稍后重试。"），技术细节折叠。
- **空态**：说明这里会出现什么 + 一个起步动作，不说教。
- **禁止出现在界面主文案中的词**：BFF、本机 BFF、远程项目、observed、基线、快照（改"开工时的需求"）、不可信输入、realpath、R/W/X、SHA-256、MiB、service tier、上下文预算、reflog、枚举原值、UUID、环境变量名、版本号 v12（改"第 12 版"）、"历史已截断"（改"更早的记录 · 加载更多"）。
- **数值与时间**：大小用 KB / MB；时间 1 小时内用相对时间，今天用 "14:32"，更早用 "9月27日"。

---

## 九、路由与数据层

### 9.1 路由（TanStack Router）

| 路径 | 页面 | 查询参数 |
|---|---|---|
| `/setup` | 首启向导 | `step` |
| `/login` | 登录 / 注册 | `redirect` |
| `/my` | 我的工作（默认落地） | `scope=all\|project` |
| `/p/$projectId/requirements` | 需求 | `view=board\|list`、`q`、`status`、`assignee`、`creator`、`updated`、`hasSession`、`peek` |
| `/p/$projectId/requirements/$number` | 需求详情 | `tab` |
| `/p/$projectId/overview` | 概览 | `range=7d\|30d` |
| `/sessions` 与 `/sessions/$sessionId` | 会话 | `filter`、`inspector`、`file` |
| `/settings/$section` | 设置 | — |

旧路径（`/requirements`、`/requirements/:id`、`/sessions?sessionId=`、`/overview`、`/settings#x`）一律重定向到新路径，保证既有链接可用。

### 9.2 数据

- `api/client.ts` 保留为请求层；按功能在 `features/*/queries.ts` 封装 Query hooks 与 mutation（含乐观更新）。
- 查询键：`['projects']`、`['requirements', projectId, filters]`、`['requirement', id]`、`['requirement', id, 'activity']`、`['requirement', id, 'materials']`、`['requirement', id, 'artifacts']`、`['sessions', filter]`、`['session', id, 'meta']`、`['settings', section]`、`['codex', 'status']`。
- SSE → `queryClient.invalidateQueries` 精确映射表集中在 `app/realtime.ts`，替代两套并存的 SSE 实现。
- 会话消息流仍走现有事件投影（修复后），不进 Query 缓存。

### 9.3 后端与契约依赖

| 依赖 | 所在 | 阶段 |
|---|---|---|
| 需求编号（项目内递增） | requirements-service 迁移 + contracts | P2 |
| 负责人字段、按负责人筛选 | requirements-service + contracts + BFF | P2 |
| 按需求聚合的活动（评论、附件、产物、字段前后值） | requirements-service `/audit` 或新端点 | P2 |
| 本机目录浏览、最近使用目录 | client/server `/api/v2/local/dirs`（仅 loopback） | P2 |
| 会话列表元数据（最后活动时间、最后一句预览） | client/server | P3 |
| 会话级模型 / 推理 / 审批参数 | client/server + Codex 协议实测 | P3 |
| 计划、推理摘要、token 用量事件透出 | client/server `codex-event-normalizer` | P3 |
| 附件在线预览（安全类型 inline） | requirements-service + BFF | P2 |
| 概览统计：停滞需求带编号、每日流转按目标状态拆分（`byStatus`） | requirements-service + contracts | P4 |
| 需求已读位置（`requirement_reads`、`PUT /v2/requirements/:id/read`）、列表带 `unreadCommentCount`、按创建人筛选（`creator=me`） | requirements-service + contracts + BFF | 收尾 |
| 会话列表运行态带 `runningSince` 与当前步骤 `activity` | client/server + contracts | 收尾 |

---

## 十、实施阶段

| 阶段 | 范围 | 退出条件 |
|---|---|---|
| **P0 基座** | `design/tokens.css`、ThemeProvider（默认跟随系统、首屏无闪）、密度、字体；§5.1、§5.2 组件；旧样式变量映射到新令牌，旧页面整体换上新配色与字号（不改结构，页面级控件替换留给各自阶段，避免重做即废）；反馈组件补齐样式；删除 zoom 与死样式；`/__design` 设计系统页 | 新组件在 `/__design` 双主题可用；旧页面无硬编码色值、亮暗切换正常；typecheck / lint / test 通过 |
| **P1 外壳** | TanStack Router + Query 接入；新侧栏、项目切换、命令面板、连接横幅；首启向导；旧路径重定向 | 所有现有页面在新路由下可达；gate-c 导航步骤重写通过 |
| **P2 需求** | 看板、列表、速览、详情、新建、材料与产物、活动时间线、开始会话流程；§9.3 中 P2 依赖；修复上传死锁、重复建会话、列内新建错状态、必填不校验、误报他人修改 | gate-c 需求链路重写通过；键盘可完成"新建 → 改状态 → 开始会话" |
| **P3 会话** | 投影层修复（多段回复、运行错误）并补单测；消息流、步骤组、计划、改动卡、回合摘要、审批坞、输入框、检查面板、完成提醒；P3 依赖 | 回放 3 个真实会话事件录制无丢字；gate-c 会话链路通过 |
| **P4 其余页** | 我的工作、概览、设置（含代理、MCP 编辑、诊断页） | 设置每组的加载 / 保存 / 失败三态齐全 |
| **P5 打磨** | 动效、快捷键一览、axe 无严重问题、双主题视觉基线、`01_架构设计` 与总览更新 | 验收清单全绿 |

每阶段一个分支、一次合并；P0 完成后旧界面已整体换上新设计语言，后续阶段不会出现两种观感并存。

### 10.1 P3 分片

P3 体量最大，拆成三片，前两片可并行，第三片依赖前两片的类型与接口：

| 分片 | 范围 | 落点 | 完成标志 |
|---|---|---|---|
| **P3a 投影与事件** | normalizer 补映射：`turn/plan/updated` → `plan.updated`、`item/reasoning/summaryTextDelta` / `summaryPartAdded` → `reasoning.*`、`thread/tokenUsage/updated` → `usage.updated`、`item/mcpToolCall/progress` → `tool.progress`；投影改为「每回合一条有序时间线」：文字段按 itemId 分段、与步骤组按事件先后交错，计划取最新、文件改动成卡、回合失败与运行时错误成为该回合内的错误卡（无回合归属的错误成为可关闭提示，不再是全局常驻字符串），回合摘要（用时 / 改动文件数 / 命令数） | `client/server` normalizer、`client/web/src/event-projection` | 单测覆盖多段回复、交错、错误卡、中段回放；录制的会话事件回放无丢字 |
| **P3b 会话元数据与会话级参数** | 跨项目会话列表（最后活动时间、最后一句预览、状态：运行中 / 等你确认 / 失败 / 空闲、关联需求编号）；会话级模型 / 推理强度 / 审批档持久化，并在 `turn/start` 传入（实施时对锁定的 Codex 0.143 协议复核字段） | `client/server`、`client/contracts`、`cloud/contracts` | 契约与接口测试通过；旧客户端不受影响（只增字段 / 端点） |
| **P3c 会话页界面** | 三栏（react-resizable-panels，宽度记忆，<1280 检查面板浮层）；会话列表（筛选、按天分组、行内菜单）；会话头；消息流（TanStack Virtual）、回合时间线渲染、步骤组、计划清单、改动卡、回合摘要、错误卡；审批坞；输入框（排队、↑ 取回、会话级参数、上下文用量环）；检查面板四标签；完成提醒（侧栏计数、标题前缀、可选系统通知） | `client/web` | gate-c 会话链路（选 skill、审批、附件、改动、排队、中断与恢复）改写后通过 |

回放录制：用本机服务真实跑会话，从事件库导出 `EventEnvelope` 序列（去掉路径、正文等隐私内容后）作为测试夹具；Codex Desktop 的 rollout 文件格式不同，不能直接当夹具。

### 10.2 P5 分片

按依赖顺序串行；每片做完跑相关质量门。

| 分片 | 范围 | 完成标志 |
|---|---|---|
| **P5a 清理** | `styles.css` 删掉没有引用的旧样式；`ui/icons.tsx` 换成 lucide 后删除；删除无引用模块（`components/ProjectDialog.tsx`、`ui/hover-card.tsx`）；重建 testid 基线 | 无引用样式与模块清零；双主题截图与清理前一致 |
| **P5b 键盘与动效** | 快捷键登记到一处（`app/shortcuts.ts`），「?」打开快捷键一览（也可从命令面板打开），一览与实现同源；浮层、对话框、抽屉、速览、保存条的进出场统一用动效令牌；所有循环动画受 `prefers-reduced-motion` 约束 | 一览列出的每个快捷键都有测试或走查确认可用；减少动效时无循环动画 |
| **P5c 改用团队模型服务** | Codex 没有 `model_provider`（在用内置默认服务）时，模型服务页说明现状并给出空表单，而不是「读不到配置」；填地址与 Key 保存即建立团队的模型服务（服务端不再对这种情况返回 409） | 从空的 CODEX_HOME 起步，在界面里填地址与 Key 保存后，配置写成安装模板的形状；测试连接实际连到该地址 |
| **P5d 无障碍与视觉基线** | 引入 `@axe-core/playwright`，gate-c 新增无障碍检查步骤：我的工作、看板、列表、需求详情、会话、设置、概览 × 亮 / 暗，零 serious / critical；`visual-baseline.ts` 改为关键页 × 亮 / 暗 × 1440×900 与 1280×800 | 本机 gate-c 通过 |
| **P5e 文档** | `01_架构设计` 补前端架构（路由、数据层、实时、设计令牌、功能目录划分）；`00_项目总览` 更新现状；需求与技术设计的状态更新 | 文档与代码一致 |

---

## 十一、测试与验收

| 层 | 做法 |
|---|---|
| 单元 | vitest + Testing Library：基础组件状态、Query 乐观更新回滚、事件投影（多段回复、错误事件、审批） |
| 端到端 | gate-c 分阶段重写；定位优先 `getByRole` + 可访问名，testid 只留给无语义元素；每阶段重建 testid 基线 |
| 视觉 | Playwright 截图：关键页 × 亮 / 暗 × 1440×900 与 1280×800，替换 `visual-baseline.ts` 的单主题三页 |
| 无障碍 | `@axe-core/playwright`：关键页零 serious / critical；键盘走查清单 |
| 性能 | Monaco、Recharts、diff 按路由懒加载；1000 条事件的会话滚动不掉帧（虚拟列表） |

---

## 十二、风险与回滚

| 风险 | 应对 |
|---|---|
| 路由切换打断既有链接 | 旧路径重定向表 + 端到端覆盖 |
| 投影层修复改变消息顺序 | 先写回放测试锁定期望，再改 |
| 新依赖体积 | 按路由拆包；P5 前核对首屏包体 |
| 阶段间隔过长 | 每阶段可独立交付，完成即合并 |
| P3 本机库迁移（013 会话级模型 / 推理强度、014 会话列表元数据）后回退旧版本 | 旧版本发现未知迁移会拒绝启动并提示删除本机库；发版说明写明「回退需先备份并删除本机库」 |

回滚：以阶段为单位 `git revert` 合并提交；后端依赖均为新增字段 / 端点，不破坏旧客户端。

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-29 | 初稿：基于四路界面审计与 ADR-0006 |
| 2026-09-29 | P0 交付：令牌命名定为 shadcn 对齐（§3.1 注）；浮层层级高于对话框（§3.4）；tailwind-merge 登记自定义字号 / 阴影 |
| 2026-09-29 | P1 实施：TanStack Router 代码式路由表（`app/router.tsx`），根路由统一拦截（未配置 → `/setup`，未登录 → `/login?redirect=`）；旧路径全部重定向；会话页暂沿用「当前项目」上下文，P3 改为跨项目列表；首启向导的环境检查把诊断结果汇总为 4 条结论（`app/pages/doctor-summary.ts`，P4 诊断页复用）；新建项目改为外壳级对话框（无项目时也可用），管理项目仍在需求页内，P2 迁出 |
| 2026-09-29 | P2 实施：需求详情地址改用编号 `/p/$projectId/requirements/$number`（旧 UUID 链接重定向到编号地址），速览 `?peek=<编号>`；速览 ≥1440px 与看板并排、更窄时浮在看板上并把焦点移进面板；看板列宽 272px，列多时看板在内容区内横向滚动（取消「1440 不得横向滚动」）；项目改名 / 归档退役 `expectedVersion`，后写生效并告知覆盖了谁（ADR-0004）；实时事件按类型精确失效，评论 / 材料 / 确认版只重取该需求并原地更新卡片计数；在线预览按扩展名白名单 + 本机服务嗅探；开始会话先确认关联目录仍可用，不可用直接回到选目录；根路由按已完成地址（`resolvedLocation`）判断登录跳转，修复未登录进入 `/` 时的跳转踩踏；gate-c 的 v2-user-path、requirements-board 按新交互重写，夹具补成员、按编号取需求、活动时间线 |
| 2026-09-29 | P3 实施：投影新增「时间线」（文字按 itemId 分段并与步骤组交错、计划、改动卡、审批步骤、回合内错误卡与「正在重连（第 N/M 次）」、回合摘要），去掉无人读取的全局 runtimeError；会话页改为跨项目列表（GET /api/v1/sessions，筛选 / 按天分组 / 原地重命名 / 归档可撤销 / 删除确认）｜会话（会话头、对话 / 检查面板可拖宽度，<1280 检查面板浮层，⌘J / ⌘B）；审批坞固定在输入框上方；输入框底栏放审批档、会话级模型与推理强度（turn/start 粘性覆盖，改回默认时显式下发全局默认）、上下文用量环；检查面板四标签（改动 / 需求 / 环境 / 文件）；回合摘要「回到开始前」用回合前自动存档还原（有回合运行时不提供）；后台完成 / 失败 / 等你确认时标题前缀与可选系统通知；会话 PATCH 后写生效不再比对 If-Match（ADR-0004）；推理强度接受格式合法的新档位；回填按类过滤增量事件（契约导出清单） |
| 2026-09-29 | P3 复核修正：审批坞 ⏎ / Esc 只在审批卡获焦时生效；Codex 改动路径为绝对路径，界面与查看 diff 统一换成项目内相对路径；v2 文件改动审批经 itemId 关联改动卡显示待改文件与未写入的 diff；「回到开始前」取回合开始时最近的检查点并照实说明；列表筛选进 URL（`/sessions?filter=`）。**未完成的退出条件**：「回放 3 个真实会话录制无丢字」需要可用的 Codex 账号跑真实回合录制，待用户确定账号后补；系统通知开关随 P4 设置页提供 |
| 2026-09-29 | P4 实施（我的工作、概览）：「我的工作」四个区块（需要你处理 / 我的需求 / 会话 / 最近动态）各自降级，「需要你处理」按 等你确认 > 上一轮失败 > 开工后需求有变化 > 代码目录失效 排序，我的需求可切「全部项目 / 当前项目」；概览改走 Query 并挂在项目查询键下（需求实时事件自动刷新），流转趋势换成按目标状态堆叠的柱状图（recharts 按需懒加载，另附读屏表格），停滞需求可按 3 / 7 / 14 天筛选、按编号进详情，最近动态先显示 8 组可展开；统计接口补停滞需求编号与每日 `byStatus`。删除旧概览组件、旧 SSE hook（已由外壳级实时同步取代）与详情呈现模块 |
| 2026-09-29 | P4 复核修正（我的工作、概览）：工作台接口整体失败时各区块显示「暂不可用」而不是空态，同一原因只报一次警报；刷新图标只在手动刷新时转；记忆的偏好（范围 / 时间范围 / 停滞门槛）读到非法值回落默认；「会话」区块改读本机会话列表（与会话页、侧栏共用缓存，不等需求服务，真正独立加载），卡片带需求编号与最后一句话，状态点与文字同源；首启跳过的事在「我的工作」顶部留清单（§4.2，localStorage，代码目录以实际关联为准，可关闭）；修复目录后刷新关联缓存，提交按钮不禁用改为点击时说明；概览评论 / 附件 / 产物 / 项目事件也刷新「最近动态」；停滞改为服务端按门槛与状态筛并返回总数（只算梳理中 / 待开发 / 开发中 / 测试中，草稿、暂缓、已完成不算——**待用户确认**），流转把「状态和标题一起改」（记为 updated）也算进去；统计契约 `number` / `byStatus` / `staleTotal` 改为可选以兼容旧版需求服务；图表读屏表按状态分列；页面根不再嵌套 `<main>`。**延后**：「指派给我且有新评论」（需要已读状态，另立需求）；进行中会话的当前步骤 / 已用时间（先用最后一句话代替）；`/my?scope=`、`/overview?range=` 进 URL（先用经校验的本机偏好）；§4.3「我负责的（或我创建的）」是否包含我创建的——**待用户确认** |
| 2026-09-29 | P4 设置页实施：分组路由 `/settings/$section`（外观、通知、账号、需求服务、代码目录、模型服务、执行与安全、Skills、MCP 服务、网络代理、诊断、关于；「通知」单列一组，写本机偏好 `suduo.notify.system`，开启时申请浏览器授权、被拒绝时说明如何重新允许）；`/settings` 落到上次看的分组，旧 `/settings#组` 重定向到对应分组；左侧分组导航带图标与异常提示点（需求服务未配置、目录失效、模型服务未配置 / 取不到模型清单 / Codex 配置提醒、MCP 启用了但没连上、通知被浏览器阻止），设置搜索跳到具体一行并高亮；行式布局；开关与单选即时保存并原位显示「已保存」、失败回滚并提示重试；需求服务、模型服务、网络代理三个多字段表单用底部保存条（⌘S），离开分组或页面前提醒（放弃 / 继续编辑，关标签页交给浏览器；换服务后跳登录页不拦）；「测试连接」统一组件，成功 / 失败两种样式，失败给原因与建议——需求服务与代理用草稿测，模型服务按既定原则（R3，不用未保存的凭据探测）测已保存的配置，有未保存更改时说明原因不可点，失败时再试连一次网络区分「连不上」与「被拒绝」；代码目录复用目录选择器，失效项给原因与「重新选择 / 重新检查」；网络代理接上已有 `PATCH /api/v1/settings` 代理四字段与 `POST /api/v1/settings/proxy/test`；诊断页汇总需求服务、登录、Codex、模型服务、网络与代理、MCP、代码目录、本机运行环境八项，每项独立加载与失败、给修复入口，复制诊断信息（环境变量名、原始自检只在复制内容与自检明细里出现）；原顶部状态条并入诊断页与导航提示点；修复「上下文窗口填非数字会提交 NaN」（整数 4000~1 亿校验）；表单未引入 react-hook-form（字段少，用草稿 + 字段校验 + 统一保存条）；主题预览缩略图用 `data-theme-scope` 在局部套用另一套令牌；gate-c 设置三步按新结构改为角色 + 可访问名定位，需求服务夹具补 `/v2/health` |
| 2026-09-29 | P4 设置页复核修正与收尾：MCP 编辑只发改动部分、变量名放补丁顶层，参数按引号规则往返无损（避免把含空格的参数拆散写回配置）；系统通知开关即偏好，被浏览器阻止时照实显示且可关闭；保存网络代理前数运行中 / 等你确认的会话，有则说明会被中断并给「仍然保存 / 取消」（ADR-0004：告知 + 选项，不拦）；旧 `/settings#组` 应用内跳转不丢锚点；代码目录关联变更统一经 `invalidateMappingCaches` 刷新各处；侧栏「我的工作」显示待处理数（§4.1）。**验证**：typecheck / lint / 全部测试 / testid / build 通过；本机 gate-c 8 步（v2-user-path、requirements-board、sessions-rail、settings-shell、settings-codex、mcp-settings、visual-closeout、extension-seam）通过——settings-codex 的「Codex 配置提醒」一项本机 Codex 0.143 不发 configWarning，改由单测覆盖，需在 gate-c 主机复核；overview-workbench 步骤需要可用的 Codex 账号，未跑。**遗留到 P5**：Codex 未配置 `model_provider` 时模型服务页只能显示「读不到配置」，无法在界面里建第一个模型服务（服务端 409，首启「去配置」因此走不通）；局部主题区域内不要用 `dark:` 变体（它只认根节点） |
| 2026-09-29 | P5 实施：**P5a 清理**——`styles.css` 从 1312 行减到约 150 行（按类名真正出现在 className 里判定，保留 rehype-highlight 运行时生成的 `hljs-*`），构建 CSS 133 KB → 73 KB，双主题关键页逐像素比对：除输入框里换成 lucide 的图标线宽外无差异；`ui/icons.tsx` 换 lucide 后删除；删除无引用模块；错误兜底页改用令牌与人话。**P5b 键盘与动效**——快捷键清单 `app/shortcuts.ts`，「?」与命令面板打开一览，测试核对清单里每个键在源码里有处理；浮层进出场默认取动效令牌。**P5c 模型服务初次配置**——没有 `model_provider` 视为「未配置」而非 409，第一次保存建立 `[model_providers.suduo]`（形状同安装模板），真实 Codex 夹具测试覆盖建立与还原；测试连接改为「模型清单 + 实连服务地址」两样都通才算通（Codex 的清单可能来自内置目录）。**P5d 无障碍与视觉基线**——gate-c 新增 `a11y-audit`（关键页 × 亮暗，axe WCAG 2.1 A/AA 零 serious/critical，实测零违规），视觉基线扩到关键页 × 亮暗 × 1440/1280（28 张）；为此亮色次要文字、成功、警示、危险色加深，新增令牌对比度单测；需求详情活动筛选改分段选择、检查面板标签补面板。**P5e 文档**——重写 `01_架构设计/client-web-架构.md`，更新系统架构的前端信息架构与总览。**验证**：typecheck / lint / 全部测试 / testid / build 通过；本机 gate-c 9 步通过（settings-codex 的配置提醒一项与 overview-workbench 需真实 Codex，见上）。**仍未收口**：P3 回放验收（待账号） |
| 2026-09-29 | P5 复核修正：改用团队模型服务时，写入与还原一律以用户文件（config.toml）原文为准——用户文件里没有 `[model_providers.suduo]` 就整表建立、失败整表删掉，已有就只改地址、失败写回原值（真实 Codex 夹具覆盖这两种情形；此前按合并后的生效配置还原，已有该表时还原会被 Codex 拒收，留下改了一半的配置）；「没有 model_provider」改称「在用 Codex 内置的默认服务」；第一次改用必须填 Key，替换现有登录前说明会覆盖 Codex 当前登录（含 ChatGPT 登录）；保存不再声称「已验证」（Codex 的模型清单可能来自内置目录、不经过网络），改为保存后实际连一次地址并照实告知（连不上不撤销）；测试连接在没有地址时不去实连；代理测试在没有地址时说明原因；快捷键清单每条登记处理它的源文件，测试按文件核对，拆出「写需求」「会话输入框」两组并补详情页 Esc；动效默认值只作用于真正带进出场动画的元素；错误兜底页不依赖共享组件；检查面板的标签面板有焦点环；令牌对比度测试补实底 + 字色组合、缺令牌即失败，并修正首启向导「已完成」圆点在暗色下的对比度；gate-c 等骨架屏消失再检查、关掉动效、结束后还原主题 |
| 2026-09-29 | 收尾（用户 2026-09-29 授权按项目定位决定口径并做完延后项）：**P3 回放验收完成**——接入用户本机的中转站 Codex（SuDuo 专用 CODEX_HOME，只复制模型服务配置，Key 仍由钥匙串命令提供），真实跑 3 个会话（只读说明 / 改文件并跑测试 / 先列计划再实现），SSE 全量录制脱敏后作为夹具，`test/session-replay.test.ts` 验证实时回放与刷新后回放都一字不差；同一配置下本机 gate-c 的真实会话链路（assistant-approval、overview-workbench、附件、改动、归属、排队、停止、中断与重开、final-interrupt）全部通过，supervisor-recovery 依赖 systemd 只能在 Linux 主机跑。**口径**：停滞按各状态节奏（`STALE_RHYTHM`，contracts 共用），去掉统一天数参数；我的需求补「我提的、还没人负责」。**延后项做完**：需求已读位置与「有新评论」、我负责的需求停滞较久进「需要你处理」、侧栏数字与页面同源（`useMyWorkData`）、会话卡已用时间与当前步骤、`/my?scope=` 与 `/overview?range=` 进地址。**其他**：模型服务页识别「取 Key 命令 / 环境变量」两种密钥来源（`apiKeySource`），此时不给「更换 Key」入口；新增 `client/scripts/dev-local.sh`（本机联调栈，数据放 `SUDUO_DEV_DATA`） |
| 2026-09-29 | 收尾复核修正（两轮独立复核）：**已读位置**——只记界面上真的显示出来的最新一条评论、只在标签页前台时记（`useReadMarker` 独立成 `read-marker.ts`），服务端 `upTo` 只收带时区的 ISO 时间、不晚于此刻、不早于 7 天基线、只往前走（`GREATEST`，合并规则不是拒绝）；比较按毫秒截断；评论时间默认值改 `clock_timestamp()`（迁移 010）；未读只在「指派给我」列表里算；**确认版发布说明不算新评论**（与「评论」筛选一致，口径按授权决定）。**兼容**：旧需求服务丢掉 `creator` 时前端按创建人与负责人再筛；概览在旧服务（无 `staleTotal`）时照实说明；本机服务忽略旧客户端的 `staleDays`。**其他**：会话卡当前步骤同条目完成显示「刚完成」，命令打码覆盖 GitHub / Slack / AWS 令牌、URL 账号密码、`curl -u`、`mysql -p` 等；侧栏在我的工作页不另设刷新；新评论实时事件让「指派给我」重取；回放测试改为每段增量逐条比对；夹具去掉本机用户名与路径；`dev-local.sh` 校验进程号归属、停止等退出、启动等到健康检查 2xx（绕开代理）。gate-c 需求服务夹具补已读接口，看板步骤断言打开详情后已读位置记到那条评论。**验证**：typecheck / lint / 全部测试 / testid / build 通过；本机 gate-c 18 步（除 supervisor-recovery）用中转站 Codex 通过——settings-codex 用去掉「Codex 配置提醒」断言的本机变体，该项与 supervisor-recovery 仍需在 Linux gate-c 主机复核 |
| 2026-09-30 | 验收收口与环境修复：**官方 gate-c 全量 19 步通过**——新增 `client/scripts/gate-c-vm.sh` + `client/scripts/gate-c-vm/lima.yaml`，在 macOS 上用 Lima 虚拟机（vz、Ubuntu 24.04、systemd 用户服务）跑 `gate-c.real.ts`，原先只能在 Linux 主机复核的 supervisor-recovery（杀 Codex 子进程后服务自动恢复）与 settings-codex「Codex 配置提醒」（虚拟机里 Codex 因缺 bubblewrap 发 configWarning）都已覆盖；模型服务 Key 由宿主机命令取出、经管道写进虚拟机内存盘、跑完即删。**过程中修掉的问题**：`install.mjs` 装的 systemd 服务 PATH 里没有 nvm / mise 装的 node，`node_modules/.bin/codex` 包装找不到 node、Codex 以 127 退出——本机服务启动时把自己所用 node 的目录补到继承来的 PATH 最前面（`withNodeOnPath`，app-server、沙箱探测、诊断等所有 Codex 子进程都继承；不在单元里写死 PATH，免得丢掉 snap / environment.d 等目录）；Ubuntu 24.04 默认限制非特权用户命名空间，Codex 自带 bubblewrap 沙箱起不来、审批后的命令全部失败（虚拟机里放开；真实部署在 Ubuntu 24.04 上应 `apt install bubblewrap`，系统 bwrap 带 AppArmor 放行）；gate-c 的 Chromium 依赖库路径按架构取；等待回合收尾的余量 90 → 180 秒（推理强度真正发给模型后收尾更慢）；`formatRelativeTime` 的今天 / 昨天 / 今年改按传入的 now 判断（原先读系统时钟，跨日即失败）。**模型上下文**：调研确认 Codex 0.143 内置目录没有中转站的 gpt-6-sol（桌面端内置 0.158、CLI 0.157 有：272000 / 最大 872000），走兜底元数据时不但提示「模型元数据未找到」，还不发推理强度、不开并行工具与改文件工具；只填「上下文上限」消不掉提示也调不高上限。本机联调栈与 gate-c 的 CODEX_HOME 已用 `model_catalog_json` 补上 gpt-6-sol 的目录条目，真实回合验证提示消失；界面上「上下文上限」说明、会话提示与契约注释按此改正。是否把 Codex 升到 ≥0.155 或在产品里支持模型目录，待用户决定 |
| 2026-09-30 | Codex 升级（用户决定：升到最新稳定版、按官方指引配置，见 [ADR-0007](../06_决策记录/ADR-0007-Codex升级到0.159.2-配置按官方指引.md)）：@openai/codex 0.143.0 → **0.159.2**，版本锁全部同步（依赖、`CODEX_VERSION`、协议基线、安装器读 `VERSION`、Windows 安装包地址与 sha256、doctor、gate-a/b）；中转站 `gpt-6-sol` 用上内置元数据，撤掉自制 `model_catalog_json`，配置模板按官方写法重写。逐项对比 0.143 ↔ 0.159.2 的 schema / CLI 后修正：非审批服务端请求必须回包（`currentTime/read` 回时间，其余回 -32601 并在时间线说明已跳过）；旧式审批与权限审批的回包形状与档位（批准只授予这一回合、「本会话都允许」授予整个会话）；writeStdin 审批单独说明、权限审批显示要的范围；MCP `toolsError` 作为失败原文透出（收回 0.143 豁免）；官方 doctor 的 warning 不阻断；默认推理强度按模型声明档位（「极致+」暂不提供）；新提示与错误种类本地化；全局通知不挂到会话、额度通知安静丢弃；诊断汇总的「网络」只在 fail 时判连不上。**Linux 沙箱**：doctor 新增「Codex 沙箱（Linux）」异步真跑检查（只告知、不阻断），诊断页单列「命令沙箱」；`install.mjs` 服务单元去掉 `PrivateTmp`（Ubuntu 24.04 上会让服务里的沙箱失效，gate-c 虚拟机里实测定位）；gate-c 虚拟机改为官方沙箱配置、默认限制不放开，配置提醒由探针键确定性触发。**验证**：typecheck / lint / 全部测试 / testid / 协议基线 / build 通过；本机联调栈经中转站真实回合正常（无元数据提示、上下文 258400），0.143 时建的旧会话在 0.159.2 上恢复并继续；Ubuntu 24.04 虚拟机（默认限制 + 官方 AppArmor 配置）官方 gate-c 全量 19 步通过。**未验证**：Windows 安装包在 Windows 上实装；ultra 档与子代理线程；gpt-6-sol 会话中途改推理强度（元数据声明不支持）；`delivery: async` 的提问选项 |
