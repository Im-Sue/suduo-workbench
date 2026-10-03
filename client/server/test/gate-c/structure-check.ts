import {
  GATE_C_FIXTURE_IDS,
  GATE_C_FIXTURE_NUMBERS,
  startRequirementsServiceFixture,
} from "./requirements-service-fixture.js";
import { extensionSeamStep } from "./steps/extension-seam.js";
import { defineGateCSteps, runGateCSteps, type GateCStepContext } from "./steps/types.js";

const fixture = await startRequirementsServiceFixture();
try {
  await new Promise((resolveReady) => setTimeout(resolveReady, 25));
  const login = await fetch(fixture.origin + "/v2/auth/login", { method: "POST" });
  if (!login.ok) throw new Error("requirements fixture login failed");
  const projects = await fetch(fixture.origin + "/v2/projects");
  const projectBody = await projects.json() as { items?: Array<{ id?: string }> };
  if (!projects.ok || projectBody.items?.[0]?.id !== fixture.projectId) {
    throw new Error("requirements fixture project list failed");
  }
  const stats = await fetch(
    fixture.origin + `/v2/projects/${fixture.projectId}/stats?window=7d&tz=America%2FChicago`,
  );
  const statsBody = await stats.json() as { statusCounts?: Record<string, number> };
  if (!stats.ok || statsBody.statusCounts?.["draft"] === undefined) {
    throw new Error("requirements fixture stats failed");
  }
  const batch = await fetch(fixture.origin + `/v2/requirements?ids=${GATE_C_FIXTURE_IDS.reqDraft1},missing`);
  const batchBody = await batch.json() as { items?: Array<{ id?: string }> };
  if (!batch.ok || batchBody.items?.[0]?.id !== GATE_C_FIXTURE_IDS.reqDraft1 || batchBody.items.length !== 1) {
    throw new Error("requirements fixture batch lookup failed");
  }
  // UI/UX 重设计 P2 用到的新接口：成员列表、按编号取需求、活动时间线、列表的负责人 / 编号筛选。
  const usersResponse = await fetch(fixture.origin + "/v2/users");
  const usersBody = await usersResponse.json() as { items?: Array<{ id?: string }> };
  if (!usersResponse.ok || !usersBody.items?.some((item) => item.id === GATE_C_FIXTURE_IDS.userMe)) {
    throw new Error("requirements fixture users list failed");
  }
  const byNumber = await fetch(
    fixture.origin + `/v2/projects/${fixture.projectId}/requirements/by-number/${String(GATE_C_FIXTURE_NUMBERS.reqHold1)}`,
  );
  const byNumberBody = await byNumber.json() as { id?: string; project?: { id?: string } };
  if (!byNumber.ok || byNumberBody.id !== GATE_C_FIXTURE_IDS.reqHold1 || byNumberBody.project?.id !== fixture.projectId) {
    throw new Error("requirements fixture by-number lookup failed");
  }
  const missingNumber = await fetch(fixture.origin + `/v2/projects/${fixture.projectId}/requirements/by-number/999`);
  if (missingNumber.status !== 404) {
    throw new Error(`requirements fixture by-number miss returned ${String(missingNumber.status)}`);
  }
  const activity = await fetch(fixture.origin + `/v2/requirements/${GATE_C_FIXTURE_IDS.reqDraft1}/activity`);
  const activityBody = await activity.json() as { items?: Array<{ action?: string }>; nextCursor?: unknown };
  const actions = activityBody.items?.map((item) => item.action) ?? [];
  if (
    !activity.ok ||
    activityBody.nextCursor !== null ||
    !actions.includes("requirement.created") ||
    !actions.includes("comment.created") ||
    !actions.includes("attachment.created")
  ) {
    throw new Error("requirements fixture activity timeline failed");
  }
  const listIds = async (query: string): Promise<string[]> => {
    const response = await fetch(fixture.origin + `/v2/projects/${fixture.projectId}/requirements?${query}`);
    const body = await response.json() as { items?: Array<{ id: string }> };
    if (!response.ok) throw new Error(`requirements fixture list failed: ${query}`);
    return body.items?.map((item) => item.id) ?? [];
  };
  const mine = await listIds("assignee=me");
  const unassigned = await listIds("assignee=none");
  const searched = await listIds(`search=REQ-${String(GATE_C_FIXTURE_NUMBERS.reqHold1)}`);
  const holdColumn = await listIds("status=on_hold");
  if (
    JSON.stringify(mine) !== JSON.stringify([GATE_C_FIXTURE_IDS.reqDraft1]) ||
    unassigned.includes(GATE_C_FIXTURE_IDS.reqDraft1) ||
    JSON.stringify(searched) !== JSON.stringify([GATE_C_FIXTURE_IDS.reqHold1]) ||
    JSON.stringify(holdColumn) !== JSON.stringify([GATE_C_FIXTURE_IDS.reqHold1])
  ) {
    throw new Error("requirements fixture list filters failed");
  }
  const audit = await fetch(fixture.origin + `/v2/audit?projectId=${fixture.projectId}`);
  const auditBody = await audit.json() as { items?: unknown[] };
  if (!audit.ok || auditBody.items?.length !== 1) {
    throw new Error("requirements fixture project audit filter failed");
  }
  fixture.setRemoteFailure(true);
  try {
    const unavailable = await fetch(fixture.origin + `/v2/requirements?ids=${GATE_C_FIXTURE_IDS.reqDraft1}`);
    if (unavailable.status !== 503) {
      throw new Error(`requirements fixture remote failure switch returned ${String(unavailable.status)}`);
    }
  } finally {
    fixture.setRemoteFailure(false);
  }
  const events = await fetch(fixture.origin + "/v2/events");
  if (!events.ok || !events.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("requirements fixture SSE failed");
  }
  await events.body?.cancel();

  const context = { completedSteps: new Set<string>() } as GateCStepContext;
  await runGateCSteps(context, defineGateCSteps(extensionSeamStep));
  if (!context.completedSteps.has(extensionSeamStep.id)) {
    throw new Error("empty extension step was not registered and run");
  }
  process.stdout.write(
    JSON.stringify({ status: "PASS", fixture: fixture.origin, step: extensionSeamStep.id }) + "\n",
  );
} finally {
  await fixture.close();
}
