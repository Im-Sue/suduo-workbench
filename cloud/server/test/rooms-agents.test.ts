import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AgentDto,
  AgentRunDetailDto,
  AgentRunSummaryDto,
  AgentShareDto,
  AgentShareRequestDto,
  ListAgentRunsResponse,
  ListAgentSharesResponse,
  ListAgentsResponse,
  ListRoomMembersResponse,
  ListRoomMessagesResponse,
  RoomDto,
  RoomEventDto,
  StartAgentRunResponse,
} from "@suduo/cloud-contracts";
import {
  ageAgent,
  createProject,
  createUser,
  defaultRoom,
  openShare,
  registerAgent,
  sendMessage,
  setupRoomsTest,
  type RoomsTestContext,
  type TestUser,
} from "./rooms-test-support.js";

let context: RoomsTestContext;
const published: RoomEventDto[] = [];

beforeAll(async () => {
  context = await setupRoomsTest({ name: "rooms_agent" });
  context.rooms.realtime.subscribe((event) => published.push(event));
});

afterAll(async () => {
  await context?.close();
});

interface Scene {
  owner: TestUser;
  asker: TestUser;
  room: RoomDto;
  agent: AgentDto;
}

async function scene(label: string): Promise<Scene> {
  const owner = await createUser(context, `${label}开发`);
  const asker = await createUser(context, `${label}产品`);
  const project = await createProject(context, owner, `${label}项目`);
  const room = await defaultRoom(context, owner, project.id);
  const agent = await registerAgent(context, owner);
  return { owner, asker, room, agent };
}

async function post<T>(user: TestUser, url: string, payload?: Record<string, unknown>, status = 200): Promise<T> {
  const response = await context.server.inject({
    method: "POST",
    url,
    headers: user.headers,
    ...(payload === undefined ? {} : { payload }),
  });
  expect(response.statusCode, response.body).toBe(status);
  return response.json<T>();
}

async function ask(s: Scene, extra: Record<string, unknown> = {}): Promise<AgentRunSummaryDto> {
  const message = await sendMessage(context, s.asker, s.room.id, {
    body: "@Codex 订单详情现在能拿到收货信息吗？",
    mentions: [{ kind: "agent", id: s.agent.id }],
    ...extra,
  });
  expect(message.runs).toHaveLength(1);
  return message.runs[0]!;
}

async function runDetail(user: TestUser, runId: string): Promise<AgentRunDetailDto> {
  const response = await context.server.inject({ method: "GET", url: `/v2/agent-runs/${runId}`, headers: user.headers });
  expect(response.statusCode).toBe(200);
  return response.json<AgentRunDetailDto>();
}

describe("Agent 登记与心跳", () => {
  it("同一所有者 + 设备重复登记合并（201 → 200），更新设备名；标签与在线", async () => {
    const owner = await createUser(context, "陈思远");
    const deviceKey = `device-${randomUUID()}`;
    const first = await context.server.inject({
      method: "POST",
      url: "/v2/agents",
      headers: owner.headers,
      payload: { deviceKey, deviceName: "旧电脑" },
    });
    expect(first.statusCode).toBe(201);
    const second = await context.server.inject({
      method: "POST",
      url: "/v2/agents",
      headers: owner.headers,
      payload: { deviceKey, deviceName: "MacBook Pro" },
    });
    expect(second.statusCode).toBe(200);
    const agent = second.json<AgentDto>();
    expect(agent.id).toBe(first.json<AgentDto>().id);
    expect(agent).toMatchObject({
      kind: "codex",
      deviceName: "MacBook Pro",
      label: "陈思远's Codex · MacBook Pro",
      online: true,
      activeShareCount: 0,
      owner: { id: owner.id, displayName: "陈思远" },
    });
    expect(published.filter((event) => event.type === "agent.presence" && event.agent?.id === agent.id)).toHaveLength(1);

    const list = await context.server.inject({ method: "GET", url: "/v2/agents", headers: owner.headers });
    expect(list.json<ListAgentsResponse>().items.map((item) => item.id)).toContain(agent.id);
  });

  it("心跳：只有所有者（别人 404）；browserActive 让真人在线并推送一次", async () => {
    const owner = await createUser(context, "心跳人");
    const other = await createUser(context, "旁人");
    const agent = await registerAgent(context, owner);
    await post(other, `/v2/agents/${agent.id}/heartbeat`, { browserActive: true }, 404);
    await ageAgent(context, agent.id, 300);
    const offline = (await context.server.inject({ method: "GET", url: "/v2/agents", headers: owner.headers }))
      .json<ListAgentsResponse>().items.find((item) => item.id === agent.id);
    expect(offline?.online).toBe(false);
    const before = published.length;
    const beat = await post<AgentDto>(owner, `/v2/agents/${agent.id}/heartbeat`, { browserActive: true });
    expect(beat.online).toBe(true);
    await post(owner, `/v2/agents/${agent.id}/heartbeat`, { browserActive: true });
    const presence = published.slice(before).filter((event) => event.type === "user.presence");
    expect(presence).toEqual([expect.objectContaining({ user: { id: owner.id, online: true }, projectId: null })]);
    const project = await createProject(context, owner, "在线项目");
    const room = await defaultRoom(context, owner, project.id);
    const members = (await context.server.inject({
      method: "GET",
      url: `/v2/rooms/${room.id}/members`,
      headers: other.headers,
    })).json<ListRoomMembersResponse>().items;
    expect(members.find((member) => member.user.id === owner.id)?.online).toBe(true);
    expect(members.find((member) => member.user.id === other.id)?.online).toBe(false);
  });
});

