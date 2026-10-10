import type { HandoffContent, ReviewReportContent, SharedItemContent, SharedItemKind, SnapshotContent } from "@suduo/cloud-contracts";
import { useT } from "../../i18n/provider.js";
import { Markdown } from "../../ui/markdown.js";

/**
 * 共享对象的内容（多 Agent 协作 S11）：发布对话框的预览与需求里的查看共用这一份，预览即所发——评审的建议、
 * 快照的命令也都显示出来。
 */
export function SharedContentView({ kind, content }: { kind: SharedItemKind; content: SharedItemContent }) {
  const t = useT();
  const text = t.collab.share;
  if (kind === "handoff") {
    const handoff = content as HandoffContent;
    const list = (heading: string, lines: readonly string[]) =>
      lines.length === 0 ? null : (
        <div className="flex flex-col gap-0.5">
          <span className="text-caption font-medium text-muted-foreground">{heading}</span>
          <ul className="m-0 pl-4">
            {lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </div>
      );
    return (
      <div className="flex flex-col gap-2 text-small" data-testid="shared-content">
        <Markdown text={handoff.summary} />
        {list(text.dialog.decisions, handoff.decisions)}
        {list(text.dialog.todo, handoff.todo)}
        {list(text.dialog.risks, handoff.risks)}
        {handoff.branch === null ? null : <p className="m-0 font-mono text-caption">{handoff.branch}</p>}
        {list(text.dialog.files, handoff.files)}
      </div>
    );
  }
  if (kind === "review") {
    const review = content as ReviewReportContent;
    return (
      <div className="flex flex-col gap-2 text-small" data-testid="shared-content">
        <p className="m-0 whitespace-pre-wrap text-foreground">{review.summary}</p>
        <p className="m-0 text-caption text-muted-foreground">{text.dialog.findings(review.findings.length)}</p>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {review.findings.map((finding, index) => (
            <li key={index} className="rounded-sm bg-muted px-2 py-1.5">
              <span className="font-medium text-foreground">
                [{t.collab.review.severity[finding.severity] ?? finding.severity}] {finding.title}
              </span>
              {finding.file === null ? null : (
                <span className="ml-1 font-mono text-caption text-muted-foreground">{finding.line === null ? finding.file : `${finding.file}:${String(finding.line)}`}</span>
              )}
              <p className="m-0 mt-0.5 whitespace-pre-wrap text-caption text-muted-foreground">{finding.detail}</p>
              {finding.suggestion === null ? null : <p className="m-0 mt-0.5 whitespace-pre-wrap text-caption text-foreground">{finding.suggestion}</p>}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const snapshot = content as SnapshotContent;
  return (
    <div className="flex flex-col gap-2 text-small" data-testid="shared-content">
      <p className="m-0 text-caption text-muted-foreground">{text.dialog.rounds(snapshot.rounds.length)}</p>
      {snapshot.rounds.map((round, index) => (
        <div key={index} className="flex flex-col gap-1 rounded-sm bg-muted px-2 py-1.5">
          <p className="m-0 whitespace-pre-wrap font-medium text-foreground">{round.userText}</p>
          {round.answer === null ? null : <Markdown text={round.answer} />}
          {round.files.length === 0 ? null : <p className="m-0 font-mono text-caption text-subtle-foreground">{round.files.join(" · ")}</p>}
          {round.commands.length === 0 ? null : (
            <ul className="m-0 list-none p-0 font-mono text-caption text-muted-foreground">
              {round.commands.map((command, commandIndex) => (
                <li key={commandIndex} className="break-all">
                  $ {command.command}
                  {command.exitCode === null ? "" : ` (${String(command.exitCode)})`}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
