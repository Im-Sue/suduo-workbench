import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import type { GateCStepContext } from "./types.js";

export async function pickSkill(page: Page, name: string): Promise<void> {
  const input = page.getByTestId("message-input");
  await input.click();
  await page.keyboard.type("/" + name);
  await page.getByTestId("palette-item").first().waitFor();
  await page.keyboard.press("Enter");
  await page.getByTestId("skill-chip").waitFor();
}

export async function pasteTinyPng(page: Page): Promise<void> {
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  await page.getByTestId("message-input").evaluate((element, value) => {
    const binary = atob(String(value));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const file = new File([bytes], "pasted.png", { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  }, base64);
}

/**
 * 走完 P2 的「开始会话」对话框，返回新会话 id（取自 `/sessions/<id>` 路由）。
 *
 * 对话框按情况分步：检查 →（这条需求已有会话）选「新开一个会话」→（项目还没关联本机
 * 代码目录）手动输入 `projectRoot`，等到「可以读写」再「使用这个目录」→ 准备 → 进入会话。
 * 哪一步出现取决于前序步骤建立的状态，所以这里按页面实际状态推进，而不是写死顺序。
 * 文字按这一轮的界面语言从前端字典取（`context.ui`），中英两种验收共用。
 */
export async function completeStartSessionDialog(
  context: Pick<GateCStepContext, "page" | "projectRoot" | "ui">,
  timeoutMs = 180_000,
): Promise<string> {
  const page = context.page;
  const text = context.ui.startSession;
  const dialog = page.getByTestId("start-session-dialog");
  await dialog.waitFor({ timeout: 20_000 });
  const directoryTitle = dialog.getByRole("heading", { name: text.directoryTitle });
  const startNew = dialog.getByRole("button", { name: text.createNew });
  const failed = dialog.getByText(text.failed, { exact: false });
  const deadline = Date.now() + timeoutMs;
  let directoryDone = false;
  let choseNew = false;
  while (Date.now() < deadline) {
    const match = /^\/sessions\/([^/]+)$/u.exec(new URL(page.url()).pathname);
    if (match?.[1]) return decodeURIComponent(match[1]);
    if (await failed.isVisible().catch(() => false)) {
      throw new Error("开始会话失败：" + ((await failed.textContent()) ?? ""));
    }
    if (!directoryDone && (await directoryTitle.isVisible().catch(() => false))) {
      directoryDone = true;
      await dialog.getByRole("button", { name: text.manual }).click();
      await dialog.getByLabel(text.manualLabel).fill(context.projectRoot);
      // 即时检查通过后「使用这个目录」才可用；gate-c 的项目目录不是 Git 仓库，文案是「可以读写，但不是 Git 仓库…」。
      // 两种可读写结论（不是 / 是 Git 仓库，后者带分支时以它开头）任一出现即可，与只认「可以读写」等价。
      const [notGitRepo, gitRepo] = text.readable;
      await dialog
        .getByText(notGitRepo, { exact: false })
        .or(dialog.getByText(gitRepo, { exact: false }))
        .first()
        .waitFor({ timeout: 20_000 });
      await dialog.getByRole("button", { name: text.useDirectory }).click();
      continue;
    }
    if (!choseNew && (await startNew.isVisible().catch(() => false))) {
      choseNew = true;
      await startNew.click();
      continue;
    }
    await delay(200);
  }
  throw new Error("开始会话对话框未在限定时间内进入会话页");
}

/**
 * 从主导航进入某个分区（侧栏收起时链接只剩 aria-label，同名定位两种形态都成立）。
 * `label` 是这一轮界面语言下的分区名（`context.ui.nav.*`）。
 */
export async function openSection(page: Page, label: string): Promise<void> {
  await page.getByTestId("app-nav").getByRole("link", { name: label, exact: true }).click();
}

export async function capture(context: GateCStepContext, name: string): Promise<void> {
  await context.page.screenshot({
    path: resolve(context.artifactRoot, name),
    fullPage: false,
  });
  context.screenshots.push(name);
}

export async function waitForFile(
  path: string,
  expected: boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) === expected) return;
    await delay(100);
  }
  throw new Error(`timeout waiting for file state ${path}`);
}

/** PR3：Composer 的停止控件仅在运行 / 审批中存在，hidden 是回合终态。 */
export async function waitForTurnTerminal(page: Page, timeoutMs = 60_000): Promise<void> {
  await page.getByTestId("interrupt-turn").waitFor({ state: "hidden", timeout: timeoutMs });
}

/** 通过已审批命令建立可观察的运行窗口；不使用固定等待。 */
export async function startWaitWindow(context: GateCStepContext): Promise<void> {
  const marker = resolve(context.projectRoot, "GATE_C_WAIT_STARTED");
  rmSync(marker, { force: true });
  await pickSkill(context.page, "gate-c-workflow");
  await context.page.getByTestId("message-input").fill(
    "执行 wait 阶段：严格按 skill 指令实际运行命令，先创建 GATE_C_WAIT_STARTED，再等待。",
  );
  await context.page.getByTestId("send-message").click();
  await context.page.getByTestId("approval-card").waitFor({ timeout: 180_000 });
  await context.page.getByTestId("approval-accept").click();
  await waitForFile(marker, true, 60_000);
  await context.page.getByTestId("interrupt-turn").waitFor({ timeout: 15_000 });
}

/**
 * 等真实模型把一轮收尾的余量：wait 阶段 sleep 45 之后模型还要思考、核对、作答；推理强度真正发给模型
 * （「深入」）后这段常在 30～60 秒。等的是回合终态或随后的出队，放宽不影响验收口径。
 */
export const MODEL_WRAP_UP_TIMEOUT_MS = 180_000;

/** 先等命令自然结束，再删除仅供测试同步的标记。 */
export async function closeWaitWindow(context: GateCStepContext): Promise<void> {
  await waitForTurnTerminal(context.page, MODEL_WRAP_UP_TIMEOUT_MS);
  removeWaitWindowMarker(context);
}

/** 队列自动出队会吞掉上一轮的短暂 terminal，只有收口完成后才能清标记。 */
export function removeWaitWindowMarker(context: GateCStepContext): void {
  rmSync(resolve(context.projectRoot, "GATE_C_WAIT_STARTED"), { force: true });
}

export function findCodexDescendant(context: GateCStepContext, mainPid: number): number {
  const output = context.runCapture("ps", ["-eo", "pid=,ppid=,args="], 0).stdout;
  const rows = output
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match?.[1] && match[2] && match[3]
        ? [{ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] }]
        : [];
    });
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if ((row.ppid === mainPid || descendants.has(row.ppid)) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  const match = rows.find(
    (row) => descendants.has(row.pid) && row.args.includes("codex app-server --stdio"),
  );
  if (!match) throw new Error("could not find codex app-server descendant");
  return match.pid;
}

export async function waitForNewCodexDescendant(
  context: GateCStepContext,
  mainPid: number,
  oldPid: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = findCodexDescendant(context, mainPid);
      if (pid !== oldPid) return pid;
    } catch {
      // The supervisor is between processes.
    }
    await delay(100);
  }
  throw new Error("supervisor did not start a new codex app-server process");
}
