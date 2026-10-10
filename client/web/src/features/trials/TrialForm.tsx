import { useQuery } from "@tanstack/react-query";
import type { TrialPrecheckDto, TrialTarget } from "@suduo/client-contracts";
import { useState } from "react";
import { api } from "../../api/client.js";
import { classifyFailure } from "../../feedback/classify.js";
import { InlineError } from "../../feedback/components/index.js";
import { reportFailure } from "../../feedback/report.js";
import { useT } from "../../i18n/provider.js";
import { showMessage } from "../../ui/message.js";
import { isUsable, localAgentsQuery } from "../agents/queries.js";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

const MIN = 2;
const MAX = 3;

/**
 * 并行试做的表单（多 Agent 协作 S10，需求 4.5），在「开始会话」对话框里：选 2–3 个 Agent、写任务说明、
 * 工作目录准备命令（按项目记住）；不是 git 仓库时说明做不了；原目录有未提交的改动时提示「试做基于最近一次提交」
 * 并给「先存检查点」（告知，不拦）。
 */
export function TrialForm({ target, onBack, onStarted }: { target: TrialTarget; onBack(): void; onStarted(trialId: string): void }) {
  const t = useT();
  const text = t.collab.trial;
  const agents = useQuery(localAgentsQuery);
  const precheck = useQuery({ queryKey: ["trial-precheck", target], queryFn: () => api.trialPrecheck(target), staleTime: 0 });
  const usable = (agents.data?.agents ?? []).filter(isUsable);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [task, setTask] = useState("");
  const [setup, setSetup] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [checkpointing, setCheckpointing] = useState(false);
  const [error, setError] = useState<ReturnType<typeof classifyFailure> | null>(null);
  const check: TrialPrecheckDto | undefined = precheck.data;
  const setupValue = setup ?? check?.setupCommand ?? "";
  const toggle = (agentId: string, on: boolean) =>
    setChosen((current) => (on ? (current.length >= MAX ? current : [...current, agentId]) : current.filter((id) => id !== agentId)));
  const ready = check?.isGitRepo === true && chosen.length >= MIN && chosen.length <= MAX && task.trim() !== "";
  const start = async () => {
    if (!ready) return;
    setStarting(true);
    setError(null);
    try {
      const trial = await api.startTrial({ target, agents: chosen.map((agentId) => ({ agentId })), task: task.trim(), setupCommand: setupValue });
      onStarted(trial.id);
    } catch (cause) {
      setError(classifyFailure(cause));
    } finally {
      setStarting(false);
    }
  };
  const checkpoint = async () => {
    if (check === undefined) return;
    setCheckpointing(true);
    try {
      await api.gitCheckpoint(check.localProjectId);
      showMessage(text.checkpointed, "success");
      await precheck.refetch();
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: text.checkpointFailed });
    } finally {
      setCheckpointing(false);
    }
  };
  if (precheck.isPending || agents.isPending) {
    return (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    );
  }
  return (
    <>
      <div className="flex flex-col gap-4" data-testid="trial-form">
        <p className="m-0 text-small text-muted-foreground">{text.description}</p>
        {precheck.isError ? <InlineError kind={classifyFailure(precheck.error).kind}>{classifyFailure(precheck.error).message}</InlineError> : null}
        {check?.isGitRepo === false ? (
          <p className="m-0 rounded-md bg-warning-soft px-3 py-2 text-small text-foreground" data-testid="trial-not-git">
            {text.notGitRepo}
          </p>
        ) : null}
        {check?.dirty === true ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-small text-foreground" data-testid="trial-dirty">
            <span className="min-w-0 flex-1">{text.dirty}</span>
            <Button size="sm" variant="secondary" loading={checkpointing} onClick={() => void checkpoint()} data-testid="trial-checkpoint">
              {text.checkpoint}
            </Button>
          </div>
        ) : null}
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1 flex w-full items-center justify-between text-small font-medium text-foreground">
            <span>{text.agents}</span>
            <span className="text-caption font-normal text-subtle-foreground">{text.agentsHint(chosen.length)}</span>
          </legend>
          {usable.map((agent) => {
            const id = `trial-agent-${agent.id}`;
            const checked = chosen.includes(agent.id);
            return (
              <span key={agent.id} className="flex items-center gap-2 text-small">
                <Checkbox
                  id={id}
                  checked={checked}
                  disabled={!checked && chosen.length >= MAX}
                  onCheckedChange={(value) => toggle(agent.id, value === true)}
                  data-testid="trial-agent"
                  data-agent-id={agent.id}
                />
                <label htmlFor={id} className="cursor-pointer text-foreground">
                  {agent.displayName}
                </label>
              </span>
            );
          })}
        </fieldset>
        <label className="flex flex-col gap-1.5 text-small">
          <span className="font-medium text-foreground">{text.task}</span>
          <Textarea value={task} rows={4} maxLength={8000} placeholder={text.taskPlaceholder} onChange={(event) => setTask(event.target.value)} data-testid="trial-task" />
        </label>
        <label className="flex flex-col gap-1.5 text-small">
          <span className="font-medium text-foreground">{text.setup}</span>
          <Input value={setupValue} placeholder={text.setupPlaceholder} onChange={(event) => setSetup(event.target.value)} className="font-mono" data-testid="trial-setup" />
        </label>
        {error === null ? null : <InlineError kind={error.kind}>{text.startFailed(error.message)}</InlineError>}
      </div>
      <DialogFooter>
        <Button variant="secondary" disabled={starting} onClick={onBack}>
          {text.back}
        </Button>
        <Button variant="primary" disabled={!ready} loading={starting} onClick={() => void start()} data-testid="trial-start">
          {text.start}
        </Button>
      </DialogFooter>
    </>
  );
}
