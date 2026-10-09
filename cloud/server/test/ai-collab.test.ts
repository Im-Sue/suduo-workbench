import type {
  AiActivityDto,
  ListAiActivityResponse,
  ListProjectAiRulesVersionsResponse,
  ListSharedItemsResponse,
  ProjectAiRulesDto,
  RequirementsEventDto,
  SaveProjectAiRulesResponse,
  RequirementsHealthDto,
  SharedItemDetailDto,
} from "@suduo/cloud-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, createRequirement, createUser, setupRoomsTest, type RoomsTestContext, type TestUser } from "./rooms-test-support.js";

/** 多 Agent 协作的团队共享部分（迁移 017，技术设计 2.13）：需求共享对象、项目 AI 规范、协作记录。 */

let context: RoomsTestContext;
let alice: TestUser;
let bob: TestUser;
let events: RequirementsEventDto[];

beforeEach(async () => {
  context = await setupRoomsTest({ name: "ai_collab" });
  alice = await createUser(context, "Alice");
  bob = await createUser(context, "Bob");
  events = [];
  context.events.subscribe((event) => events.push(event));
});

afterEach(async () => {
  await context.close();
});

const handoff = { summary: "导出接口做完一半", decisions: ["按月分页"], todo: ["补测试"], risks: ["时区"], branch: "suduo/REQ-1-codex", files: ["src/export.ts"] };

async function requirementOf(user: TestUser) {
  const project = await createProject(context, user, "订单中心");
  return createRequirement(context, user, project.id, { title: "订单导出" });
}

