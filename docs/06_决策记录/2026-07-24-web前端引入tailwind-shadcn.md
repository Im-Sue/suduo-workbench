# ADR-0003：Web 前端引入 Tailwind v4 + shadcn/ui（New York），视觉基调「线条感」

- 状态：accepted
- 日期：2026-07-24
- 决策人：用户（试点反馈驱动，Claude 提案并实施）
- 关联：ADR-0002（一体化形态）、7-14 UI 重设计方案大纲

## 背景

SuDuo web 端此前为全自研组件 + 手写 styles.css（约 2600 行）+ CSS 变量令牌，
无任何 UI 组件库。试点反馈暴露两类成本：

1. 交互基建反复手写且易错（下拉外点关闭、焦点管理、键盘导航、浮层定位）；
2. 视觉希望向「线条感」（细描边、小圆角、克制灰阶，Linear/Vercel 风）演进，
   逐条手调令牌效率低。

7-14 批次 3 已确立先例：markdown 渲染弃自研改 react-markdown，原则定为
「渲染管道用成熟库，交互与业务自研」。7-24 用户先后拍板：message 提示改
react-hot-toast；全量引入 shadcn 体系做 UI&UX 改造。

## 决策

1. **引入 Tailwind CSS v4**（@tailwindcss/vite 插件、CSS-first 配置），
   **不引 preflight**——存量样式自带完整 reset，分层引入
   （theme/utilities）避免全局冲击。
2. **引入 shadcn/ui（New York 风格）**：组件以源码形式落在
   `src/components/ui/`（不是黑盒依赖），底层 Radix primitives 提供行为与
   可访问性，皮肤走项目语义变量。components.json 已配好，后续
   `npx shadcn add <component>` 即可增补。
3. **令牌体系 v3**：shadcn 语义变量（--background/--card/--border/--primary…）
   成为唯一定义源；旧令牌（--surface/--line/--text…）降级为别名引用，
   存量 CSS 零改名整体换肤。业务语义色（warn/ok/flow/danger）与字号阶梯保留。
4. **线条感调参**（对全部存量组件即刻生效）：边框加实
   （浅 #d9dee5/#c2cad4，暗 #333b46/#46515e）、正文加深（#16181d）、
   阴影收敛（lg 8px/24px/0.12）、圆角三档 14/10/6 收紧为 10/8/6、
   按钮改 New York 描边风（border=--input + shadow-sm，hover 染 --accent）。
5. **迁移策略：渐进不推翻**。新组件一律用 shadcn/Radix；存量组件"改到才迁"；
   首个示范=ModelSwitcher 迁 DropdownMenu（级联子菜单，对齐 codex 官方交互）。
6. 原则升级为：**行为用无头库（Radix），皮肤和业务自研（语义变量）**；
   专职库按需（react-hot-toast 已用，@tanstack/react-virtual、
   react-hook-form 为候选）。

## 否决的替代方案

- **antd / MUI / Arco 全家桶**：与已成体系的自研设计语言并存=两套体系打架，
  整体迁移是负收益；antd/HeroUI 视觉偏圆润不符「线条感」。
- **Radix Themes 成品库**：不需要 Tailwind，但视觉定制深度不足，
  与「线条感」目标有距离。
- **继续纯自研**：交互基建（焦点/键盘/浮层）的长尾成本已被试点证实。

## 影响与约束

- 新依赖：tailwindcss、@tailwindcss/vite、tw-animate-css、clsx、
  tailwind-merge、class-variance-authority、lucide-react、
  @radix-ui/react-dropdown-menu、@radix-ui/react-slot。
- 新组件**只用语义变量类**（bg-popover 等），不用 `dark:` 工具类——
  「跟随系统」主题模式不打 data-theme，dark variant 只绑显式覆盖。
- 路径别名 `@/*` 已加入 tsconfig 与 vite（shadcn 源码惯例）。
- gate-c 断言依赖的 data-testid 在迁移中必须保留。
- 双主题验收：改 CSS 后必须 rebuild 再截图（7-20 教训）。

## 验证

typecheck / lint / 25 web 用例 / build 全绿；gate-c 真机回归 PASS
（见 artifacts/gate-c/）；双主题截图目检。
