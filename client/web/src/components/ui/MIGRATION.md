# 组件基座说明（UI/UX 产品化重设计 P0 起）

> 规格：`docs/03_开发计划/suduo-v2-UIUX产品化重设计-技术设计.md` §三–§六。活样本：开发环境打开 `/__design`。

## 规则

- 组件只引用 `src/design/tokens.css` 的语义令牌（Tailwind 类名如 `bg-card`、`text-muted-foreground`、`text-small`），不写色值、不写 `dark:`。
- `styles.css` 的「存量变量桥」只服务尚未重做的旧页面，新代码不得引用桥里的旧名（`--panel`、`--warn`、`--text-sm` 等）。
- 每个页面 / 面板 / 对话框最多一个 `variant="primary"` 按钮；危险操作用 `danger` 并走 `AlertDialog` 或 `ConfirmDialog`。
- 按钮禁用时尽量给 `disabledReason`；异步提交用 `loading`，不要自己拼加载圈。
- 表单控件用 `Field` 包裹，由它接好 `id` / `aria-describedby` / `aria-invalid`。

## 组件清单

基础：Button、Input、Textarea、Field、Label、Select、Checkbox、Switch、RadioGroup / RadioCard、SegmentedControl、Tabs（underline / segmented）、
Tooltip、Popover、DropdownMenu、Dialog、AlertDialog、Sheet、Command、Badge、Avatar、Kbd、Spinner、Skeleton、Progress、Banner、Collapsible、Card、
Separator、ScrollArea、Toaster、StatusIcon / StatusLabel。

反馈出口（`src/feedback/components`）：InlineError、RegionError、PageFailure、EmptyState（inline / section / page）、ConfirmDialog、FormDialog（未保存内容先询问再放弃）。

## 旧页面迁移

旧页面中的裸 `<button>` / 原生 `<select>` / 手写弹窗不在 P0 逐个替换，随 P2（需求）、P3（会话）、P4（我的工作 / 概览 / 设置）整页重做时一并清除。
