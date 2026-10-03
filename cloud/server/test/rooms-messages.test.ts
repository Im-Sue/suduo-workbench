import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ListRoomMembersResponse,
  ListRoomMessagesResponse,
  RoomDto,
  RoomMessageDto,
  RoomViewerStateDto,
} from "@suduo/cloud-contracts";
import type { QueryExecutor } from "../src/infrastructure/database.js";
import { RoomRepository } from "../src/infrastructure/rooms/room-repository.js";
import {
  createProject,
  createRequirement,
  createUser,
  defaultRoom,
  registerAgent,
  sendMessage,
  setupRoomsTest,
  type RoomsTestContext,
  type TestUser,
} from "./rooms-test-support.js";

let context: RoomsTestContext;

beforeAll(async () => {
  context = await setupRoomsTest({ name: "rooms_msg" });
});

afterAll(async () => {
  await context?.close();
});

async function getRoom(user: TestUser, roomId: string): Promise<RoomDto> {
  const response = await context.server.inject({ method: "GET", url: `/v2/rooms/${roomId}`, headers: user.headers });
  expect(response.statusCode).toBe(200);
  return response.json<RoomDto>();
}

async function listMessages(user: TestUser, roomId: string, query = ""): Promise<ListRoomMessagesResponse> {
  const response = await context.server.inject({
    method: "GET",
    url: `/v2/rooms/${roomId}/messages${query}`,
    headers: user.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<ListRoomMessagesResponse>();
}

describe("项目默认房间", () => {
  it("列房间时惰性创建，重复列不重复建；名称跟随项目改名", async () => {
    const owner = await createUser(context, "陈思远");
    const project = await createProject(context, owner, "订单中心");
    const first = await defaultRoom(context, owner, project.id);
    const second = await defaultRoom(context, owner, project.id);
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ kind: "project_default", name: "订单中心", requirement: null, lastSeq: 0 });
    expect(first.viewer.joined).toBe(true);
    const count = await context.pool.query(
      "SELECT count(*)::integer AS count FROM rooms WHERE project_id = $1 AND kind = 'project_default'",
      [project.id],
    );
    expect(count.rows[0]).toEqual({ count: 1 });

    const renamed = await context.server.inject({
      method: "PATCH",
      url: `/v2/projects/${project.id}`,
      headers: owner.headers,
      payload: { name: "订单中心 2.0" },
    });
    expect(renamed.statusCode).toBe(200);
    expect((await getRoom(owner, first.id)).name).toBe("订单中心 2.0");

    // 默认房间不能改名（输入错误 400），但可以归档。
    const rename = await context.server.inject({
      method: "PATCH",
      url: `/v2/rooms/${first.id}`,
      headers: owner.headers,
      payload: { name: "别的名字" },
    });
    expect(rename.statusCode).toBe(400);
    expect(rename.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

    // 默认房间成员 = 全部用户（隐式，没有加入时间）。
    const other = await createUser(context, "李娜");
    const members = await context.server.inject({
      method: "GET",
      url: `/v2/rooms/${first.id}/members`,
      headers: other.headers,
    });
    const items = members.json<ListRoomMembersResponse>().items;
    expect(items.map((item) => item.user.id)).toEqual(expect.arrayContaining([owner.id, other.id]));
    expect(items.every((item) => item.joinedAt === null)).toBe(true);
  });

  it("不存在的项目 404", async () => {
    const user = await createUser(context, "路人");
    const response = await context.server.inject({
      method: "GET",
      url: `/v2/projects/${randomUUID()}/rooms`,
      headers: user.headers,
    });
    expect(response.statusCode).toBe(404);
  });

  it("默认房间已存在时列房间只查不写（侧栏轮询不再每次 INSERT）", async () => {
    const owner = await createUser(context, "轮询人");
    const project = await createProject(context, owner, "轮询项目");
    const repository = new RoomRepository(context.database);
    const statements: string[] = [];
    const recording: QueryExecutor = {
      query(text, values) {
        statements.push(text);
        return context.database.query(text, values);
      },
    };
    const inserts = () => statements.filter((text) => /INSERT\s+INTO\s+rooms/u.test(text));

    expect(await repository.ensureDefaultRoom(project.id, recording)).toBe(true);
    expect(inserts()).toHaveLength(1);
    statements.length = 0;
    expect(await repository.ensureDefaultRoom(project.id, recording)).toBe(true);
    expect(statements).toHaveLength(1);
    expect(inserts()).toEqual([]);
    statements.length = 0;
    expect(await repository.ensureDefaultRoom(randomUUID(), recording)).toBe(false);
    expect(inserts()).toEqual([]);
    const count = await context.pool.query(
      "SELECT count(*)::integer AS count FROM rooms WHERE project_id = $1 AND kind = 'project_default'",
      [project.id],
    );
    expect(count.rows[0]).toEqual({ count: 1 });
  });
});

describe("消息", () => {
  it("序号连续（含并发）；客户端 ID 合并返回同一条（200）且不占序号", async () => {
    const user = await createUser(context, "王五");
    const project = await createProject(context, user, "序号项目");
    const room = await defaultRoom(context, user, project.id);
    const sent = await Promise.all(
      Array.from({ length: 12 }, (_, index) => sendMessage(context, user, room.id, { body: `第 ${index} 条` })),
    );
    expect(sent.map((message) => message.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );

    const clientId = randomUUID();
    const original = await sendMessage(context, user, room.id, { clientId, body: "重试的消息" });
    expect(original.seq).toBe(13);
    // 网络重试（正文哪怕不同）：返回已有那一条，HTTP 200，不分配新序号。
    const retried = await Promise.all([
      sendMessage(context, user, room.id, { clientId, body: "重试的消息" }, 200),
      sendMessage(context, user, room.id, { clientId, body: "重试的消息（又一次）" }, 200),
    ]);
    expect(retried.map((message) => message.id)).toEqual([original.id, original.id]);
    expect((await getRoom(user, room.id)).lastSeq).toBe(13);
  });

  it("分页：最新一页、before 向上翻、after 补拉、话题过滤", async () => {
    const user = await createUser(context, "翻页人");
    const project = await createProject(context, user, "翻页项目");
    const room = await defaultRoom(context, user, project.id);
    for (let index = 1; index <= 7; index += 1) {
      await sendMessage(context, user, room.id, { body: `消息 ${index}` });
    }
    const latest = await listMessages(user, room.id, "?limit=3");
    expect(latest.items.map((item) => item.seq)).toEqual([5, 6, 7]);
    expect(latest).toMatchObject({ hasMoreBefore: true, hasMoreAfter: false, lastSeq: 7 });

    const older = await listMessages(user, room.id, "?before=5&limit=3");
    expect(older.items.map((item) => item.seq)).toEqual([2, 3, 4]);
    expect(older).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });

    const oldest = await listMessages(user, room.id, "?before=2&limit=3");
    expect(oldest.items.map((item) => item.seq)).toEqual([1]);
    expect(oldest.hasMoreBefore).toBe(false);

    const after = await listMessages(user, room.id, "?after=2&limit=2");
    expect(after.items.map((item) => item.seq)).toEqual([3, 4]);
    expect(after).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });
    const tail = await listMessages(user, room.id, "?after=7");
    expect(tail).toMatchObject({ items: [], hasMoreAfter: false, hasMoreBefore: true });

    const tooMany = await context.server.inject({
      method: "GET",
      url: `/v2/rooms/${room.id}/messages?limit=201`,
      headers: user.headers,
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it("话题：回复计入根消息，回复的回复归到同一个根；最近回复者最多 3 个", async () => {
    const author = await createUser(context, "话题发起人");
    const repliers = await Promise.all(["甲", "乙", "丙", "丁"].map((name) => createUser(context, name)));
    const project = await createProject(context, author, "话题项目");
    const room = await defaultRoom(context, author, project.id);
    const root = await sendMessage(context, author, room.id, { body: "大家看看这个" });
    expect(root.thread).toBeNull();
    const firstReply = await sendMessage(context, repliers[0]!, room.id, { body: "收到", threadRootId: root.id });
    expect(firstReply.threadRootId).toBe(root.id);
    // 回复「回复」：归到根。
    const nested = await sendMessage(context, repliers[1]!, room.id, { body: "+1", threadRootId: firstReply.id });
    expect(nested.threadRootId).toBe(root.id);
    await sendMessage(context, repliers[2]!, room.id, { body: "我也看看", threadRootId: root.id });
    await sendMessage(context, repliers[3]!, room.id, { body: "好", threadRootId: root.id });

    const thread = await listMessages(author, room.id, `?threadRootId=${root.id}`);
    expect(thread.items.map((item) => item.id)[0]).toBe(root.id);
    expect(thread.items).toHaveLength(5);
    const rootView = thread.items[0]!;
    expect(rootView.thread?.replyCount).toBe(4);
    expect(rootView.thread?.lastReplyAt).not.toBeNull();
    expect(rootView.thread?.lastRepliers.map((user) => user.displayName)).toEqual(["丁", "丙", "乙"]);
    expect(thread.items.slice(1).every((item) => item.thread === null)).toBe(true);

    const foreign = await context.server.inject({
      method: "POST",
      url: `/v2/rooms/${room.id}/messages`,
      headers: author.headers,
      payload: { clientId: randomUUID(), body: "错房间的话题", threadRootId: randomUUID() },
    });
    expect(foreign.statusCode).toBe(400);
  });

  it("未读只算别人发的；@ 我 / @ 所有人计入 @ 未读；已读只前进", async () => {
    const alice = await createUser(context, "爱丽丝");
    const bob = await createUser(context, "鲍勃");
    const project = await createProject(context, alice, "未读项目");
    const room = await defaultRoom(context, alice, project.id);
    await sendMessage(context, alice, room.id, { body: "普通消息" });
    const mentionBob = await sendMessage(context, alice, room.id, {
      body: "@鲍勃 看一下",
      mentions: [{ kind: "user", id: bob.id }, { kind: "user", id: bob.id }],
    });
    expect(mentionBob.mentions).toEqual([{ kind: "user", id: bob.id, label: "鲍勃" }]);
    const mentionAll = await sendMessage(context, alice, room.id, { body: "@所有人 开会", mentions: [{ kind: "all" }] });
    expect(mentionAll.mentions).toEqual([{ kind: "all", id: null, label: "所有人" }]);
    await sendMessage(context, bob, room.id, { body: "我自己发的" });

    const aliceView = (await getRoom(alice, room.id)).viewer;
    // 爱丽丝发消息时已读到自己那条；鲍勃那条算未读。
    expect(aliceView).toMatchObject({ joined: true, lastReadSeq: 3, unreadCount: 1, mentionCount: 0 });
    const bobRoom = await getRoom(bob, room.id);
    // 鲍勃发消息时已读到第 4 条：之前的都算读过。
    expect(bobRoom.viewer).toMatchObject({ lastReadSeq: 4, unreadCount: 0, mentionCount: 0 });
    expect(bobRoom.lastMessage).toMatchObject({ seq: 4, authorName: "鲍勃", preview: "我自己发的" });

    await sendMessage(context, alice, room.id, { body: "@鲍勃 再看一下", mentions: [{ kind: "user", id: bob.id }] });
    await sendMessage(context, alice, room.id, { body: "x".repeat(200) });
    const unread = await getRoom(bob, room.id);
    expect(unread.viewer).toMatchObject({ unreadCount: 2, mentionCount: 1 });
    expect(unread.lastMessage?.preview).toBe(`${"x".repeat(80)}…`);

    const markRead = async (upToSeq: number) => {
      const response = await context.server.inject({
        method: "POST",
        url: `/v2/rooms/${room.id}/read`,
        headers: bob.headers,
        payload: { upToSeq },
      });
      expect(response.statusCode).toBe(200);
      return response.json<RoomViewerStateDto>();
    };
    expect(await markRead(5)).toMatchObject({ lastReadSeq: 5, unreadCount: 1, mentionCount: 0 });
    // 回退按不变处理，不报错。
    expect(await markRead(2)).toMatchObject({ lastReadSeq: 5, unreadCount: 1 });
    // 超过最大序号按最大序号算。
    expect(await markRead(999)).toMatchObject({ lastReadSeq: 6, unreadCount: 0 });
  });

  it("关键词搜索（不分大小写，转义通配符）", async () => {
    const user = await createUser(context, "搜索人");
    const project = await createProject(context, user, "搜索项目");
    const room = await defaultRoom(context, user, project.id);
    await sendMessage(context, user, room.id, { body: "订单详情 receiverSnapshot" });
    await sendMessage(context, user, room.id, { body: "无关" });
    await sendMessage(context, user, room.id, { body: "RECEIVERsnapshot 前端没展示" });
    await sendMessage(context, user, room.id, { body: "100% 完成" });
    const search = async (q: string) => {
      const response = await context.server.inject({
        method: "GET",
        url: `/v2/rooms/${room.id}/messages/search?q=${encodeURIComponent(q)}`,
        headers: user.headers,
      });
      expect(response.statusCode).toBe(200);
      return response.json<ListRoomMessagesResponse>();
    };
    expect((await search("receiversnapshot")).items.map((item) => item.seq)).toEqual([1, 3]);
    expect((await search("%")).items.map((item) => item.seq)).toEqual([4]);
    const limited = await context.server.inject({
      method: "GET",
      url: `/v2/rooms/${room.id}/messages/search?q=receiver&limit=1`,
      headers: user.headers,
    });
    expect(limited.json<ListRoomMessagesResponse>()).toMatchObject({ hasMoreBefore: true });
    expect(limited.json<ListRoomMessagesResponse>().items.map((item) => item.seq)).toEqual([3]);
  });

  it("@ 不存在的人 400；空消息 400", async () => {
    const user = await createUser(context, "校验人");
    const project = await createProject(context, user, "校验项目");
    const room = await defaultRoom(context, user, project.id);
    const unknown = await context.server.inject({
      method: "POST",
      url: `/v2/rooms/${room.id}/messages`,
      headers: user.headers,
      payload: { clientId: randomUUID(), body: "@谁", mentions: [{ kind: "user", id: randomUUID() }] },
    });
    expect(unknown.statusCode).toBe(400);
    const empty = await context.server.inject({
      method: "POST",
      url: `/v2/rooms/${room.id}/messages`,
      headers: user.headers,
      payload: { clientId: randomUUID(), body: "   " },
    });
    expect(empty.statusCode).toBe(400);
  });

  it("正文 / 客户端 ID / 搜索词 / 房间名里的 NUL 写库前去掉，不再 500；只剩 NUL 的按空处理（400）", async () => {
    const user = await createUser(context, "NUL 发送人");
    const project = await createProject(context, user, "NUL 项目");
    const room = await defaultRoom(context, user, project.id);
    const clientId = `nul-\u0000-${randomUUID()}`;
    const sent = await sendMessage(context, user, room.id, { clientId, body: "订单\u0000详情" });
    expect(sent).toMatchObject({ body: "订单详情", clientId: clientId.replaceAll("\u0000", "") });
    // 同一个（带 NUL 的）客户端 ID 重试：仍合并到同一条。
    expect((await sendMessage(context, user, room.id, { clientId, body: "订单\u0000详情" }, 200)).id).toBe(sent.id);

    const onlyNul = await context.server.inject({
      method: "POST",
      url: `/v2/rooms/${room.id}/messages`,
      headers: user.headers,
      payload: { clientId: randomUUID(), body: "\u0000\u0000" },
    });
    expect(onlyNul.statusCode).toBe(400);
    const nulClientId = await context.server.inject({
      method: "POST",
      url: `/v2/rooms/${room.id}/messages`,
      headers: user.headers,
      payload: { clientId: "\u0000", body: "你好" },
    });
    expect(nulClientId.statusCode).toBe(400);
    expect(nulClientId.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

    const search = await context.server.inject({
      method: "GET",
      url: `/v2/rooms/${room.id}/messages/search?q=${encodeURIComponent("订单\u0000")}`,
      headers: user.headers,
    });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json<ListRoomMessagesResponse>().items.map((item) => item.id)).toEqual([sent.id]);

    const requirement = await createRequirement(context, user, project.id);
    const created = await context.server.inject({
      method: "POST",
      url: `/v2/requirements/${requirement.id}/rooms`,
      headers: user.headers,
      payload: { name: "联\u0000调" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const renamed = await context.server.inject({
      method: "PATCH",
      url: `/v2/rooms/${created.json<RoomDto>().id}`,
      headers: user.headers,
      payload: { name: "联调\u0000 二" },
    });
    expect(created.json<RoomDto>().name).toBe("联调");
    expect(renamed.json<RoomDto>().name).toBe("联调 二");
  });
});

describe("需求房间", () => {
  it("初始成员 = 创建人 + 需求负责人 + 需求创建人 + memberIds；缺省名「REQ-n 讨论」；发言自动加入", async () => {
    const pm = await createUser(context, "产品经理");
    const developer = await createUser(context, "开发");
    const tester = await createUser(context, "测试");
    const roomCreator = await createUser(context, "建房间的人");
    const outsider = await createUser(context, "路过的人");
    const project = await createProject(context, pm, "需求房间项目");
    const requirement = await createRequirement(context, pm, project.id, { assigneeId: developer.id });

    const created = await context.server.inject({
      method: "POST",
      url: `/v2/requirements/${requirement.id}/rooms`,
      headers: roomCreator.headers,
      payload: { memberIds: [tester.id] },
    });
    expect(created.statusCode).toBe(201);
    const room = created.json<RoomDto>();
    expect(room).toMatchObject({
      kind: "requirement",
      name: `REQ-${requirement.number} 讨论`,
      requirement: { id: requirement.id, number: requirement.number, title: requirement.title },
      memberCount: 4,
      createdBy: { id: roomCreator.id, displayName: "建房间的人" },
    });
    const members = await context.server.inject({
      method: "GET",
      url: `/v2/rooms/${room.id}/members`,
      headers: pm.headers,
    });
    expect(members.json<ListRoomMembersResponse>().items.map((item) => item.user.id).sort()).toEqual(
      [pm.id, developer.id, tester.id, roomCreator.id].sort(),
    );

    // 需求房间列表、项目房间列表都能看到。
    const byRequirement = await context.server.inject({
      method: "GET",
      url: `/v2/requirements/${requirement.id}/rooms`,
      headers: outsider.headers,
    });
    expect(byRequirement.json<{ items: RoomDto[] }>().items.map((item) => item.id)).toEqual([room.id]);
    const byProject = await context.server.inject({
      method: "GET",
      url: `/v2/projects/${project.id}/rooms`,
      headers: outsider.headers,
    });
    expect(byProject.json<{ items: RoomDto[] }>().items.map((item) => item.kind)).toEqual(["project_default", "requirement"]);

    // 不是成员：可见、没有未读。
    await sendMessage(context, pm, room.id, { body: "需求房间第一条" });
    expect((await getRoom(outsider, room.id)).viewer).toMatchObject({ joined: false, unreadCount: 0, mentionCount: 0 });
    // 发言自动加入。
    await sendMessage(context, outsider, room.id, { body: "我也来" });
    const joined = await getRoom(outsider, room.id);
    expect(joined.viewer).toMatchObject({ joined: true, lastReadSeq: 2 });
    expect(joined.memberCount).toBe(5);

    // 主动加入 / 拉人：已是成员的合并。
    const late = await createUser(context, "后来的人");
    const add = await context.server.inject({
      method: "POST",
      url: `/v2/rooms/${room.id}/members`,
      headers: pm.headers,
      payload: { userIds: [late.id, pm.id] },
    });
    expect(add.statusCode).toBe(200);
    expect(add.json<ListRoomMembersResponse>().items).toHaveLength(6);
    // 加入后的已读位置从当前序号起，不背历史未读。
    expect((await getRoom(late, room.id)).viewer).toMatchObject({ joined: true, lastReadSeq: 2, unreadCount: 0 });
    const self = await context.server.inject({ method: "POST", url: `/v2/rooms/${room.id}/members`, headers: late.headers });
    expect(self.statusCode).toBe(200);
    expect(self.json<ListRoomMembersResponse>().items).toHaveLength(6);

    // 改名、自定名字。
    const renamed = await context.server.inject({
      method: "PATCH",
      url: `/v2/rooms/${room.id}`,
      headers: tester.headers,
      payload: { name: "  联调  " },
    });
    expect(renamed.json<RoomDto>().name).toBe("联调");
    const named = await context.server.inject({
      method: "POST",
      url: `/v2/requirements/${requirement.id}/rooms`,
      headers: pm.headers,
      payload: { name: "REQ 评审" },
    });
    expect(named.json<RoomDto>()).toMatchObject({ name: "REQ 评审", memberCount: 2 });
  });

  it("归档后晚到的消息照常收下（含 @ 建任务，ADR-0004 不拒绝）；客户端 ID 重试仍合并；取消归档后可再发", async () => {
    const user = await createUser(context, "归档人");
    const project = await createProject(context, user, "归档项目");
    const requirement = await createRequirement(context, user, project.id);
    const agent = await registerAgent(context, user);
    const room = (await context.server.inject({
      method: "POST",
      url: `/v2/requirements/${requirement.id}/rooms`,
      headers: user.headers,
    })).json<RoomDto>();
    const clientId = randomUUID();
    const before = await sendMessage(context, user, room.id, { clientId, body: "归档前" });
    const archive = await context.server.inject({
      method: "PATCH",
      url: `/v2/rooms/${room.id}`,
      headers: user.headers,
      payload: { archived: true },
    });
    expect(archive.json<RoomDto>().archivedAt).not.toBeNull();
    // 界面没刷新时晚到的消息：收下，@ 与未归档一样处理（这里没共享 → 离线「未共享到这个房间」）。
    const lateClientId = randomUUID();
    const late = await sendMessage(context, user, room.id, {
      clientId: lateClientId,
      body: "归档后晚到 @Codex",
      mentions: [{ kind: "agent", id: agent.id }],
    });
    expect(late.seq).toBe(before.seq + 1);
    expect(late.runs.map((run) => [run.status, run.reason])).toEqual([["offline", "未共享到这个房间"]]);
    // 客户端 ID 重试仍合并（归档前、归档后各一条）。
    const replayLate = await sendMessage(context, user, room.id, { clientId: lateClientId, body: "归档后晚到 @Codex" }, 200);
    expect(replayLate.id).toBe(late.id);
    const replay: RoomMessageDto = await sendMessage(context, user, room.id, { clientId, body: "归档前" }, 200);
    expect(replay.id).toBe(before.id);
    // 房间仍是归档状态，历史可看。
    expect((await getRoom(user, room.id)).archivedAt).not.toBeNull();
    expect((await listMessages(user, room.id)).items.map((message) => message.id)).toEqual([before.id, late.id]);
    await context.server.inject({
      method: "PATCH",
      url: `/v2/rooms/${room.id}`,
      headers: user.headers,
      payload: { archived: false },
    });
    await sendMessage(context, user, room.id, { body: "取消归档后" });
  });

  it("审计：默认房间归档 requirement_id 为空；需求房间创建带需求", async () => {
    const user = await createUser(context, "审计人");
    const project = await createProject(context, user, "审计项目");
    const room = await defaultRoom(context, user, project.id);
    await context.server.inject({
      method: "PATCH",
      url: `/v2/rooms/${room.id}`,
      headers: user.headers,
      payload: { archived: true },
    });
    const requirement = await createRequirement(context, user, project.id);
    const created = (await context.server.inject({
      method: "POST",
      url: `/v2/requirements/${requirement.id}/rooms`,
      headers: user.headers,
    })).json<RoomDto>();
    const audits = await context.pool.query<{ resource_id: string; action: string; requirement_id: string | null }>(
      "SELECT resource_id, action, requirement_id FROM audit_logs WHERE resource_type = 'room' AND project_id = $1 ORDER BY created_at",
      [project.id],
    );
    expect(audits.rows).toEqual([
      { resource_id: room.id, action: "room.archived", requirement_id: null },
      { resource_id: created.id, action: "room.created", requirement_id: requirement.id },
    ]);
    // 没有实际变化的 PATCH 不写审计。
    await context.server.inject({
      method: "PATCH",
      url: `/v2/rooms/${room.id}`,
      headers: user.headers,
      payload: { archived: true },
    });
    const after = await context.pool.query("SELECT 1 FROM audit_logs WHERE resource_type = 'room' AND project_id = $1", [project.id]);
    expect(after.rowCount).toBe(2);
    // /v2/audit 过渡期不返回房间动作（前端穷举文案表）。
    const listed = await context.server.inject({
      method: "GET",
      url: `/v2/audit?projectId=${project.id}`,
      headers: user.headers,
    });
    expect(listed.json<{ items: Array<{ action: string }> }>().items.some((item) => item.action.startsWith("room."))).toBe(false);
  });
});
