import { CircleCheckIcon, XCircleIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { classifyFailure } from "../../../feedback/classify.js";
import { FEEDBACK_TIMING_MS } from "../../../feedback/routes.js";

/**
 * 统一的「测试连接」（技术设计 §7 设置：测试连接统一组件）。
 * 结果分两种样式：成功一行绿字；失败用浅红底块写清原因，再给一句建议和可选的修复入口。
 */
export type TestOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: string; suggestion?: string; action?: { label: string; onClick(): void } };

type Phase = { phase: "idle" } | { phase: "testing" } | { phase: "done"; outcome: TestOutcome };

export function TestConnection({
  run,
  resetKey,
  disabledReason,
  label = "测试连接",
  hint,
  onTestingChange,
}: {
  run(): Promise<TestOutcome>;
  /** 变化时清掉上一次的结果（例如草稿改了）。 */
  resetKey?: string;
  /** 给出时按钮禁用并在悬停时说明原因。 */
  disabledReason?: string;
  label?: string;
  hint?: ReactNode;
  onTestingChange?(testing: boolean): void;
}) {
  const [state, setState] = useState<Phase>({ phase: "idle" });
  const [still, setStill] = useState(false);
  const runId = useRef(0);
  const testing = state.phase === "testing";
  const notify = useRef(onTestingChange);
  notify.current = onTestingChange;
  useEffect(() => notify.current?.(testing), [testing]);

  useEffect(() => {
    runId.current += 1;
    setState({ phase: "idle" });
  }, [resetKey]);

  useEffect(() => {
    if (state.phase !== "testing") {
      setStill(false);
      return;
    }
    const timer = window.setTimeout(() => setStill(true), FEEDBACK_TIMING_MS.stillProcessing);
    return () => window.clearTimeout(timer);
  }, [state.phase]);

  const start = async () => {
    const id = ++runId.current;
    setState({ phase: "testing" });
    let outcome: TestOutcome;
    try {
      outcome = await run();
    } catch (cause) {
      outcome = { ok: false, reason: classifyFailure(cause).message };
    }
    if (id === runId.current) setState({ phase: "done", outcome });
  };

  const outcome = state.phase === "done" ? state.outcome : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          loading={state.phase === "testing"}
          disabled={disabledReason !== undefined}
          {...(disabledReason === undefined ? {} : { disabledReason })}
          onClick={() => void start()}
        >
          {label}
        </Button>
        {state.phase === "testing" && still ? (
          <span className="text-caption text-subtle-foreground" role="status">
            仍在测试…
          </span>
        ) : null}
        {hint === undefined || outcome !== null ? null : <span className="text-caption text-subtle-foreground">{hint}</span>}
      </div>
      <div aria-live="polite">
        {outcome === null ? null : outcome.ok ? (
          <p
            className="m-0 flex items-start gap-1.5 text-small text-success"
            data-testid="settings-test-result"
            data-result="success"
          >
            <CircleCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{outcome.text}</span>
          </p>
        ) : (
          <div
            className="flex flex-col gap-1 rounded-md bg-danger-soft px-3 py-2.5"
            data-testid="settings-test-result"
            data-result="failure"
          >
            <p className="m-0 flex items-start gap-1.5 text-small text-danger">
              <XCircleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>{outcome.reason}</span>
            </p>
            {outcome.suggestion === undefined ? null : (
              <p className="m-0 pl-[22px] text-small text-muted-foreground">{outcome.suggestion}</p>
            )}
            {outcome.action === undefined ? null : (
              <div className="pl-[22px]">
                <Button size="sm" type="button" onClick={outcome.action.onClick}>
                  {outcome.action.label}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 计时：「连接正常 · 42 毫秒」。 */
export async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await work();
  return { value, ms: Math.max(1, Math.round(performance.now() - started)) };
}

export function formatMs(ms: number): string {
  return ms < 1_000 ? `${ms} 毫秒` : `${(ms / 1_000).toFixed(1)} 秒`;
}
