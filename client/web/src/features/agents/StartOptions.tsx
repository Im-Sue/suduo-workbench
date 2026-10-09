import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { AgentDto, ApprovalMode, RuntimeApprovalMode, SessionStartOptions } from "@suduo/client-contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmDialog } from "../../feedback/components/index.js";
import { useT } from "../../i18n/provider.js";
import { effortName, offeredEfforts } from "../sessions/SessionModelSwitcher.js";
import { localSettingsQuery } from "../settings/queries.js";
import { agentModelsQuery, isUsable, localAgentsQuery, preferredAgent } from "./queries.js";

const MODES: readonly ApprovalMode[] = ["ask", "auto", "full"];
const RANK: Record<ApprovalMode, number> = { ask: 0, auto: 1, full: 2 };
/** 选择器里「跟随默认」的值（Select 不收空字符串）。 */
const DEFAULT_VALUE = "__default__";

/**
 * 开工时的选择（需求 4.2）：用哪家 Agent、权限档位、模型与推理强度。默认选上次用的 Agent（没有就用设置里的默认），
 * 只能选能用的 Agent，不能用的灰显并写明原因；档位、模型选项来自所选 Agent。
 */
export function StartOptions({
  onChange,
  onNavigate,
  avoidAgentId,
}: {
  onChange(options: SessionStartOptions & { agentId: string } | null): void;
  /** 点「管理 Agent」离开对话框前（对话框要先关掉，不然会盖在设置页上）。 */
  onNavigate(): void;
  /** 默认尽量不选这一家（交给另一个 Agent 接着做时是原会话的 Agent）；只有它能用时照样选它。 */
  avoidAgentId?: string;
}) {
  const t = useT();
  const text = t.agents.picker;
  const agents = useQuery(localAgentsQuery);
  const settings = useQuery(localSettingsQuery);
  const list = agents.data?.agents.filter((agent) => agent.runtimeAvailable) ?? [];
  const [agentId, setAgentId] = useState<string | null>(null);
  /** 用户自己选的档；null = 没动过，按设置里的默认档（服务端按部署上限裁剪）。 */
  const [mode, setMode] = useState<RuntimeApprovalMode | null>(null);
  const [confirmFull, setConfirmFull] = useState(false);
  const [model, setModel] = useState<string>(DEFAULT_VALUE);
  const [effort, setEffort] = useState<string>(DEFAULT_VALUE);

  // 第一次拿到列表时按「上次用的 → 默认 → 第一家能用的」选上。
  useEffect(() => {
    if (agentId !== null || agents.data === undefined) return;
    const preferred = preferredAgent(agents.data.agents, agents.data.defaultAgentId);
    const other =
      avoidAgentId !== undefined && preferred?.id === avoidAgentId
        ? agents.data.agents.find((candidate) => candidate.runtimeAvailable && isUsable(candidate) && candidate.id !== avoidAgentId)
        : undefined;
    const chosen = other ?? preferred;
    if (chosen !== null) setAgentId(chosen.id);
  }, [agentId, agents.data, avoidAgentId]);

  const agent = list.find((candidate) => candidate.id === agentId) ?? null;
  const models = useQuery({ ...agentModelsQuery(agentId ?? ""), enabled: agentId !== null });
  const modelItems = models.data?.items ?? [];
  const chosenModel = modelItems.find((item) => item.model === model) ?? null;
  // 与会话里的模型切换一致：不给会卡住回合的档位（offeredEfforts）。
  const efforts = useMemo(() => offeredEfforts(chosenModel?.supportedReasoningEfforts ?? []), [chosenModel]);
  // 部署设了上限时，超过上限的档不能选，默认档也按上限显示（与服务端裁剪一致）。
  const cap = settings.data?.approvalModeLocked === true ? (settings.data.maxApprovalMode ?? null) : null;
  const capped = (candidate: ApprovalMode): ApprovalMode => (cap !== null && RANK[candidate] > RANK[cap] ? cap : candidate);
  const defaultMode: RuntimeApprovalMode = capped(settings.data?.defaultApprovalMode ?? "ask");
  const effectiveMode = mode ?? defaultMode;
  const readOnlyCapable = agent?.readOnlyCapable === true;
  const modes = useMemo<readonly RuntimeApprovalMode[]>(() => (readOnlyCapable ? ["readonly", ...MODES] : MODES), [readOnlyCapable]);
  const blocked = (candidate: RuntimeApprovalMode) => candidate !== "readonly" && cap !== null && RANK[candidate] > RANK[cap];

  const options = useMemo(() => {
    if (agent === null || !isUsable(agent)) return null;
    return {
      agentId: agent.id,
      // 没动过就不发：服务端用设置里的默认档并按上限裁剪（设置还没加载完也不会被覆盖成「每步确认」）。
      ...(mode === null || !modes.includes(mode) ? {} : { approvalMode: mode }),
      model: model === DEFAULT_VALUE ? null : model,
      reasoningEffort: effort === DEFAULT_VALUE || !efforts.includes(effort) ? null : effort,
    };
  }, [agent, modes, mode, model, effort, efforts]);

  // 只在选择的值变了时告诉对话框（父组件存下来会让这里重绘，按引用比较会来回触发）。
  const reported = useRef<string | null>(null);
  useEffect(() => {
    const key = JSON.stringify(options);
    if (key === reported.current) return;
    reported.current = key;
    onChange(options);
  }, [onChange, options]);

  if (agents.isPending) {
    return (
      <div className="flex flex-col gap-2 py-1" aria-busy="true">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-2/3" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="start-options">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="start-agent">{text.agent}</Label>
          <Link to="/settings/$section" params={{ section: "agents" }} onClick={onNavigate} className="inline-flex items-center gap-1 text-caption text-primary-text hover:underline">
            {text.manage}
            <ExternalLinkIcon className="size-3" aria-hidden="true" />
          </Link>
        </div>
        <Select
          {...(agentId === null ? {} : { value: agentId })}
          onValueChange={(value) => {
            setAgentId(value);
            setModel(DEFAULT_VALUE);
            setEffort(DEFAULT_VALUE);
            // 换成做不到只读的 Agent：放下「只读」，回到默认档（显示与提交一致）。
            if (mode === "readonly" && list.find((candidate) => candidate.id === value)?.readOnlyCapable !== true) setMode(null);
          }}
        >
          <SelectTrigger id="start-agent" data-testid="start-agent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {list.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id} disabled={!isUsable(candidate)} data-testid={`start-agent-${candidate.id}`}>
                <AgentOption agent={candidate} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="start-permission">{text.permission}</Label>
        <Select
          value={effectiveMode}
          onValueChange={(value) => {
            // 完全访问不再询问任何操作：与会话里切换一样先确认一次。
            if (value === "full" && effectiveMode !== "full") setConfirmFull(true);
            else setMode(value as RuntimeApprovalMode);
          }}
        >
          <SelectTrigger id="start-permission" data-testid="start-permission">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modes.map((candidate) => (
              <SelectItem key={candidate} value={candidate} disabled={blocked(candidate)}>
                {t.settingsAgent.execution.modes[candidate].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="m-0 text-caption text-subtle-foreground">{t.workbench.approvalMode.descriptions[effectiveMode]}</p>
        {agent?.id === "claude-code" && effectiveMode !== "readonly" ? (
          <p className="m-0 text-caption text-subtle-foreground">{text.projectSettingsNote}</p>
        ) : null}
      </div>

      {modelItems.length === 0 ? null : (
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="start-model">{text.model}</Label>
            <Select
              value={model}
              onValueChange={(value) => {
                setModel(value);
                setEffort(DEFAULT_VALUE);
              }}
            >
              <SelectTrigger id="start-model" data-testid="start-model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_VALUE}>{text.modelDefault}</SelectItem>
                {modelItems.map((item) => (
                  <SelectItem key={item.id} value={item.model}>
                    {item.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {efforts.length === 0 ? null : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="start-effort">{text.effort}</Label>
              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger id="start-effort" data-testid="start-effort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_VALUE}>{text.effortDefault}</SelectItem>
                  {efforts.map((value) => (
                    <SelectItem key={value} value={value}>
                      {effortName(value, t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmFull}
        onOpenChange={setConfirmFull}
        title={t.workbench.approvalMode.fullConfirm.title}
        description={t.workbench.approvalMode.fullConfirm.description}
        confirmLabel={t.workbench.approvalMode.fullConfirm.confirm}
        onConfirm={() => {
          setConfirmFull(false);
          setMode("full");
        }}
      />
    </div>
  );
}

function AgentOption({ agent }: { agent: AgentDto }) {
  const t = useT();
  const status = t.agents.section.status[agent.status];
  return (
    <span className="inline-flex items-center gap-1.5">
      {agent.displayName}
      {agent.status === "checking" ? <Spinner size="sm" /> : null}
      {isUsable(agent) || agent.status === "checking" ? null : <span className="text-subtle-foreground">{t.agents.picker.unavailable(status)}</span>}
    </span>
  );
}

/** 开工对话框要不要先让人选：能用（或还在检测）的 Agent 不止一家时才问；只有一家就直接用它。 */
export function needsAgentChoice(agents: readonly AgentDto[]): boolean {
  return agents.filter((agent) => agent.runtimeAvailable && (isUsable(agent) || agent.status === "checking")).length > 1;
}
