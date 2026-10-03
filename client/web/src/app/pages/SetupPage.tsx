import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  RotateCwIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, type RequirementsProjectDto } from "../../api/client.js";
import { classifyFailure } from "../../feedback/classify.js";
import { InlineError } from "../../feedback/components/index.js";
import type { Failure } from "../../feedback/types.js";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioCard, RadioGroup } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { rememberProjectId } from "../project-context.js";
import { projectsQuery, queryKeys, settingsQuery } from "../queries.js";
import { summarizeDoctor, type SummaryStatus } from "./doctor-summary.js";
import { recordEnvironmentPending, recordMappingPending } from "./setup-pending.js";
import { LoginForm } from "./LoginForm.js";

/**
 * 首启向导（需求 §4.2）：连接服务 → 登录 → 环境检查 → 关联项目代码 → 完成。
 * 当前步骤写在 URL（?step=），刷新后回到同一步；已完成的前置步骤会自动跳过。
 */
const STEPS = [
  { title: "连接需求服务", hint: "团队共享的需求在这里" },
  { title: "登录", hint: "使用团队账号" },
  { title: "检查本机环境", hint: "Codex、模型服务、网络" },
  { title: "关联项目代码", hint: "选择本机代码目录" },
  { title: "完成", hint: "开始工作" },
] as const;

export function SetupPage() {
  const search = useSearch({ strict: false }) as { step?: number };
  const navigate = useNavigate();
  const settings = useQuery(settingsQuery).data;
  const requested = search.step ?? 1;
  // 前置条件不满足时不允许跳步：未配置只能在第 1 步，未登录最多到第 2 步。
  const maxStep = settings?.configured !== true ? 1 : settings.session === null ? 2 : 5;
  const step = Math.min(requested, maxStep);
  const go = (next: number) => void navigate({ to: "/setup", search: { step: next } });

  return (
    <div className="flex min-h-dvh w-full bg-background text-foreground">
      <aside className="hidden w-[400px] shrink-0 flex-col gap-10 border-r border-border bg-card px-12 py-14 lg:flex">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-[9px] bg-foreground text-small font-semibold text-background">
            SD
          </span>
          <span className="text-page font-semibold">SuDuo</span>
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-display font-semibold">先花两分钟完成设置</h1>
          <p className="m-0 text-body text-muted-foreground">需求放在团队共享的服务上，代码和对话留在你自己的电脑里。</p>
        </div>
        <ol aria-label="设置步骤" className="m-0 flex list-none flex-col gap-1 p-0">
          {STEPS.map((item, index) => {
            const number = index + 1;
            const done = number < step;
            const current = number === step;
            return (
              <li
                key={item.title}
                aria-current={current ? "step" : undefined}
                className={cn("flex h-12 items-center gap-3 rounded-md px-3", current && "bg-muted")}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border-[1.5px] text-caption font-semibold",
                    done && "border-success bg-success text-background",
                    current && "border-primary bg-primary text-primary-foreground",
                    !done && !current && "border-border-strong text-subtle-foreground",
                  )}
                >
                  {done ? <CheckIcon className="size-3.5" strokeWidth={3} /> : number}
                </span>
                <span className="flex flex-col leading-[18px]">
                  <span className={cn("text-body", current ? "font-semibold" : "font-medium", !done && !current && "text-muted-foreground")}>
                    {item.title}
                  </span>
                  <span className="text-caption text-subtle-foreground">{item.hint}</span>
                </span>
              </li>
            );
          })}
        </ol>
        <p className="mt-auto mb-0 text-caption text-subtle-foreground">遇到问题？在「设置 › 诊断」里可以随时复查每一项。</p>
      </aside>

      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="flex w-[min(560px,100%)] flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <span className="text-caption text-subtle-foreground">第 {step} 步，共 5 步</span>
          </div>
          {step === 1 ? <ServiceStep initial={settings?.baseUrl ?? ""} onDone={(loggedIn) => go(loggedIn ? 3 : 2)} /> : null}
          {step === 2 ? <LoginStep onBack={() => go(1)} onDone={() => go(3)} /> : null}
          {step === 3 ? <EnvironmentStep onBack={() => go(2)} onDone={() => go(4)} /> : null}
          {step === 4 ? <ProjectStep onBack={() => go(3)} onDone={() => go(5)} /> : null}
          {step === 5 ? <DoneStep /> : null}
        </div>
      </main>
    </div>
  );
}

function StepHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="m-0 text-page font-semibold">{title}</h2>
      <p className="m-0 text-body text-muted-foreground">{description}</p>
    </div>
  );
}

