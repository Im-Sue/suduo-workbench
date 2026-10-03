import { REQUIREMENT_STATUSES } from "@suduo/cloud-contracts";
import { MoreHorizontalIcon, PencilIcon, PlayIcon, PlusIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { RadioCard, RadioGroup } from "@/components/ui/radio-group";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { StatusLabel } from "@/components/ui/status-icon";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EmptyState, InlineError, RegionError } from "@/feedback/components/index";
import { showMessage } from "@/ui/message";
import { applyDensityPreference, loadDensityPreference, type DensityPreference } from "@/ui/density";
import { applyThemePreference, loadThemePreference, type ThemePreference } from "@/ui/theme";
import { SessionStreamSample } from "./SessionStreamSample.js";

/**
 * 设计系统页（仅开发环境，/__design）：令牌与组件的活样本。
 * 新组件落地先在这里出现、双主题过目，再进入业务页面。
 */

const SURFACE_TOKENS = ["--background", "--card", "--muted", "--muted-strong", "--popover", "--border", "--border-strong"];
const TEXT_TOKENS = ["--foreground", "--muted-foreground", "--subtle-foreground", "--disabled-foreground"];
const INTENT_TOKENS = ["--primary", "--primary-soft", "--success", "--warning", "--danger", "--destructive"];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-border py-8">
      <h2 className="m-0 text-section font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Swatch({ token }: { token: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-12 rounded-md border border-border" style={{ background: `var(${token})` }} />
      <code className="font-mono text-caption text-muted-foreground">{token}</code>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-4">
      <span className="text-caption text-subtle-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

