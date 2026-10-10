import type { trial as zhTrial } from "../zh-CN/trial.js";

/** Parallel trials (multi-agent collaboration S10). */
export const trial: typeof zhTrial = {
  role: (others: readonly string[]) =>
    [
      "# Parallel trial",
      `This is one version of a parallel trial: the same task also went to ${others.length === 0 ? "other agents" : others.join(", ")}. Each works in its own directory and branch, and the user compares them side by side and picks one.`,
      "- Only change files in the current directory. Don't switch branches or push; SuDuo commits when a version is adopted.",
      "- When you're done, say in a paragraph how you did it, which files you changed, which tests you ran and their results, and what's left.",
      "- You can't delegate or ask others to review.",
    ].join("\n"),
  title: (agent: string, task: string) => `Trial · ${agent}: ${task}`,
  commitMessage: (label: string | null, agent: string, task: string) => `SuDuo trial: ${label === null ? "" : `${label} · `}${agent}\n\n${task}`,
  mergeMessage: (label: string | null, agent: string, branch: string) => `Merge SuDuo trial (${label === null ? "" : `${label} · `}${agent}): ${branch}`,
  notGitRepo: "This project directory isn't a git repository, so separate working directories can't be created. Set up version control in project settings first.",
  agentCount: (min: number, max: number) => `Pick ${String(min)}–${String(max)} agents for a parallel trial.`,
  taskMissing: "The task description is missing.",
  agentIdMissing: "Every version needs an agent.",
  entryNotFound: "That trial version doesn't exist.",
  notFound: "That trial doesn't exist.",
  worktreeFailed: (message: string) => `Couldn't create the working directory: ${message}`,
  setupFailed: "The setup command failed, so this version didn't start (see the setup output).",
  sessionFailed: (message: string) => `Couldn't start the session: ${message}`,
  sendFailed: (message: string) => `The task wasn't sent: ${message}. Open this version's session to send it again.`,
  prepareFailed: (message: string) => `Something went wrong while preparing: ${message}`,
  restartInterrupted: "The local service restarted before it was ready",
  projectMissing: "The local project this trial started from can't be found (its folder link may have changed), so git can't run in the original directory.",
  noWorktree: "This version has no working directory (it wasn't created or was already deleted), so it can't be adopted.",
  cleanupBusy: "This version's directory is still in use (its session, or a review or continuation started from it, is still running), so it wasn't cleaned up. Stop it first, then clean up.",
  cleanupFailed: (message: string) => `Couldn't delete it: ${message}`,
  branchNotRemoved: (branch: string, message: string) =>
    `Branch ${branch} wasn't deleted. Git said: ${message}. If you don't need it, clean up again; the confirmation will say it's a force delete and unmerged commits will be lost.`,
  branchNeedsConfirm: (branch: string) => `Branch ${branch} has unmerged commits and force-deleting it wasn't confirmed, so it was kept. To delete it, open the cleanup confirmation again (it will say unmerged commits will be lost).`,
  adoptCommitFailed: (message: string) => `Couldn't commit on this version's branch: ${message}`,
};