function ServiceStep({ initial, onDone }: { initial: string; onDone(loggedIn: boolean): void }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState(initial);
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "fail"; message?: string }>({ state: "idle" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const trimmed = url.trim();

  const runTest = async () => {
    if (trimmed === "") return;
    setTest({ state: "testing" });
    try {
      const result = await api.testRequirementsSettings(trimmed);
      setTest(result.reachable ? { state: "ok", message: result.message } : { state: "fail", message: result.message });
    } catch (cause) {
      setTest({ state: "fail", message: classifyFailure(cause).message });
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.updateRequirementsSettings(trimmed);
      queryClient.setQueryData(queryKeys.settings, next);
      onDone(next.session !== null);
    } catch (cause) {
      setError(classifyFailure(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <StepHeading title="连接团队的需求服务" description="所有成员共享同一个需求服务。地址通常是一个内网网址，向团队管理员要一下。" />
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void runTest();
        }}
      >
        <Field label="服务地址">
          <div className="flex gap-2">
            <Input
              autoFocus
              className="h-(--ctl-h-lg) font-mono"
              placeholder="例如 http://192.168.1.10:4100"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setTest({ state: "idle" });
              }}
            />
            <Button type="submit" size="lg" loading={test.state === "testing"} disabled={trimmed === ""}>
              测试连接
            </Button>
          </div>
        </Field>
        <div aria-live="polite">
          {test.state === "ok" ? (
            <p className="m-0 flex items-center gap-1.5 text-small text-success">
              <CircleCheckIcon className="size-4" />
              连接正常
            </p>
          ) : null}
          {test.state === "fail" ? (
            <p className="m-0 flex items-start gap-1.5 text-small text-danger">
              <XCircleIcon className="mt-0.5 size-4 shrink-0" />
              连不上这个地址。检查地址和端口是否正确，或确认电脑已连上公司内网。
              {test.message ? <span className="text-subtle-foreground">（{test.message}）</span> : null}
            </p>
          ) : null}
        </div>
      </form>
      {error === null ? null : <InlineError kind={error.kind}>{error.message}</InlineError>}
      <div className="flex justify-end">
        <Button
          size="lg"
          variant="primary"
          loading={saving}
          disabled={test.state !== "ok"}
          disabledReason="先测试连接，确认地址可用"
          onClick={() => void save()}
        >
          下一步
        </Button>
      </div>
    </>
  );
}

function LoginStep({ onBack, onDone }: { onBack(): void; onDone(): void }) {
  return (
    <>
      <StepHeading title="登录 SuDuo" description="还没有账号的话，直接注册一个。" />
      <LoginForm onAuthenticated={onDone} />
      <div>
        <Button variant="ghost" size="lg" onClick={onBack}>
          上一步
        </Button>
      </div>
    </>
  );
}

const STATUS_ICON: Record<SummaryStatus, ReactNode> = {
  ok: <CircleCheckIcon className="size-4 text-success" />,
  warn: <AlertTriangleIcon className="size-4 text-warning" />,
  fail: <XCircleIcon className="size-4 text-danger" />,
};

