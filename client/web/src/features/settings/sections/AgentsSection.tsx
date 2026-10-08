import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentActionDto, AgentDto, AgentStatus } from "@suduo/client-contracts";
import { CopyIcon, ExternalLinkIcon, RotateCwIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "../../../api/client.js";
import { RegionError } from "../../../feedback/components/index.js";
import { reportFailure } from "../../../feedback/report.js";
import { useT } from "../../../i18n/provider.js";
import { showMessage } from "../../../ui/message.js";
import { isUsable, localAgentsKey, localAgentsQuery } from "../../agents/queries.js";
import { ItemList, ItemRow, rowLabelId, SaveStatus, SectionSkeleton, SettingsRow, SettingsSection, StatusPill, useSaveIndicator } from "../components/kit.js";
import { useQueryFailure } from "../use-query-failure.js";

const STATUS_TONE: Record<AgentStatus, "success" | "warning" | "danger" | "neutral"> = {
  checking: "neutral",
  ready: "success",
  installed: "success",
  not_installed: "neutral",
  auth_required: "warning",
  version_unsupported: "warning",
  error: "danger",
};

/** 设置 › AI Agent（需求 4.1）：本机能用哪些 Agent、怎么装、怎么登录，新会话默认用哪家。 */
export function AgentsSection() {
  const t = useT();
  const text = t.agents.section;
  const queryClient = useQueryClient();
  const agents = useQuery(localAgentsQuery);
  const failure = useQueryFailure(agents);
  const [defaultSaved, trackDefault] = useSaveIndicator();
  const [rechecking, setRechecking] = useState<ReadonlySet<string>>(new Set());

  const recheck = async (ids: readonly string[]) => {
    setRechecking(new Set(ids));
    try {
      await Promise.all(ids.map((id) => api.recheckAgent(id)));
    } catch (cause) {
      reportFailure(cause, { surface: "action" });
    } finally {
      setRechecking(new Set());
      await queryClient.invalidateQueries({ queryKey: localAgentsKey });
    }
  };

  const setDefault = (agentId: string) =>
    trackDefault(
      api.updateAgentSettings({ defaultAgentId: agentId }).then(() => queryClient.invalidateQueries({ queryKey: localAgentsKey })),
    );

  if (agents.isPending) {
    return (
      <SettingsSection id="agents" description={text.description}>
        <SectionSkeleton rows={4} label={text.listLabel} />
      </SettingsSection>
    );
  }
  if (agents.isError) {
    return (
      <SettingsSection id="agents" description={text.description}>
        <RegionError kind={failure?.kind ?? "unknown"} message={failure?.message ?? ""} busy={agents.isFetching} onRetry={() => void agents.refetch()} />
      </SettingsSection>
    );
  }

  const list = agents.data.agents;
  const usable = list.filter(isUsable);
  return (
    <SettingsSection
      id="agents"
      description={text.description}
      actions={
        <Button variant="secondary" size="sm" loading={rechecking.size > 1} onClick={() => void recheck(list.map((agent) => agent.id))} data-testid="agents-recheck-all">
          <RotateCwIcon />
          {text.recheckAll}
        </Button>
      }
    >
      <SettingsRow anchor="agents-default" title={text.defaultTitle} description={text.defaultDescription} status={<SaveStatus state={defaultSaved} />}>
        <Select value={agents.data.defaultAgentId} onValueChange={setDefault}>
          <SelectTrigger className="w-64" aria-labelledby={rowLabelId("agents-default")} data-testid="agents-default">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {list.map((agent) => (
              <SelectItem key={agent.id} value={agent.id} disabled={!isUsable(agent) && agent.id !== agents.data.defaultAgentId}>
                {agent.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>

      <SettingsRow anchor="agents-list" title={text.listTitle} stacked>
        <ItemList label={text.listLabel} data-testid="agents-list">
          {list.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              isDefault={agent.id === agents.data.defaultAgentId}
              canBeDefault={usable.includes(agent)}
              rechecking={rechecking.has(agent.id)}
              onRecheck={() => void recheck([agent.id])}
              onSetDefault={() => setDefault(agent.id)}
            />
          ))}
        </ItemList>
        <p className="m-0 text-caption text-subtle-foreground">{text.termsNote}</p>
      </SettingsRow>
    </SettingsSection>
  );
}

function AgentRow({
  agent,
  isDefault,
  canBeDefault,
  rechecking,
  onRecheck,
  onSetDefault,
}: {
  agent: AgentDto;
  isDefault: boolean;
  canBeDefault: boolean;
  rechecking: boolean;
  onRecheck(): void;
  onSetDefault(): void;
}) {
  const t = useT();
  const text = t.agents.section;
  const detail =
    agent.status === "installed"
      ? agent.reasonCode === null
        ? text.installedHint
        : `${text.reason[agent.reasonCode]} · ${text.installedHint}`
      : agent.status === "version_unsupported" && agent.minVersion !== null
        ? text.minVersion(agent.minVersion)
        : agent.reasonCode !== null && agent.status !== "ready"
          ? text.reason[agent.reasonCode]
          : null;
  const meta = [text.channel[agent.channel], agent.version === null ? null : text.version(agent.version)].filter((part) => part !== null).join(" · ");
  return (
    <ItemRow data-testid={`agent-row-${agent.id}`}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body font-medium text-foreground">{agent.displayName}</span>
          <StatusPill tone={STATUS_TONE[agent.status]}>{text.status[agent.status]}</StatusPill>
          {isDefault ? <StatusPill tone="neutral">{text.defaultBadge}</StatusPill> : null}
        </div>
        <span className="text-caption text-subtle-foreground" title={agent.channel === "acp" ? text.channelHint : undefined}>
          {meta}
          {detail === null ? null : ` · ${detail}`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {agent.actions.map((action) => (
          <AgentAction key={action.kind} agentId={agent.id} action={action} rechecking={rechecking} onRecheck={onRecheck} />
        ))}
        {agent.termsUrl === null ? null : (
          <Button variant="ghost" size="sm" asChild>
            <a href={agent.termsUrl} target="_blank" rel="noreferrer">
              {text.actions.open_terms}
              <ExternalLinkIcon />
            </a>
          </Button>
        )}
        {!isDefault && canBeDefault ? (
          <Button variant="ghost" size="sm" onClick={onSetDefault} data-testid={`agent-set-default-${agent.id}`}>
            {text.setDefault}
          </Button>
        ) : null}
      </div>
    </ItemRow>
  );
}

function AgentAction({ agentId, action, rechecking, onRecheck }: { agentId: string; action: AgentActionDto; rechecking: boolean; onRecheck(): void }) {
  const text = useT().agents.section;
  switch (action.kind) {
    case "copy_install_command":
      return (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void navigator.clipboard
              .writeText(action.command ?? "")
              .then(() => showMessage(text.copied, "success"))
              .catch((cause: unknown) => reportFailure(cause, { surface: "action" }));
          }}
        >
          <CopyIcon />
          {text.actions.copy_install_command}
        </Button>
      );
    case "open_terminal_login":
      return (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void api
              .loginAgent(agentId)
              .then((result) => showMessage(result.opened ? text.loginOpened : text.loginManual(result.command), result.opened ? "success" : "info"))
              .catch((cause: unknown) => reportFailure(cause, { surface: "action" }));
          }}
        >
          <TerminalIcon />
          {text.actions.open_terminal_login}
        </Button>
      );
    case "recheck":
      return (
        <Button variant="ghost" size="sm" loading={rechecking} onClick={onRecheck}>
          <RotateCwIcon />
          {text.actions.recheck}
        </Button>
      );
    case "open_homepage":
      return (
        <Button variant="ghost" size="sm" asChild>
          <a href={action.url} target="_blank" rel="noreferrer">
            {text.actions.open_homepage}
            <ExternalLinkIcon />
          </a>
        </Button>
      );
  }
}