describe("共享", () => {
  it("开 / 重开改时长（同一条）/ 关闭；只有所有者（别人 404）；审计", async () => {
    const s = await scene("共享");
    await post(s.asker, `/v2/rooms/${s.room.id}/shares`, { agentId: s.agent.id, duration: "until_closed" }, 404);
    const opened = await openShare(context, s.owner, s.room.id, s.agent.id, "until_closed");
    expect(opened).toMatchObject({ expiresAt: null, active: true });
    const reopened = await openShare(context, s.owner, s.room.id, s.agent.id, "two_hours");
    expect(reopened.id).toBe(opened.id);
    const expiresIn = Date.parse(reopened.expiresAt ?? "") - Date.now();
    expect(expiresIn).toBeGreaterThan(115 * 60_000);
    expect(expiresIn).toBeLessThanOrEqual(120 * 60_000);

    // 「今天」：浏览器给的未来 24 小时内的时刻原样采用；超出范围按服务端当天结束。
    const localEnd = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    const today = await post<AgentShareDto>(s.owner, `/v2/rooms/${s.room.id}/shares`, {
      agentId: s.agent.id,
      duration: "today",
      expiresAt: localEnd,
    });
    expect(today.expiresAt).toBe(localEnd);
    const tooFar = await post<AgentShareDto>(s.owner, `/v2/rooms/${s.room.id}/shares`, {
      agentId: s.agent.id,
      duration: "today",
      expiresAt: new Date(Date.now() + 48 * 60 * 60_000).toISOString(),
    });
    const serverEnd = new Date();
    serverEnd.setHours(23, 59, 59, 999);
    expect(tooFar.expiresAt).toBe(serverEnd.toISOString());
    expect(tooFar.agent.activeShareCount).toBe(1);

    const listed = await context.server.inject({ method: "GET", url: `/v2/rooms/${s.room.id}/shares`, headers: s.asker.headers });
    expect(listed.json<ListAgentSharesResponse>().items.map((item) => item.id)).toEqual([opened.id]);

    await post(s.asker, `/v2/agent-shares/${opened.id}/close`, undefined, 404);
    const closed = await post<AgentShareDto>(s.owner, `/v2/agent-shares/${opened.id}/close`);
    expect(closed).toMatchObject({ id: opened.id, active: false });
    expect(closed.closedAt).not.toBeNull();
    // 再关一次：原样返回，不重复审计。
    await post(s.owner, `/v2/agent-shares/${opened.id}/close`);
    const audits = await context.pool.query<{ action: string; before_json: unknown; requirement_id: string | null }>(
      "SELECT action, before_json, requirement_id FROM audit_logs WHERE resource_type = 'agent_share' AND resource_id = $1 ORDER BY created_at",
      [opened.id],
    );
    expect(audits.rows.map((row) => row.action)).toEqual([
      "agent_share.opened",
      "agent_share.opened",
      "agent_share.opened",
      "agent_share.opened",
      "agent_share.closed",
    ]);
    expect(audits.rows[0]?.before_json).toBeNull();
    expect(audits.rows[1]?.before_json).toMatchObject({ expiresAt: null });
    expect(audits.rows.every((row) => row.requirement_id === null)).toBe(true);
    // 关闭后能重新开一条新的。
    const fresh = await openShare(context, s.owner, s.room.id, s.agent.id);
    expect(fresh.id).not.toBe(opened.id);
  });

  it("申请共享：重复申请合并；所有者 accept 即开启（缺省今天）；别人处理 404；已处理的原样返回；ignore", async () => {
    const s = await scene("申请");
    const first = await context.server.inject({
      method: "POST",
      url: `/v2/rooms/${s.room.id}/share-requests`,
      headers: s.asker.headers,
      payload: { agentId: s.agent.id },
    });
    expect(first.statusCode).toBe(201);
    const second = await context.server.inject({
      method: "POST",
      url: `/v2/rooms/${s.room.id}/share-requests`,
      headers: s.asker.headers,
      payload: { agentId: s.agent.id },
    });
    expect(second.statusCode).toBe(200);
    const request = first.json<AgentShareRequestDto>();
    expect(second.json<AgentShareRequestDto>().id).toBe(request.id);
    expect(request).toMatchObject({ status: "pending", requester: { id: s.asker.id }, agent: { id: s.agent.id } });
    const pending = await context.server.inject({
      method: "GET",
      url: `/v2/rooms/${s.room.id}/share-requests`,
      headers: s.owner.headers,
    });
    expect(pending.json<{ items: AgentShareRequestDto[] }>().items.map((item) => item.id)).toEqual([request.id]);

    await post(s.asker, `/v2/share-requests/${request.id}/resolve`, { action: "accept" }, 404);
    const accepted = await post<AgentShareRequestDto>(s.owner, `/v2/share-requests/${request.id}/resolve`, { action: "accept" });
    expect(accepted.status).toBe("accepted");
    const shares = (await context.server.inject({
      method: "GET",
      url: `/v2/rooms/${s.room.id}/shares`,
      headers: s.asker.headers,
    })).json<ListAgentSharesResponse>().items;
    expect(shares).toHaveLength(1);
    expect(shares[0]?.active).toBe(true);
    expect(shares[0]?.expiresAt).not.toBeNull();
    // 已处理：原样返回。
    const again = await post<AgentShareRequestDto>(s.owner, `/v2/share-requests/${request.id}/resolve`, { action: "ignore" });
    expect(again.status).toBe("accepted");

    const other = await createUser(context, "另一个申请人");
    const ignored = await post<AgentShareRequestDto>(other, `/v2/rooms/${s.room.id}/share-requests`, { agentId: s.agent.id }, 201);
    const resolved = await post<AgentShareRequestDto>(s.owner, `/v2/share-requests/${ignored.id}/resolve`, { action: "ignore" });
    expect(resolved.status).toBe("ignored");
    // 忽略后可以再申请（新的一条待处理）。
    const renewed = await post<AgentShareRequestDto>(other, `/v2/rooms/${s.room.id}/share-requests`, { agentId: s.agent.id }, 201);
    expect(renewed.id).not.toBe(ignored.id);
  });
});