export function DesignSystemPage() {
  const [theme, setTheme] = useState<ThemePreference>(() => loadThemePreference());
  const [density, setDensity] = useState<DensityPreference>(() => loadDensityPreference());
  const [approval, setApproval] = useState("auto");
  const [notify, setNotify] = useState(true);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(64);

  return (
    <TooltipProvider>
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-border bg-card px-8">
        <h1 className="m-0 text-section font-semibold">SuDuo 设计系统</h1>
        <span className="text-caption text-subtle-foreground">tokens v5 · 开发环境样本页</span>
        <div className="ml-auto flex items-center gap-3">
          <SegmentedControl
            aria-label="主题"
            value={theme}
            options={[
              { value: "system", label: "跟随系统" },
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
            ]}
            onValueChange={(next) => {
              applyThemePreference(next);
              setTheme(next);
            }}
          />
          <SegmentedControl
            aria-label="密度"
            value={density}
            options={[
              { value: "comfortable", label: "舒适" },
              { value: "compact", label: "紧凑" },
            ]}
            onValueChange={(next) => {
              applyDensityPreference(next);
              setDensity(next);
            }}
          />
        </div>
      </header>

      <main className="mx-auto max-w-[1080px] px-8 pb-24">
        <Section title="颜色">
          <div className="grid grid-cols-7 gap-3">
            {SURFACE_TOKENS.map((token) => <Swatch key={token} token={token} />)}
          </div>
          <div className="grid grid-cols-6 gap-3">
            {INTENT_TOKENS.map((token) => <Swatch key={token} token={token} />)}
          </div>
          <div className="flex flex-col rounded-md border border-border bg-card">
            {TEXT_TOKENS.map((token) => (
              <div key={token} className="flex items-center gap-4 border-b border-border px-4 py-2.5 last:border-b-0">
                <span className="flex-1 text-body" style={{ color: `var(${token})` }}>
                  订单导出改为异步任务 · Aa 128
                </span>
                <code className="font-mono text-caption text-muted-foreground">{token}</code>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-4">
            {REQUIREMENT_STATUSES.map((status) => <StatusLabel key={status} status={status} />)}
          </div>
        </Section>

        <Section title="字号">
          <div className="flex flex-col gap-2">
            <span className="text-display font-semibold">display 24 · 页面主标题</span>
            <span className="text-page font-semibold">page 20 · 详情标题</span>
            <span className="text-section font-semibold">section 16 · 区块与对话框标题</span>
            <span className="text-body">body 14 · 正文、描述、消息</span>
            <span className="text-small text-muted-foreground">small 13 · 控件与次要信息</span>
            <span className="text-caption text-subtle-foreground">caption 12 · 时间、计数（最小字号）</span>
            <span className="font-mono text-small">code 13 · pnpm test src/export</span>
          </div>
        </Section>

        <Section title="按钮">
          <Row label="变体">
            <Button variant="primary"><PlayIcon />开始会话</Button>
            <Button variant="secondary">发布确认版</Button>
            <Button variant="ghost">取消</Button>
            <Button variant="danger">删除附件</Button>
            <Button variant="danger-ghost">退出登录</Button>
            <Button variant="link">查看改动</Button>
          </Row>
          <Row label="尺寸">
            <Button size="sm">小 28</Button>
            <Button size="md">默认 32</Button>
            <Button size="lg">大 36</Button>
            <Button size="icon" variant="ghost" aria-label="更多操作"><MoreHorizontalIcon /></Button>
            <Button variant="primary">新建需求<Kbd>C</Kbd></Button>
          </Row>
          <Row label="状态">
            <Button
              variant="primary"
              loading={loading}
              onClick={() => {
                setLoading(true);
                window.setTimeout(() => setLoading(false), 1500);
              }}
            >
              {loading ? "保存中" : "点我保存"}
            </Button>
            <Button variant="primary" disabled disabledReason="项目已归档，不能新建需求">新建需求</Button>
            <Button disabled>不可用</Button>
          </Row>
        </Section>

        <Section title="输入与选择">
          <div className="grid grid-cols-2 gap-5">
            <Field label="需求标题" hint="出现在看板卡片上，建议 30 字以内">
              <Input placeholder="例如：订单导出改为异步任务" />
            </Field>
            <Field label="上下文上限" error="请输入整数，例如 200000">
              <Input className="font-mono" defaultValue="20万" />
            </Field>
            <Field label="服务地址">
              <Input className="font-mono" disabled defaultValue="由管理员统一配置" />
            </Field>
            <Field label="负责人">
              <Select defaultValue="chen">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="chen">陈思远</SelectItem>
                  <SelectItem value="lin">林雨</SelectItem>
                  <SelectItem value="zhou">周航</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field className="col-span-2" label="描述">
              <Textarea placeholder="补充背景、目标或验收标准，支持 Markdown" rows={3} />
            </Field>
          </div>
          <Row label="开关与勾选">
            <label className="inline-flex items-center gap-2 text-small">
              <Switch checked={notify} onCheckedChange={setNotify} />
              会话完成时通知我
            </label>
            <label className="inline-flex items-center gap-2 text-small">
              <Checkbox defaultChecked />
              全选
            </label>
            <SegmentedControl
              aria-label="视图"
              value="board"
              options={[{ value: "board", label: "看板" }, { value: "list", label: "列表" }]}
              onValueChange={() => undefined}
            />
          </Row>
          <RadioGroup value={approval} onValueChange={setApproval} className="max-w-[560px]">
            <RadioCard value="ask" title="每步确认" description="运行命令、修改文件前都先问你。" />
            <RadioCard value="auto" title="越界时确认" badge={<Badge variant="primary">推荐</Badge>} description="目录内的常规操作直接执行；联网或访问目录外时问你。" />
            <RadioCard value="full" title="完全访问" description="不再询问，切换时会再确认一次。" />
          </RadioGroup>
        </Section>

        <Section title="浮层">
          <Row label="触发">
            <Dialog>
              <DialogTrigger asChild><Button>对话框</Button></DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>新建需求</DialogTitle>
                  <DialogDescription>创建后会出现在「草稿」列。</DialogDescription>
                </DialogHeader>
                <Field label="需求标题"><Input placeholder="需求标题" /></Field>
                <DialogFooter>
                  <Button>取消</Button>
                  <Button variant="primary">创建需求<Kbd>⌘⏎</Kbd></Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <AlertDialog>
              <AlertDialogTrigger asChild><Button variant="danger-ghost"><Trash2Icon />删除附件</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogTitle>删除「字段映射.csv」？</AlertDialogTitle>
                <AlertDialogDescription>删除后其他成员也看不到这个文件。已发布的确认版里的副本不受影响。</AlertDialogDescription>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction>删除附件</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Sheet>
              <SheetTrigger asChild><Button>侧边抽屉</Button></SheetTrigger>
              <SheetContent>
                <div className="p-5"><SheetTitle className="text-section font-semibold">需求速览</SheetTitle></div>
              </SheetContent>
            </Sheet>
            <Popover>
              <PopoverTrigger asChild><Button>气泡面板</Button></PopoverTrigger>
              <PopoverContent>
                <p className="m-0 text-small">上下文用量为估算值：当前模型没有声明上下文上限。</p>
              </PopoverContent>
            </Popover>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button>菜单</Button></DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem><PencilIcon />重命名<DropdownMenuShortcut>R</DropdownMenuShortcut></DropdownMenuItem>
                <DropdownMenuItem><UploadIcon />上传材料</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="danger"><Trash2Icon />删除会话…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </Row>
          <div className="max-w-[520px] overflow-hidden rounded-lg shadow-overlay">
            <Command>
              <CommandInput placeholder="搜索需求、会话，或输入命令" />
              <CommandList>
                <CommandEmpty>没有匹配的结果</CommandEmpty>
                <CommandGroup heading="需求">
                  <CommandItem>REQ-128 订单导出改为异步任务</CommandItem>
                  <CommandItem>REQ-126 支付回调重试策略调整</CommandItem>
                </CommandGroup>
                <CommandGroup heading="操作">
                  <CommandItem><PlusIcon />新建需求<CommandShortcut>C</CommandShortcut></CommandItem>
                  <CommandItem>切换到深色主题</CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          </div>
        </Section>

        <Section title="反馈">
          <div className="flex flex-col gap-2">
            <Banner tone="pending" actions={<Button size="sm" variant="ghost">立即重试</Button>}>
              与需求服务的连接已断开，正在重连…
            </Banner>
            <Banner tone="info" actions={<Button size="sm" variant="ghost">查看改动</Button>}>
              林雨 刚刚更新了描述
            </Banner>
            <Banner tone="warning" title="还差 1 项设置">模型服务未配置，暂时不能开始会话</Banner>
            <Banner tone="danger" title="会话中断">模型服务连接失败</Banner>
          </div>
          <Row label="全局提示">
            <Button onClick={() => showMessage("已创建 REQ-142", "success")}>成功</Button>
            <Button onClick={() => showMessage("状态没能保存，已恢复原样", "error")}>失败</Button>
            <Button onClick={() => showMessage("附件较大，上传可能需要一会儿", "warning")}>提醒</Button>
          </Row>
          <div className="w-[320px]"><InlineError kind="validation">请输入整数，例如 200000</InlineError></div>
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-lg border border-border bg-card">
              <EmptyState title="还没有会话" description="从一个需求开始，Codex 会带上需求和材料。" action={{ label: "去选择需求", onClick: () => undefined }} />
            </div>
            <div className="rounded-lg border border-border bg-card">
              <RegionError kind="upstream_unavailable" message="需求服务暂时没有响应。" onRetry={() => undefined} />
            </div>
          </div>
          <EmptyState size="inline" title="暂无" />
        </Section>

        <Section title="加载">
          <Row label="行内">
            <span className="inline-flex items-center gap-2 text-small text-muted-foreground"><Spinner />仍在处理…</span>
            <div className="flex w-[240px] flex-col gap-1.5">
              <div className="flex text-small"><span>交互稿.png</span><span className="ml-auto text-subtle-foreground">{progress}%</span></div>
              <Progress value={progress} />
            </div>
            <Button size="sm" onClick={() => setProgress((value) => (value >= 100 ? 10 : value + 15))}>推进</Button>
          </Row>
          <div className="grid max-w-[560px] grid-cols-2 gap-3">
            <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
              <Skeleton className="h-2.5 w-2/5" />
              <Skeleton className="h-3 w-11/12" />
              <Skeleton className="h-3 w-3/4" />
            </div>
            <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
              <Skeleton className="h-2.5 w-1/3" />
              <Skeleton className="h-3 w-5/6" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          </div>
        </Section>

        <Section title="标识">
          <Row label="徽标">
            <Badge>3</Badge>
            <Badge variant="primary">推荐</Badge>
            <Badge variant="success">确认版 · 第 2 版</Badge>
            <Badge variant="warning">等你确认</Badge>
            <Badge variant="danger">失败</Badge>
            <Badge variant="outline">项目会话</Badge>
          </Row>
          <Row label="头像">
            {["陈思远", "林雨", "周航"].map((name) => (
              <Avatar key={name} size="lg"><AvatarFallback name={name} /></Avatar>
            ))}
          </Row>
          <Tabs defaultValue="changes">
            <TabsList>
              <TabsTrigger value="changes">改动</TabsTrigger>
              <TabsTrigger value="requirement">需求</TabsTrigger>
              <TabsTrigger value="env">环境</TabsTrigger>
            </TabsList>
            <TabsContent value="changes" className="pt-3 text-small text-muted-foreground">相对会话开始前修改了 4 个文件。</TabsContent>
            <TabsContent value="requirement" className="pt-3 text-small text-muted-foreground">开工后需求有 1 处更新。</TabsContent>
            <TabsContent value="env" className="pt-3 text-small text-muted-foreground">~/code/order-center · main</TabsContent>
          </Tabs>
        </Section>
        <Section title="会话消息流">
          <SessionStreamSample />
        </Section>
      </main>
      <Toaster />
    </div>
    </TooltipProvider>
  );
}