describe("需求共享对象", () => {
  it("发布交接包：按种类规整内容（多余字段去掉）、记来源与大小；列表不带内容、新的在前；推 shared_item.changed", async () => {
    const requirement = await requirementOf(alice);
    const response = await context.server.inject({
      method: "POST",
      url: `/v2/requirements/${requirement.id}/shared-items`,
      headers: alice.headers,
      payload: { kind: "handoff", title: "交接：订单导出", content: { ...handoff, secret: "多余字段" }, agentId: "claude-code", sessionRef: "local-session-1" },
    });
    expect(response.statusCode, response.body).toBe(201);
    const item = response.json<SharedItemDetailDto>();
    expect(item).toMatchObject({
      kind: "handoff",
      title: "交接：订单导出",
      source: { agentId: "claude-code", sessionRef: "local-session-1" },
      publishedBy: { id: alice.id, displayName: "Alice" },
      retractedAt: null,
      readCount: 0,
      content: handoff,
    });
    expect(item.sizeBytes).toBe(Buffer.byteLength(JSON.stringify(handoff), "utf8"));
    expect(events.filter((event) => event.type === "shared_item.changed").map((event) => event.requirementId)).toEqual([requirement.id]);
    await context.server.inject({
      method: "POST",
      url: `/v2/requirements/${requirement.id}/shared-items`,
      headers: bob.headers,
      payload: { kind: "review", title: "评审", content: { summary: "两处问题", findings: [{ severity: "high", file: "a.ts", line: 3, title: "空数组", detail: "会抛异常", suggestion: null }], targetAgentId: "codex" } },
    });
    const list = (await context.server.inject({ method: "GET", url: `/v2/requirements/${requirement.id}/shared-items`, headers: bob.headers })).json<ListSharedItemsResponse>();
    expect(list.items.map((entry) => entry.kind)).toEqual(["review", "handoff"]);
    expect(list.items.every((entry) => !("content" in entry))).toBe(true);
  });

  it("读：别人读过记一笔（发布人自己读不算）；项目成员都能撤回（记下是谁），撤回后内容删掉、标题与读过的人数留着", async () => {
    const requirement = await requirementOf(alice);
    const item = (
      await context.server.inject({ method: "POST", url: `/v2/requirements/${requirement.id}/shared-items`, headers: alice.headers, payload: { kind: "handoff", title: "交接", content: handoff } })
    ).json<SharedItemDetailDto>();
    await context.server.inject({ method: "GET", url: `/v2/shared-items/${item.id}`, headers: alice.headers });
    const read = (await context.server.inject({ method: "GET", url: `/v2/shared-items/${item.id}`, headers: bob.headers })).json<SharedItemDetailDto>();
    expect(read).toMatchObject({ readCount: 1, content: handoff, retractedBy: null });
    await context.server.inject({ method: "GET", url: `/v2/shared-items/${item.id}`, headers: bob.headers });
    events = [];
    // 发布人不在时别人也能撤（比如发现里面有密钥）。
    const retracted = (await context.server.inject({ method: "POST", url: `/v2/shared-items/${item.id}/retract`, headers: bob.headers })).json<SharedItemDetailDto>();
    expect(retracted).toMatchObject({ content: null, readCount: 1, title: "交接", retractedBy: { id: bob.id, displayName: "Bob" } });
    expect(retracted.retractedAt).not.toBeNull();
    expect(events.map((event) => event.type)).toEqual(["shared_item.changed"]);
    // 再撤回一次原样返回、不再推；撤回后谁读都没有内容，也不再记读过。
    const again = await context.server.inject({ method: "POST", url: `/v2/shared-items/${item.id}/retract`, headers: alice.headers });
    expect(again.json<SharedItemDetailDto>()).toMatchObject({ retractedAt: retracted.retractedAt, retractedBy: { id: bob.id } });
    expect(events).toHaveLength(1);
    const carol = await createUser(context, "Carol");
    expect((await context.server.inject({ method: "GET", url: `/v2/shared-items/${item.id}`, headers: carol.headers })).json<SharedItemDetailDto>()).toMatchObject({ content: null, readCount: 1 });
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await context.server.inject({ method: "GET", url: `/v2/shared-items/${missing}`, headers: bob.headers })).statusCode).toBe(404);
    expect((await context.server.inject({ method: "POST", url: `/v2/shared-items/${missing}/retract`, headers: bob.headers })).statusCode).toBe(404);
  });

  it("Agent 输出里的 NUL、半个 emoji（孤立代理字符）清掉再存；单个字段超长截断并列出，不拒整份；info 级意见收", async () => {
    const requirement = await requirementOf(alice);
    const post = (payload: Record<string, unknown>) =>
      context.server.inject({ method: "POST", url: `/v2/requirements/${requirement.id}/shared-items`, headers: alice.headers, payload });
    const dirty = await post({
      kind: "snapshot",
      title: "快照\u0000",
      content: { rounds: [{ userText: "a\u0000b", answer: "半个 \ud83d 表情", files: [], commands: [{ command: "x".repeat(5_000), exitCode: "bad" }], startedAt: "bad" }] },
    });
    expect(dirty.statusCode, dirty.body).toBe(201);
    const item = dirty.json<SharedItemDetailDto>();
    expect(item.title).toBe("快照");
    const round = (item.content as { rounds: Array<{ userText: string; answer: string; commands: Array<{ command: string; exitCode: number | null }>; startedAt: number | null }> }).rounds[0]!;
    expect(round.userText).toBe("ab");
    expect(round.answer).toBe("半个 \ufffd 表情");
    expect(Array.from(round.commands[0]!.command)).toHaveLength(4_000);
    expect(round.commands[0]!.exitCode).toBeNull();
    expect(round.startedAt).toBeNull();
    expect(item.truncatedFields).toEqual(["content.rounds[0].commands[0].command"]);
    const review = await post({
      kind: "review",
      title: "评审",
      content: { summary: "s", findings: [{ severity: "info", title: "t".repeat(400), detail: "d" }], targetAgentId: null },
    });
    expect(review.statusCode).toBe(201);
    expect(review.json<SharedItemDetailDto>().truncatedFields).toEqual(["content.findings[0].title"]);
    const rules = await context.server.inject({ method: "PUT", url: `/v2/projects/${requirement.projectId}/ai-rules`, headers: alice.headers, payload: { content: "规范\u0000" } });
    expect(rules.json<ProjectAiRulesDto>().content).toBe("规范");
    const activity = await context.server.inject({
      method: "POST",
      url: `/v2/requirements/${requirement.id}/ai-activity`,
      headers: alice.headers,
      payload: { localRef: "ref\u0000", agentId: "codex", kind: "session", status: "started", branch: "b\u0000" },
    });
    expect(activity.statusCode).toBe(200);
    expect(activity.json<AiActivityDto>().branch).toBe("b");
  });

  it("内容结构不对、超出上限都报参数错（带大小与上限）；需求不在为 404", async () => {
    const requirement = await requirementOf(alice);
    const post = (payload: Record<string, unknown>) =>
      context.server.inject({ method: "POST", url: `/v2/requirements/${requirement.id}/shared-items`, headers: alice.headers, payload });
    expect((await post({ kind: "handoff", title: "x", content: { summary: 1 } })).statusCode).toBe(400);
    expect((await post({ kind: "review", title: "x", content: { summary: "s", findings: [{ severity: "fatal", title: "t", detail: "d" }] } })).statusCode).toBe(400);
    expect((await post({ kind: "handoff", title: "x", content: { summary: "s", todo: "不是列表" } })).statusCode).toBe(400);
    expect((await post({ kind: "other", title: "x", content: {} })).statusCode).toBe(400);
    // 单个字段超长只截断；整份超过总大小（1.5 MB）才报错。
    const huge = await post({ kind: "snapshot", title: "快照", content: { rounds: Array.from({ length: 100 }, () => ({ userText: "x".repeat(19_000), answer: null, files: [], commands: [] })) } });
    expect(huge.statusCode).toBe(400);
    expect(huge.json<{ error: { details: { limit: number } } }>().error.details.limit).toBe(1_572_864);
    // 请求体超过 3 MB：如实说太大（413）并带上限，不是 500。
    const overBody = await post({ kind: "snapshot", title: "快照", content: { rounds: Array.from({ length: 200 }, () => ({ userText: "x".repeat(19_000), answer: null, files: [], commands: [] })) } });
    expect(overBody.statusCode).toBe(413);
    expect(overBody.json<{ error: { details: { limit: number } } }>().error.details.limit).toBe(3 * 1024 * 1024);
    const snapshot = await post({ kind: "snapshot", title: "快照", content: { rounds: [{ userText: "做导出", answer: "做好了", files: ["a.ts"], commands: [{ command: "pnpm test", exitCode: 0 }], startedAt: 1 }] } });
    expect(snapshot.statusCode).toBe(201);
    const missing = await context.server.inject({
      method: "POST",
      url: "/v2/requirements/00000000-0000-4000-8000-000000000000/shared-items",
      headers: alice.headers,
      payload: { kind: "handoff", title: "x", content: handoff },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("项目 AI 规范", () => {
  it("从没写过是版本 0；保存即新版本，内容没变不新增；别人保存成为新版本（两次修改都可见、内容按版本取得回）；推 ai_rules.changed", async () => {
    const project = await createProject(context, alice, "订单中心");
    const url = `/v2/projects/${project.id}/ai-rules`;
    expect((await context.server.inject({ method: "GET", url, headers: bob.headers })).json<ProjectAiRulesDto>()).toEqual({
      projectId: project.id,
      version: 0,
      content: "",
      updatedBy: null,
      updatedAt: null,
    });
    const first = (await context.server.inject({ method: "PUT", url, headers: alice.headers, payload: { content: "- 先写测试", baseVersion: 0 } })).json<SaveProjectAiRulesResponse>();
    expect(first).toMatchObject({ version: 1, content: "- 先写测试", updatedBy: { id: alice.id }, skippedVersions: [] });
    const same = (await context.server.inject({ method: "PUT", url, headers: alice.headers, payload: { content: "- 先写测试" } })).json<ProjectAiRulesDto>();
    expect(same.version).toBe(1);
    const second = (await context.server.inject({ method: "PUT", url, headers: bob.headers, payload: { content: "- 先写测试\n- 不改公共接口", baseVersion: 1 } })).json<ProjectAiRulesDto>();
    expect(second).toMatchObject({ version: 2, updatedBy: { id: bob.id } });
    // Alice 还在 v1 上改：不拒绝，存成 v3，回包告诉她 Bob 存过 v2（v2 的内容取得回）。
    const third = (await context.server.inject({ method: "PUT", url, headers: alice.headers, payload: { content: "- Alice 的版本", baseVersion: 1 } })).json<SaveProjectAiRulesResponse>();
    expect(third.version).toBe(3);
    expect(third.skippedVersions.map((entry) => [entry.version, entry.updatedBy.displayName])).toEqual([[2, "Bob"]]);
    const v2 = await context.server.inject({ method: "GET", url: `${url}/versions/2`, headers: alice.headers });
    expect(v2.json<{ content: string; updatedBy: { id: string } }>()).toMatchObject({ content: "- 先写测试\n- 不改公共接口", updatedBy: { id: bob.id } });
    expect((await context.server.inject({ method: "GET", url: `${url}/versions/9`, headers: alice.headers })).statusCode).toBe(404);
    expect((await context.server.inject({ method: "GET", url: `${url}/versions/99999999999`, headers: alice.headers })).statusCode).toBe(400);
    expect(events.filter((event) => event.type === "ai_rules.changed")).toHaveLength(3);
    const versions = (await context.server.inject({ method: "GET", url: `${url}/versions`, headers: alice.headers })).json<ListProjectAiRulesVersionsResponse>();
    expect(versions.items.map((entry) => [entry.version, entry.updatedBy.displayName])).toEqual([
      [3, "Alice"],
      [2, "Bob"],
      [1, "Alice"],
    ]);
    const missing = "/v2/projects/00000000-0000-4000-8000-000000000000/ai-rules";
    expect((await context.server.inject({ method: "GET", url: missing, headers: alice.headers })).statusCode).toBe(404);
    expect((await context.server.inject({ method: "GET", url: `${missing}/versions`, headers: alice.headers })).statusCode).toBe(404);
  });

  it("同时保存不拒绝：依次成为两个版本（ADR-0004）；超过 32 KB（按 UTF-8 字节）报参数错", async () => {
    const project = await createProject(context, alice, "订单中心");
    const url = `/v2/projects/${project.id}/ai-rules`;
    const results = await Promise.all([
      context.server.inject({ method: "PUT", url, headers: alice.headers, payload: { content: "A 的规范" } }),
      context.server.inject({ method: "PUT", url, headers: bob.headers, payload: { content: "B 的规范" } }),
    ]);
    expect(results.map((result) => result.statusCode)).toEqual([200, 200]);
    expect(results.map((result) => result.json<ProjectAiRulesDto>().version).sort()).toEqual([1, 2]);
    const tooBig = await context.server.inject({ method: "PUT", url, headers: alice.headers, payload: { content: "规".repeat(11_000) } });
    expect(tooBig.statusCode).toBe(400);
  });
});

describe("协作记录（P2-D1）", () => {
  it("上报只含元数据；同一成员、同一类型、同一本机编号再报时更新；补发的旧状态不覆盖新的；别人的、别的类型的另记；推 ai_activity.changed", async () => {
    const requirement = await requirementOf(alice);
    const url = `/v2/requirements/${requirement.id}/ai-activity`;
    const post = (user: TestUser, payload: Record<string, unknown>) => context.server.inject({ method: "POST", url, headers: user.headers, payload });
    const started = (await post(alice, { localRef: "trial-1", agentId: "codex", kind: "trial", status: "started", occurredAt: "2026-10-09T01:00:00.000Z" })).json<AiActivityDto>();
    expect(started).toMatchObject({ kind: "trial", status: "started", branch: null, member: { id: alice.id }, occurredAt: "2026-10-09T01:00:00.000Z" });
    await post(bob, { localRef: "trial-1", agentId: "claude-code", kind: "delegate", status: "started" });
    // 同一个本机编号报另一种类型：另记一条，不互相覆盖。
    await post(alice, { localRef: "trial-1", agentId: "codex", kind: "handoff", status: "completed" });
    const adopted = (
      await post(alice, { localRef: "trial-1", agentId: "codex", kind: "trial", status: "adopted", branch: "suduo/REQ-1-codex", occurredAt: "2026-10-09T03:00:00.000Z" })
    ).json<AiActivityDto>();
    expect(adopted).toMatchObject({ id: started.id, status: "adopted", branch: "suduo/REQ-1-codex" });
    // 补发的旧状态：不覆盖，原样返回现在记着的。
    const stale = (await post(alice, { localRef: "trial-1", agentId: "codex", kind: "trial", status: "started", occurredAt: "2026-10-09T02:00:00.000Z" })).json<AiActivityDto>();
    expect(stale).toMatchObject({ id: started.id, status: "adopted" });
    // 以后加的新类型、状态也收（只查格式）。
    expect((await post(alice, { localRef: "c-1", agentId: "codex", kind: "continue", status: "interrupted" })).statusCode).toBe(200);
    const list = (await context.server.inject({ method: "GET", url, headers: bob.headers })).json<ListAiActivityResponse>();
    expect(list.items.map((entry) => [entry.member.displayName, entry.kind, entry.status])).toEqual([
      ["Alice", "continue", "interrupted"],
      ["Alice", "trial", "adopted"],
      ["Alice", "handoff", "completed"],
      ["Bob", "delegate", "started"],
    ]);
    // 补发的旧状态没改动任何东西，不推。
    expect(events.filter((event) => event.type === "ai_activity.changed")).toHaveLength(5);
    expect((await post(alice, { localRef: "\u0000", agentId: "codex", kind: "trial", status: "started" })).statusCode).toBe(400);
    // 本机时钟偏快：未来时间钳到服务器时间之后 5 分钟内，之后的正常上报不会一直被当成旧的。
    const future = (await post(alice, { localRef: "skew", agentId: "codex", kind: "session", status: "started", occurredAt: "2099-01-01T00:00:00.000Z" })).json<AiActivityDto>();
    expect(Date.parse(future.occurredAt)).toBeLessThan(Date.now() + 6 * 60_000);
    expect((await post(alice, { localRef: "x", agentId: "Codex!", kind: "trial", status: "started" })).statusCode).toBe(400);
    expect((await post(alice, { localRef: "x", agentId: "codex", kind: "Trial", status: "started" })).statusCode).toBe(400);
    const missing = await context.server.inject({
      method: "POST",
      url: "/v2/requirements/00000000-0000-4000-8000-000000000000/ai-activity",
      headers: alice.headers,
      payload: { localRef: "x", agentId: "codex", kind: "trial", status: "started" },
    });
    expect(missing.statusCode).toBe(404);
  });
});

it("健康检查声明 ai_collab_v1", async () => {
  const health = (await context.server.inject({ method: "GET", url: "/v2/health" })).json<RequirementsHealthDto>();
  expect(health.features).toContain("ai_collab_v1");
});