function EnvironmentStep({ onBack, onDone }: { onBack(): void; onDone(): void }) {
  const doctor = useQuery({ queryKey: ["doctor"], queryFn: () => api.runDoctor(), staleTime: 0 });
  const summary = doctor.data === undefined ? [] : summarizeDoctor(doctor.data.checks);
  const problems = summary.filter((item) => item.status !== "ok").length;

  return (
    <>
      <StepHeading title="检查本机环境" description="SuDuo 在你的电脑上运行 Codex。下面几项齐了，就能开始会话。" />
      <div className="rounded-lg border border-border bg-card" role="status" aria-live="polite" aria-busy={doctor.isFetching}>
        {doctor.isPending
          ? ["codex", "model", "network", "runtime"].map((key) => (
              <div key={key} className="flex items-center gap-3 border-b border-border px-4 py-3.5 last:border-b-0">
                <Spinner className="text-subtle-foreground" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="h-2.5 w-52" />
                </div>
              </div>
            ))
          : null}
        {doctor.isError ? (
          <div className="px-4 py-4 text-small text-danger">没能完成检查：{classifyFailure(doctor.error).message}</div>
        ) : null}
        {summary.map((item) => (
          <div key={item.key} className="flex items-center gap-3 border-b border-border px-4 py-3.5 last:border-b-0">
            {STATUS_ICON[item.status]}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-body font-medium">{item.title}</span>
              <span className="text-small text-muted-foreground">{item.detail}</span>
            </div>
          </div>
        ))}
      </div>
      {doctor.data === undefined ? null : (
        <Collapsible>
          <CollapsibleTrigger className="group inline-flex items-center gap-1 text-small text-muted-foreground hover:text-foreground">
            <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
            查看全部 {doctor.data.checks.length} 项检查
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="m-0 mt-2 flex max-h-64 list-none flex-col gap-1 overflow-y-auto rounded-md bg-code-bg p-3 font-mono text-caption text-muted-foreground">
              {doctor.data.checks.map((check, index) => (
                <li key={`${check.name}-${index}`}>
                  [{check.status}] {check.name} · {check.message}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
      {problems > 0 ? (
        <Banner tone="warning">有 {problems} 项需要留意，可以先继续，稍后在「设置」里处理。</Banner>
      ) : null}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="lg" onClick={onBack}>
          上一步
        </Button>
        <div className="flex gap-2">
          <Button size="lg" loading={doctor.isFetching && !doctor.isPending} onClick={() => void doctor.refetch()}>
            <RotateCwIcon />
            重新检查
          </Button>
          <Button
            size="lg"
            variant="primary"
            disabled={doctor.isPending}
            onClick={() => {
              // 没通过的项留到「我的工作」顶部的清单里；检查没跑成就不改原来的记录。
              if (doctor.data !== undefined) recordEnvironmentPending(summary);
              onDone();
            }}
          >
            下一步
          </Button>
        </div>
      </div>
    </>
  );
}

function ProjectStep({ onBack, onDone }: { onBack(): void; onDone(): void }) {
  const queryClient = useQueryClient();
  const projects = useQuery(projectsQuery);
  const active = (projects.data ?? []).filter((project) => !project.isArchived);
  const [projectId, setProjectId] = useState<string>("");
  const [path, setPath] = useState("");
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<Failure | null>(null);

  useEffect(() => {
    if (projectId === "" && active[0] !== undefined) setProjectId(active[0].id);
  }, [active, projectId]);

  const createProject = async () => {
    if (newName.trim() === "") return;
    setCreating(true);
    setError(null);
    try {
      const created: RequirementsProjectDto = await api.createRequirementsProject({ name: newName.trim() });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      setProjectId(created.id);
      setNewName("");
    } catch (cause) {
      setError(classifyFailure(cause));
    } finally {
      setCreating(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.saveRequirementsMapping(projectId, path.trim());
      recordMappingPending(false);
      rememberProjectId(projectId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      onDone();
    } catch (cause) {
      setError(classifyFailure(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <StepHeading
        title="选择项目，关联你的代码"
        description="选一个你参与的项目，告诉 SuDuo 它的代码在你电脑的哪个目录。其他项目以后用到时再关联。"
      />
      {projects.isPending ? <Skeleton className="h-32" /> : null}
      {projects.data !== undefined && active.length === 0 ? (
        <form
          className="flex flex-col gap-3 rounded-lg border border-dashed border-border-strong p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void createProject();
          }}
        >
          <span className="text-small text-muted-foreground">团队里还没有项目。先建一个：</span>
          <div className="flex gap-2">
            <Input aria-label="项目名称" placeholder="例如：订单中心" value={newName} onChange={(event) => setNewName(event.target.value)} />
            <Button type="submit" loading={creating} disabled={newName.trim() === ""}>
              新建项目
            </Button>
          </div>
        </form>
      ) : null}
      {active.length > 0 ? (
        <RadioGroup aria-label="项目" value={projectId} onValueChange={setProjectId} className="max-h-64 overflow-y-auto">
          {active.map((project) => (
            <RadioCard key={project.id} value={project.id} title={project.name} description={`由 ${project.createdBy.displayName} 创建`} />
          ))}
        </RadioGroup>
      ) : null}
      <Field label="代码目录" hint="填写绝对路径，例如 /Users/you/code/order-center。SuDuo 需要能读写这个目录。">
        <Input className="font-mono" placeholder="/Users/you/code/项目目录" value={path} onChange={(event) => setPath(event.target.value)} />
      </Field>
      {error === null ? null : <InlineError kind={error.kind}>{error.message}</InlineError>}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="lg" onClick={onBack}>
          上一步
        </Button>
        <div className="flex gap-2">
          <Button
            size="lg"
            variant="ghost"
            onClick={() => {
              recordMappingPending(true);
              onDone();
            }}
          >
            稍后再关联
          </Button>
          <Button
            size="lg"
            variant="primary"
            loading={saving}
            disabled={projectId === "" || path.trim() === ""}
            disabledReason="先选项目并填写代码目录"
            onClick={() => void save()}
          >
            关联并继续
          </Button>
        </div>
      </div>
    </>
  );
}

function DoneStep() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-start gap-5">
      <span className="flex size-12 items-center justify-center rounded-full bg-success-soft text-success">
        <CheckIcon className="size-6" strokeWidth={2.4} />
      </span>
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-display font-semibold">一切就绪</h2>
        <p className="m-0 text-body text-muted-foreground">可以开始了。以后需要调整，随时到「设置」里改。</p>
      </div>
      <Button size="lg" variant="primary" onClick={() => void navigate({ to: "/my" })}>
        进入我的工作
      </Button>
    </div>
  );
}