describe("任务", () => {
  it("@Agent：未共享 → 离线 not_shared；共享但不在线 → owner_offline；@ 所有人不唤起", async () => {
    const s = await scene("离线");
    const notShared = await ask(s);
    // 原因存 code（前端按语言渲染）+ 英文兜底文字（老客户端显示）；云端的原因不带参数。
    expect(notShared).toMatchObject({
      status: "offline",
      reason: "Not shared to this room",
      reasonCode: "not_shared",
      reasonParams: null,
      progressCode: null,
      queuePosition: null,
    });
    await openShare(context, s.owner, s.room.id, s.agent.id);
    await ageAgent(context, s.agent.id, 120);
    const offline = await ask(s);
    expect(offline).toMatchObject({ status: "offline", reason: "The owner is offline", reasonCode: "owner_offline" });
    const all = await sendMessage(context, s.asker, s.room.id, { body: "@所有人", mentions: [{ kind: "all" }] });
    expect(all.runs).toEqual([]);
  });

  it("排队位置；start 合并；progress；complete 发话题回复；重复 complete 不发第二条", async () => {
    const s = await scene("执行");
    await openShare(context, s.owner, s.room.id, s.agent.id);
    const first = await ask(s);
    const second = await ask(s);
    expect(first).toMatchObject({ status: "queued", queuePosition: 0, threadRootId: first.triggerMessageId });
    expect(second.queuePosition).toBe(1);
    expect(first.agent).toMatchObject({ id: s.agent.id, label: s.agent.label });

    const queued = await context.server.inject({
      method: "GET",
      url: `/v2/agent-runs?agentId=${s.agent.id}&status=queued`,
      headers: s.owner.headers,
    });
    expect(queued.json<ListAgentRunsResponse>().items.map((run) => run.id)).toEqual([first.id, second.id]);

    await post(s.asker, `/v2/agent-runs/${first.id}/start`, undefined, 404);
    const before = published.length;
    const started = await post<StartAgentRunResponse>(s.owner, `/v2/agent-runs/${first.id}/start`);
    expect(started).toMatchObject({ started: true, run: { status: "running", queuePosition: null } });
    expect(started.run.startedAt).not.toBeNull();
    const again = await post<StartAgentRunResponse>(s.owner, `/v2/agent-runs/${first.id}/start`);
    expect(again).toMatchObject({ started: false, run: { status: "running" } });
    expect(published.slice(before).filter((event) => event.type === "room.run")).toHaveLength(1);
    expect((await runDetail(s.owner, second.id)).queuePosition).toBe(0);

    const progressed = await post<AgentRunSummaryDto>(s.owner, `/v2/agent-runs/${first.id}/progress`, {
      progress: "Read 6 files · Ran 2 commands",
      progressCode: "activity",
      progressParams: { read: 6, command: 2 },
      events: [{ kind: "partial" }],
    });
    expect(progressed).toMatchObject({
      progress: "Read 6 files · Ran 2 commands",
      progressCode: "activity",
      progressParams: { read: 6, command: 2 },
    });
    // 认不出的 code 照收（不限取值，ADR-0004）；老本机只给文字时 code 与参数一起清空，免得与文字对不上。
    expect(
      await post<AgentRunSummaryDto>(s.owner, `/v2/agent-runs/${first.id}/progress`, {
        progress: "Doing something new",
        progressCode: "future_code",
        progressParams: { anything: "x" },
      }),
    ).toMatchObject({ progressCode: "future_code", progressParams: { anything: "x" } });
    const legacy = await post<AgentRunSummaryDto>(s.owner, `/v2/agent-runs/${first.id}/progress`, {
      progress: "查看了 6 个文件 · 运行了 2 条命令",
    });
    expect(legacy).toMatchObject({ progress: "查看了 6 个文件 · 运行了 2 条命令", progressCode: null, progressParams: null });
    // 排队中的任务不接受进度（不报错，原样返回）。
    const ignored = await post<AgentRunSummaryDto>(s.owner, `/v2/agent-runs/${second.id}/progress`, { progress: "不该写入" });
    expect(ignored.progress).toBeNull();

    const completed = await post<AgentRunSummaryDto>(s.owner, `/v2/agent-runs/${first.id}/complete`, {
      replyBody: "后端已有 receiverSnapshot，前端抽屉没展示。",
      summary: "后端已有 receiverSnapshot，前端抽屉没展示",
      events: [{ kind: "turn" }, { kind: "item" }],
    });
    expect(completed).toMatchObject({
      status: "completed",
      summary: "后端已有 receiverSnapshot，前端抽屉没展示",
      reason: null,
      reasonCode: null,
      reasonParams: null,
    });
    expect(completed.replyMessageId).not.toBeNull();
    expect((await runDetail(s.asker, first.id)).events).toEqual([{ kind: "turn" }, { kind: "item" }]);

    const thread = (await context.server.inject({
      method: "GET",
      url: `/v2/rooms/${s.room.id}/messages?threadRootId=${first.triggerMessageId}`,
      headers: s.asker.headers,
    })).json<ListRoomMessagesResponse>().items;
    expect(thread).toHaveLength(2);
    expect(thread[0]?.thread?.replyCount).toBe(1);
    expect(thread[0]?.runs.map((run) => run.status)).toEqual(["completed"]);
    expect(thread[1]).toMatchObject({
      id: completed.replyMessageId,
      authorKind: "agent",
      author: { id: s.owner.id },
      agent: { id: s.agent.id },
      threadRootId: first.triggerMessageId,
      clientId: null,
    });

    const replay = await post<AgentRunSummaryDto>(s.owner, `/v2/agent-runs/${first.id}/complete`, {
      replyBody: "又一次",
      summary: "又一次",
      events: [],
    });
    expect(replay.replyMessageId).toBe(completed.replyMessageId);
    const finishCompleted = await post<AgentRunSummaryDto>(s.owner, `/v2/agent-runs/${first.id}/finish`, {
      status: "failed",
      reason: "不应生效",
    });
    expect(finishCompleted.status).toBe("completed");
    const roomAfter = (await context.server.inject({ method: "GET", url: `/v2/rooms/${s.room.id}`, headers: s.asker.headers }))
      .json<RoomDto>();
    expect(roomAfter.lastSeq).toBe(3);
    // 最后一条是 Agent 的回答：结构化给所有者名与设备名，兜底作者是英文 Agent 标签。
    expect(roomAfter.lastMessage).toMatchObject({
      seq: 3,
      authorKind: "agent",
      agent: { ownerName: s.owner.displayName, deviceName: "MacBook Pro" },
      authorName: `${s.owner.displayName}'s Codex · MacBook Pro`,
      text: "后端已有 receiverSnapshot，前端抽屉没展示。",
      preview: "后端已有 receiverSnapshot，前端抽屉没展示。",
      firstFile: null,
      fileCount: 0,
    });

    // 本机带执行过程回写失败后会退一步不带过程（空数组）重发：保留执行中已上传的过程。
    await post<StartAgentRunResponse>(s.owner, `/v2/agent-runs/${second.id}/start`);
    await post(s.owner, `/v2/agent-runs/${second.id}/progress`, { progress: "查看了 1 个文件", events: [{ kind: "partial" }] });
    await post(s.owner, `/v2/agent-runs/${second.id}/complete`, { replyBody: "好。", summary: "好。", events: [] });
    expect((await runDetail(s.asker, second.id)).events).toEqual([{ kind: "partial" }]);
  });

  it("话题里 @ Agent：任务挂在话题根；finish 失败；触发人重试复用同一行", async () => {
    const s = await scene("重试");
    await openShare(context, s.owner, s.room.id, s.agent.id);
    const root = await sendMessage(context, s.asker, s.room.id, { body: "先说背景" });
    const run = await ask(s, { threadRootId: root.id });
    expect(run.threadRootId).toBe(root.id);
    await post(s.owner, `/v2/agent-runs/${run.id}/start`);
    await post(s.owner, `/v2/agent-runs/${run.id}/progress`, { progress: "Thinking", progressCode: "thinking" });
    const failed = await post<AgentRunSummaryDto>(s.owner, `/v2/agent-runs/${run.id}/finish`, {
      status: "failed",
      reason: "The local folder linked to this project on the owner's computer isn't available (/work/shop).",
      reasonCode: "local_folder_unavailable",
      reasonParams: { path: "/work/shop" },
      events: [{ kind: "error" }],
    });
    expect(failed).toMatchObject({
      status: "failed",
      reason: "The local folder linked to this project on the owner's computer isn't available (/work/shop).",
      reasonCode: "local_folder_unavailable",
      reasonParams: { path: "/work/shop" },
    });
    expect(failed.finishedAt).not.toBeNull();

    await post(s.owner, `/v2/agent-runs/${run.id}/retry`, undefined, 404);
    const retried = await post<AgentRunSummaryDto>(s.asker, `/v2/agent-runs/${run.id}/retry`);
    expect(retried).toMatchObject({
      id: run.id,
      status: "queued",
      reason: null,
      reasonCode: null,
      reasonParams: null,
      progress: null,
      progressCode: null,
      progressParams: null,
      summary: null,
      startedAt: null,
      finishedAt: null,
      stopRequested: false,
    });
    expect((await runDetail(s.asker, run.id)).events).toEqual([]);
    // 排队中再点重试：原样返回。
    expect((await post<AgentRunSummaryDto>(s.asker, `/v2/agent-runs/${run.id}/retry`)).status).toBe("queued");

    // 离线任务：所有者上线并共享后重试即排队；不在线时重试仍离线。
    const otherRoomOwner = await createUser(context, "离线重试人");
    const project = await createProject(context, otherRoomOwner, "离线重试项目");
    const room2 = await defaultRoom(context, otherRoomOwner, project.id);
    const offline = await ask({ ...s, room: room2 });
    expect(offline.status).toBe("offline");
    await ageAgent(context, s.agent.id, 200);
    await openShare(context, s.owner, room2.id, s.agent.id);
    expect(await post<AgentRunSummaryDto>(s.asker, `/v2/agent-runs/${offline.id}/retry`)).toMatchObject({
      status: "offline",
      reason: "The owner is offline",
      reasonCode: "owner_offline",
    });
    await post(s.owner, `/v2/agents/${s.agent.id}/heartbeat`, { browserActive: false });
    expect((await post<AgentRunSummaryDto>(s.asker, `/v2/agent-runs/${offline.id}/retry`)).status).toBe("queued");
  });

  it("停止：排队中直接停（触发人）；执行中只标记 stop_requested（所有者）；旁人 404", async () => {
    const s = await scene("停止");
    const bystander = await createUser(context, "旁观者");
    await openShare(context, s.owner, s.room.id, s.agent.id);
    const queued = await ask(s);
    await post(bystander, `/v2/agent-runs/${queued.id}/stop`, undefined, 404);
    const stopped = await post<AgentRunSummaryDto>(s.asker, `/v2/agent-runs/${queued.id}/stop`);
    expect(stopped).toMatchObject({
      status: "stopped",
      reason: "Stopped by the person who asked",
      reasonCode: "stopped_by_requester",
    });

    const running = await ask(s);
    await post(s.owner, `/v2/agent-runs/${running.id}/start`);
    const requested = await post<AgentRunSummaryDto>(s.owner, `/v2/agent-runs/${running.id}/stop`);
    expect(requested).toMatchObject({
      status: "running",
      stopRequested: true,
      reason: "Stopped by the owner",
      reasonCode: "stopped_by_owner",
    });
    // 本机回写覆盖云端先写的原因，code 一起覆盖：新本机带 code。
    const finished = await post<AgentRunSummaryDto>(s.owner, `/v2/agent-runs/${running.id}/finish`, {
      status: "stopped",
      reason: "Stopped while running",
      reasonCode: "stopped_while_running",
    });
    expect(finished).toMatchObject({
      status: "stopped",
      stopRequested: false,
      reason: "Stopped while running",
      reasonCode: "stopped_while_running",
      reasonParams: null,
    });

    // 老本机只回写文字：云端先写的 code 也被清掉，前端显示本机的原文。
    const legacy = await ask(s);
    await post(s.owner, `/v2/agent-runs/${legacy.id}/start`);
    await post(s.asker, `/v2/agent-runs/${legacy.id}/stop`);
    expect(
      await post<AgentRunSummaryDto>(s.owner, `/v2/agent-runs/${legacy.id}/finish`, { status: "stopped", reason: "已停止" }),
    ).toMatchObject({ status: "stopped", reason: "已停止", reasonCode: null, reasonParams: null });

    // 请求停止后本机照样答完：完成时原因三列一起清空。
    const answered = await ask(s);
    await post(s.owner, `/v2/agent-runs/${answered.id}/start`);
    await post(s.owner, `/v2/agent-runs/${answered.id}/stop`);
    expect(
      await post<AgentRunSummaryDto>(s.owner, `/v2/agent-runs/${answered.id}/complete`, {
        replyBody: "答完了。",
        summary: "答完了。",
        events: [],
      }),
    ).toMatchObject({ status: "completed", reason: null, reasonCode: null, reasonParams: null });
  });

  it("关闭共享：排队中 → 已停止「共享已关闭」，执行中 → 请求停止", async () => {
    const s = await scene("关共享");
    const share = await openShare(context, s.owner, s.room.id, s.agent.id);
    const running = await ask(s);
    const queued = await ask(s);
    await post(s.owner, `/v2/agent-runs/${running.id}/start`);
    const before = published.length;
    await post(s.owner, `/v2/agent-shares/${share.id}/close`);
    expect(await runDetail(s.asker, queued.id)).toMatchObject({
      status: "stopped",
      reason: "Sharing was turned off",
      reasonCode: "share_closed",
    });
    expect(await runDetail(s.asker, running.id)).toMatchObject({
      status: "running",
      stopRequested: true,
      reasonCode: "share_closed",
    });
    const events = published.slice(before);
    expect(events.map((event) => event.type).sort()).toEqual(["room.run", "room.run", "room.shares"]);
    // 关闭后再 @：离线「未共享」。
    expect(await ask(s)).toMatchObject({ reason: "Not shared to this room", reasonCode: "not_shared" });
  });

  it("start 前共享已不生效（与发消息并发 / 已到期未扫描）：任务直接已停止「共享已关闭」，started=false，照常推送", async () => {
    const s = await scene("开始复查");
    const share = await openShare(context, s.owner, s.room.id, s.agent.id);
    const queued = await ask(s);
    expect(queued.status).toBe("queued");
    // 模拟并发：关共享的事务提交时还看不到这条排队任务，stopForShare 没停到它（只关共享行）。
    await context.pool.query("UPDATE agent_shares SET closed_at = now(), closed_reason = 'closed' WHERE id = $1", [share.id]);
    const before = published.length;
    const stopped = await post<StartAgentRunResponse>(s.owner, `/v2/agent-runs/${queued.id}/start`);
    expect(stopped).toMatchObject({
      started: false,
      run: {
        id: queued.id,
        status: "stopped",
        reason: "Sharing was turned off",
        reasonCode: "share_closed",
        stopRequested: false,
        startedAt: null,
      },
    });
    expect(stopped.run.finishedAt).not.toBeNull();
    const runEvents = published.slice(before).filter((event) => event.type === "room.run");
    expect(runEvents.map((event) => [event.run?.id, event.run?.status])).toEqual([[queued.id, "stopped"]]);
    // 再 start：已不是排队中，原样返回，不再推送。
    const again = published.length;
    expect(await post<StartAgentRunResponse>(s.owner, `/v2/agent-runs/${queued.id}/start`)).toMatchObject({
      started: false,
      run: { status: "stopped" },
    });
    expect(published.slice(again)).toEqual([]);

    // 共享已到期但扫描还没关：同样停掉。
    const reopened = await openShare(context, s.owner, s.room.id, s.agent.id, "two_hours");
    const expiring = await ask(s);
    expect(expiring.status).toBe("queued");
    await context.pool.query("UPDATE agent_shares SET expires_at = now() - interval '1 second' WHERE id = $1", [reopened.id]);
    expect(await post<StartAgentRunResponse>(s.owner, `/v2/agent-runs/${expiring.id}/start`)).toMatchObject({
      started: false,
      run: { status: "stopped", reason: "Sharing was turned off", reasonCode: "share_closed" },
    });

    // 共享仍生效：照常开始。
    await context.pool.query("UPDATE agent_shares SET expires_at = NULL WHERE id = $1", [reopened.id]);
    const fresh = await ask(s);
    expect(await post<StartAgentRunResponse>(s.owner, `/v2/agent-runs/${fresh.id}/start`)).toMatchObject({
      started: true,
      run: { status: "running" },
    });
  });

  it("回写里的 NUL（字符串值与 JSON key）写库前去掉：progress / complete / finish 不再 500", async () => {
    const s = await scene("NUL");
    await openShare(context, s.owner, s.room.id, s.agent.id);
    const completing = await ask(s);
    const failing = await ask(s);
    await post(s.owner, `/v2/agent-runs/${completing.id}/start`);

    const progressed = await post<AgentRunSummaryDto>(s.owner, `/v2/agent-runs/${completing.id}/progress`, {
      progress: "查看了\u0000 6 个文件",
      events: [{ "ki\u0000nd": "partial", text: "a\u0000b", nested: [{ value: "\u0000" }, 1, null, true] }],
    });
    expect(progressed.progress).toBe("查看了 6 个文件");
    expect((await runDetail(s.owner, completing.id)).events).toEqual([
      { kind: "partial", text: "ab", nested: [{ value: "" }, 1, null, true] },
    ]);

    const completed = await post<AgentRunSummaryDto>(s.owner, `/v2/agent-runs/${completing.id}/complete`, {
      replyBody: "后端已有\u0000 receiverSnapshot",
      summary: "摘\u0000要",
      events: [{ kind: "turn\u0000", "\u0000items": ["x\u0000y"] }],
    });
    expect(completed).toMatchObject({ status: "completed", summary: "摘要" });
    expect((await runDetail(s.owner, completing.id)).events).toEqual([{ kind: "turn", items: ["xy"] }]);
    const thread = (await context.server.inject({
      method: "GET",
      url: `/v2/rooms/${s.room.id}/messages?threadRootId=${completing.triggerMessageId}`,
      headers: s.asker.headers,
    })).json<ListRoomMessagesResponse>().items;
    expect(thread.find((message) => message.id === completed.replyMessageId)?.body).toBe("后端已有 receiverSnapshot");

    await post(s.owner, `/v2/agent-runs/${failing.id}/start`);
    const failed = await post<AgentRunSummaryDto>(s.owner, `/v2/agent-runs/${failing.id}/finish`, {
      status: "failed",
      reason: "本机\u0000出错",
      reasonCode: "run_error",
      reasonParams: { detail: "a\u0000b" },
      events: [{ "\u0000": "\u0000" }],
    });
    expect(failed).toMatchObject({ status: "failed", reason: "本机出错", reasonCode: "run_error", reasonParams: { detail: "ab" } });
    expect((await runDetail(s.owner, failing.id)).events).toEqual([{ "": "" }]);
  });

  it("登记 Agent：设备标识 / 设备名里的 NUL 去掉，合并到同一个 Agent", async () => {
    const owner = await createUser(context, "NUL 登记人");
    const first = await registerAgent(context, owner, "device-nul", "Mac\u0000Book");
    expect(first.deviceName).toBe("MacBook");
    const again = await registerAgent(context, owner, "device-\u0000nul", "MacBook");
    expect(again.id).toBe(first.id);
  });

  it("扫描：到期共享关闭并停任务；掉线 Agent 的排队任务离线；执行中 3 分钟没心跳判失败；推在线变化", async () => {
    const expiring = await scene("到期");
    const share = await openShare(context, expiring.owner, expiring.room.id, expiring.agent.id, "two_hours");
    const expiringRun = await ask(expiring);
    await context.pool.query("UPDATE agent_shares SET expires_at = now() - interval '1 second' WHERE id = $1", [share.id]);

    const dropped = await scene("掉线");
    await openShare(context, dropped.owner, dropped.room.id, dropped.agent.id);
    const droppedQueued = await ask(dropped);
    const droppedRunning = await ask(dropped);
    await post(dropped.owner, `/v2/agent-runs/${droppedRunning.id}/start`);
    // 100 秒没心跳：排队的离线，执行中的还不到 3 分钟。
    await ageAgent(context, dropped.agent.id, 100);
    const before = published.length;
    const firstSweep = await context.rooms.sweeper.runOnce();
    expect(firstSweep.expiredShares).toBeGreaterThanOrEqual(1);
    expect(await runDetail(expiring.asker, expiringRun.id)).toMatchObject({
      status: "stopped",
      reason: "Sharing expired",
      reasonCode: "share_expired",
    });
    const expiredShare = await context.pool.query("SELECT closed_reason FROM agent_shares WHERE id = $1", [share.id]);
    expect(expiredShare.rows[0]).toEqual({ closed_reason: "expired" });
    expect(await runDetail(dropped.asker, droppedQueued.id)).toMatchObject({
      status: "offline",
      reason: "The owner is offline",
      reasonCode: "owner_offline",
    });
    expect((await runDetail(dropped.asker, droppedRunning.id)).status).toBe("running");
    const presence = published.slice(before).filter((event) => event.type === "agent.presence");
    expect(presence.map((event) => event.agent?.id)).toContain(dropped.agent.id);
    expect(presence.find((event) => event.agent?.id === dropped.agent.id)?.agent?.online).toBe(false);

    await ageAgent(context, dropped.agent.id, 200);
    await context.rooms.sweeper.runOnce();
    expect(await runDetail(dropped.asker, droppedRunning.id)).toMatchObject({
      status: "failed",
      reason: "The owner's computer went offline, so the run was interrupted",
      reasonCode: "owner_disconnected",
    });
    // 再扫一次没有新变化（不重复推送下线）。
    const quiet = published.length;
    await context.rooms.sweeper.runOnce();
    expect(published.slice(quiet).filter((event) => event.agent?.id === dropped.agent.id)).toEqual([]);
  });
});
