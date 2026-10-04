import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ListAgentsResponse,
  ListRoomMembersResponse,
  ListRoomMessagesResponse,
  ListRoomsResponse,
  RoomDto,
  RoomMessageDto,
  RoomViewerStateDto,
} from "@suduo/cloud-contracts";
import {
  GATE_C_FIXTURE_HUMAN_TEXTS,
  GATE_C_FIXTURE_IDS,
  startRequirementsServiceFixture,
  type RequirementsServiceFixture,
} from "./requirements-service-fixture.js";
import { containsCjk } from "./untranslated-audit.js";

let fixture: RequirementsServiceFixture;

beforeAll(async () => {
  fixture = await startRequirementsServiceFixture();
});

afterAll(async () => {
  await fixture.close();
});

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(fixture.origin + path, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

const room = `/v2/rooms/${GATE_C_FIXTURE_IDS.projectRoom}`;

describe("gate-c 夹具：项目讨论房间（英文冒烟用）", () => {
  it("项目下只有默认房间，名称跟随项目，预置消息已读", async () => {
    const list = await call<ListRoomsResponse>("GET", `/v2/projects/${GATE_C_FIXTURE_IDS.project}/rooms`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    const [projectRoom] = list.body.items;
    expect(projectRoom).toMatchObject({ id: GATE_C_FIXTURE_IDS.projectRoom, kind: "project_default", name: "Gate C 远程项目" });
    expect(projectRoom?.viewer.unreadCount).toBe(0);
    const detail = await call<RoomDto>("GET", room);
    expect(detail.body.id).toBe(GATE_C_FIXTURE_IDS.projectRoom);
    const members = await call<ListRoomMembersResponse>("GET", `${room}/members`);
    expect(members.body.items).toHaveLength(2);
  });

  it("需求下没有讨论，Agent / 共享都是空列表，别的房间 404", async () => {
    const requirementRooms = await call<ListRoomsResponse>("GET", `/v2/requirements/${GATE_C_FIXTURE_IDS.reqDraft1}/rooms`);
    expect(requirementRooms).toEqual({ status: 200, body: { items: [] } });
    expect((await call<ListAgentsResponse>("GET", "/v2/agents")).body).toEqual({ items: [] });
    expect((await call("GET", `${room}/shares`)).body).toEqual({ items: [] });
    expect((await call("GET", `${room}/share-requests`)).body).toEqual({ items: [] });
    expect((await call("GET", "/v2/rooms/10000000-0000-4000-8000-000000000999")).status).toBe(404);
  });

  it("发消息：201 返回新消息并进消息流；同一 clientId 重试返回已有那条（不拒绝）", async () => {
    const sent = await call<RoomMessageDto>("POST", `${room}/messages`, { clientId: "c-1", body: "Hello" });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ seq: 2, body: "Hello", authorKind: "user", threadRootId: null });
    const retried = await call<RoomMessageDto>("POST", `${room}/messages`, { clientId: "c-1", body: "Hello" });
    expect(retried.status).toBe(200);
    expect(retried.body.id).toBe(sent.body.id);

    const latest = await call<ListRoomMessagesResponse>("GET", `${room}/messages?limit=50`);
    expect(latest.body.items.map((item) => item.seq)).toEqual([1, 2]);
    expect(latest.body).toMatchObject({ hasMoreBefore: false, hasMoreAfter: false, lastSeq: 2 });
    const after = await call<ListRoomMessagesResponse>("GET", `${room}/messages?after=1&limit=50`);
    expect(after.body.items.map((item) => item.body)).toEqual(["Hello"]);
    const older = await call<ListRoomMessagesResponse>("GET", `${room}/messages?before=2&limit=1`);
    expect(older.body.items.map((item) => item.seq)).toEqual([1]);
    expect(fixture.roomMessageBodies()).toContain("Hello");

    const reply = await call<RoomMessageDto>("POST", `${room}/messages`, {
      clientId: "c-2",
      body: "Reply",
      threadRootId: sent.body.id,
      mentions: [{ kind: "all" }, { kind: "user", id: GATE_C_FIXTURE_IDS.userTeammate }],
    });
    expect(reply.status).toBe(201);
    expect(reply.body.mentions.map((mention) => mention.label)).toEqual(["everyone", "Gate C 同事"]);
    const thread = await call<ListRoomMessagesResponse>("GET", `${room}/messages?threadRootId=${sent.body.id}`);
    expect(thread.body.items.map((item) => item.body)).toEqual(["Hello", "Reply"]);
    const main = await call<ListRoomMessagesResponse>("GET", `${room}/messages`);
    expect(main.body.items.find((item) => item.id === sent.body.id)?.thread?.replyCount).toBe(1);
    const found = await call<ListRoomMessagesResponse>("GET", `${room}/messages/search?q=reply`);
    expect(found.body.items.map((item) => item.body)).toEqual(["Reply"]);
  });

  it("参数不合法按 400：空正文、带文件、@ 不存在的人", async () => {
    expect((await call("POST", `${room}/messages`, { clientId: "c-3", body: " " })).status).toBe(400);
    expect((await call("POST", `${room}/messages`, { clientId: "c-4", body: "x", fileIds: ["f"] })).status).toBe(400);
    expect(
      (await call("POST", `${room}/messages`, { clientId: "c-5", body: "x", mentions: [{ kind: "agent", id: "a" }] })).status,
    ).toBe(400);
    expect((await call("GET", `${room}/messages?limit=-1`)).status).toBe(400);
  });

  it("记已读只前进，返回「我的视角」", async () => {
    const read = await call<RoomViewerStateDto>("POST", `${room}/read`, { upToSeq: 0 });
    expect(read.status).toBe(200);
    expect(read.body.lastReadSeq).toBeGreaterThanOrEqual(1);
    expect(read.body.unreadCount).toBe(0);
  });
});

describe("gate-c 夹具：人写内容与报错", () => {
  it("导出的人写内容含项目名、人名、需求标题、材料、评论与讨论消息", () => {
    expect(GATE_C_FIXTURE_HUMAN_TEXTS).toEqual(
      expect.arrayContaining(["Gate C 远程项目", "Gate C 用户", "Gate C 同事", "看板草稿一", "发布材料.txt"]),
    );
  });

  it("报错正文与远程服务一样是英文", async () => {
    const missing = await call<{ error: { message: string } }>("GET", "/v2/nothing-here");
    expect(missing.status).toBe(404);
    expect(containsCjk(missing.body.error.message)).toBe(false);
  });
});
