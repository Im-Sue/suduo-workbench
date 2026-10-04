import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthSessionDto, RoomDto, RoomEventDto, RoomFileDto } from "@suduo/cloud-contracts";
import {
  createProject,
  createUser,
  defaultRoom,
  sendMessage,
  setupRoomsTest,
  type RoomsTestContext,
  type TestUser,
} from "./rooms-test-support.js";

const MAX_FILE_BYTES = 64;
let context: RoomsTestContext;

beforeAll(async () => {
  context = await setupRoomsTest({ name: "rooms_file", maxFileBytes: MAX_FILE_BYTES });
});

afterAll(async () => {
  await context?.close();
});

function multipart(fileName: string, content: Buffer, options: { contentType?: string; extraField?: boolean } = {}) {
  const boundary = `----suduo-room-${randomUUID()}`;
  const parts = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${options.contentType ?? "application/octet-stream"}\r\n\r\n`,
    ),
    content,
    Buffer.from("\r\n"),
  ];
  if (options.extraField === true) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, payload: Buffer.concat(parts) };
}

async function upload(user: TestUser, roomId: string, fileName: string, content: Buffer, options = {}) {
  const body = multipart(fileName, content, options);
  return context.server.inject({
    method: "POST",
    url: `/v2/rooms/${roomId}/files`,
    headers: { ...user.headers, "content-type": body.contentType },
    payload: body.payload,
  });
}

describe("房间文件", () => {
  it("上传：按扩展名定类型与种类；不允许的扩展名 400；超限 413 且不留半截文件；房间不存在 404", async () => {
    const user = await createUser(context, "传文件的人");
    const project = await createProject(context, user, "文件项目");
    const room = await defaultRoom(context, user, project.id);
    const png = Buffer.from("0123456789abcdef");
    const uploaded = await upload(user, room.id, "截图.png", png);
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const file = uploaded.json<RoomFileDto>();
    expect(file).toMatchObject({
      roomId: room.id,
      fileName: "截图.png",
      contentType: "image/png",
      kind: "image",
      sizeBytes: png.length,
      sha256: createHash("sha256").update(png).digest("hex"),
      uploadedBy: { id: user.id, displayName: "传文件的人" },
    });
    const video = (await upload(user, room.id, "录屏.MOV", Buffer.from("fake-mov"))).json<RoomFileDto>();
    expect(video).toMatchObject({ kind: "video", contentType: "video/quicktime" });
    const zip = (await upload(user, room.id, "logs.zip", Buffer.from("PK"))).json<RoomFileDto>();
    expect(zip).toMatchObject({ kind: "file", contentType: "application/zip" });

    const exe = await upload(user, room.id, "tool.exe", Buffer.from("MZ"));
    expect(exe.statusCode).toBe(400);
    expect(exe.json()).toMatchObject({ error: { code: "ATTACHMENT_INVALID" } });
    const extra = await upload(user, room.id, "a.txt", Buffer.from("a"), { extraField: true });
    expect(extra.statusCode).toBe(400);
    const tooLarge = await upload(user, room.id, "big.txt", Buffer.alloc(MAX_FILE_BYTES + 1, 1));
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toMatchObject({ error: { code: "ATTACHMENT_TOO_LARGE" } });
    expect(await readdir(join(context.roomFileRoot, ".staging"))).toEqual([]);
    const exact = await upload(user, room.id, "edge.txt", Buffer.alloc(MAX_FILE_BYTES, 2));
    expect(exact.statusCode).toBe(201);

    const missing = await upload(user, randomUUID(), "a.png", png);
    expect(missing.statusCode).toBe(404);
  });

  it("消息关联文件：只能用本房间的文件；只有附件的消息给出第一个附件与附件数，兜底预览为英文", async () => {
    const user = await createUser(context, "关联文件的人");
    const project = await createProject(context, user, "关联项目");
    const room = await defaultRoom(context, user, project.id);
    const otherProject = await createProject(context, user, "别的项目");
    const otherRoom = await defaultRoom(context, user, otherProject.id);
    const mine = (await upload(user, room.id, "设计稿.png", Buffer.from("png"))).json<RoomFileDto>();
    const foreign = (await upload(user, otherRoom.id, "别处.png", Buffer.from("png"))).json<RoomFileDto>();
    const rejected = await context.server.inject({
      method: "POST",
      url: `/v2/rooms/${room.id}/messages`,
      headers: user.headers,
      payload: { clientId: randomUUID(), body: "", fileIds: [foreign.id] },
    });
    expect(rejected.statusCode).toBe(400);
    const message = await sendMessage(context, user, room.id, { body: "", fileIds: [mine.id, mine.id] });
    expect(message.files.map((file) => file.id)).toEqual([mine.id]);
    const roomView = (await context.server.inject({ method: "GET", url: `/v2/rooms/${room.id}`, headers: user.headers }))
      .json<RoomDto>();
    expect(roomView.lastMessage).toMatchObject({
      preview: "[Image]",
      text: "",
      firstFile: { fileName: "设计稿.png", kind: "image" },
      fileCount: 1,
    });

    const doc = (await upload(user, room.id, "说明.pdf", Buffer.from("pdf"))).json<RoomFileDto>();
    await sendMessage(context, user, room.id, { body: "", fileIds: [doc.id, mine.id] });
    const twoFiles = (await context.server.inject({ method: "GET", url: `/v2/rooms/${room.id}`, headers: user.headers }))
      .json<RoomDto>();
    expect(twoFiles.lastMessage).toMatchObject({
      preview: "[File] 说明.pdf and 1 more",
      text: "",
      firstFile: { fileName: "说明.pdf", kind: "file" },
      fileCount: 2,
    });
  });

  it("下载：整文件 / Range 206 / 后缀 Range / 416；inline 只对安全类型；下载不写审计", async () => {
    const user = await createUser(context, "下载的人");
    const project = await createProject(context, user, "下载项目");
    const room = await defaultRoom(context, user, project.id);
    const content = Buffer.from("0123456789");
    const video = (await upload(user, room.id, "demo.mp4", content)).json<RoomFileDto>();
    const html = (await upload(user, room.id, "page.html", Buffer.from("<script>alert(1)</script>"))).json<RoomFileDto>();
    const auditsBefore = await context.pool.query("SELECT 1 FROM audit_logs");

    const full = await context.server.inject({
      method: "GET",
      url: `/v2/room-files/${video.id}/content`,
      headers: user.headers,
    });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload).toEqual(content);
    expect(full.headers).toMatchObject({
      "accept-ranges": "bytes",
      "content-type": "application/octet-stream",
      "content-length": "10",
      "x-content-type-options": "nosniff",
    });
    expect(full.headers["content-disposition"]).toMatch(/^attachment; filename="demo\.mp4"/u);

    const partial = await context.server.inject({
      method: "GET",
      url: `/v2/room-files/${video.id}/content?disposition=inline`,
      headers: { ...user.headers, range: "bytes=2-5" },
    });
    expect(partial.statusCode).toBe(206);
    expect(partial.rawPayload.toString()).toBe("2345");
    expect(partial.headers).toMatchObject({
      "content-range": "bytes 2-5/10",
      "content-length": "4",
      "content-type": "video/mp4",
    });
    expect(partial.headers["content-disposition"]).toMatch(/^inline;/u);

    const suffix = await context.server.inject({
      method: "GET",
      url: `/v2/room-files/${video.id}/content`,
      headers: { ...user.headers, range: "bytes=-3" },
    });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.rawPayload.toString()).toBe("789");

    const open = await context.server.inject({
      method: "GET",
      url: `/v2/room-files/${video.id}/content`,
      headers: { ...user.headers, range: "bytes=7-" },
    });
    expect(open.headers["content-range"]).toBe("bytes 7-9/10");

    const unsatisfiable = await context.server.inject({
      method: "GET",
      url: `/v2/room-files/${video.id}/content`,
      headers: { ...user.headers, range: "bytes=10-20" },
    });
    expect(unsatisfiable.statusCode).toBe(416);
    expect(unsatisfiable.headers["content-range"]).toBe("bytes */10");

    // html 即使要求 inline 也按附件下载，不让浏览器当页面执行。
    const page = await context.server.inject({
      method: "GET",
      url: `/v2/room-files/${html.id}/content?disposition=inline`,
      headers: user.headers,
    });
    expect(page.headers["content-type"]).toBe("application/octet-stream");
    expect(page.headers["content-disposition"]).toMatch(/^attachment;/u);

    const missing = await context.server.inject({
      method: "GET",
      url: `/v2/room-files/${randomUUID()}/content`,
      headers: user.headers,
    });
    expect(missing.statusCode).toBe(404);
    const auditsAfter = await context.pool.query("SELECT 1 FROM audit_logs");
    expect(auditsAfter.rowCount).toBe(auditsBefore.rowCount);
  });
});

describe("登录续期", () => {
  it("用有效令牌换新令牌；新令牌可用；没有令牌 401", async () => {
    const user = await createUser(context, "续期的人");
    const response = await context.server.inject({ method: "POST", url: "/v2/auth/refresh", headers: user.headers });
    expect(response.statusCode).toBe(200);
    const session = response.json<AuthSessionDto>();
    expect(session).toMatchObject({ tokenType: "Bearer", user: { id: user.id, displayName: "续期的人" } });
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());
    const me = await context.server.inject({
      method: "GET",
      url: "/v2/auth/me",
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    const anonymous = await context.server.inject({ method: "POST", url: "/v2/auth/refresh" });
    expect(anonymous.statusCode).toBe(401);
  });
});

interface SseFrame {
  id: string | null;
  event: string | null;
  data: string;
}

/** 读 SSE 流：按空行切帧，按条件等下一帧。 */
class SseReader {
  private buffer = "";
  private readonly frames: SseFrame[] = [];
  private readonly decoder = new TextDecoder();

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async next(predicate: (frame: SseFrame) => boolean = () => true, timeoutMs = 3_000): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.frames.findIndex(predicate);
      if (index >= 0) return this.frames.splice(index, 1)[0]!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("等待 SSE 帧超时");
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      if (chunk === null) continue;
      if (chunk.done) throw new Error("SSE 流已结束");
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
      let separator = this.buffer.indexOf("\n\n");
      while (separator >= 0) {
        const raw = this.buffer.slice(0, separator);
        this.buffer = this.buffer.slice(separator + 2);
        const frame = parseFrame(raw);
        if (frame !== null) this.frames.push(frame);
        separator = this.buffer.indexOf("\n\n");
      }
    }
  }

  /** 已收到但还没取走的房间帧。 */
  pendingRoomFrames(): SseFrame[] {
    return this.frames.filter((frame) => frame.event === "room");
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

function parseFrame(raw: string): SseFrame | null {
  let id: string | null = null;
  let event: string | null = null;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":") || line.startsWith("retry:")) continue;
    if (line.startsWith("id: ")) id = line.slice(4);
    else if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  return data.length === 0 ? null : { id, event, data: data.join("\n") };
}

describe("实时推送 /v2/events", () => {
  it("ready 带 epoch；房间事件为命名事件 room（数字 id、带内容）；需求事件格式不变；Last-Event-ID 补发", async () => {
    await context.server.listen({ host: "127.0.0.1", port: 0 });
    const { port } = context.server.server.address() as AddressInfo;
    const user = await createUser(context, "推送的人");
    const project = await createProject(context, user, "推送项目");
    const room = await defaultRoom(context, user, project.id);
    const connect = async (query = "", lastEventId?: number) => {
      const response = await fetch(`http://127.0.0.1:${port}/v2/events${query}`, {
        headers: {
          Authorization: user.headers.authorization,
          ...(lastEventId === undefined ? {} : { "Last-Event-ID": String(lastEventId) }),
        },
      });
      expect(response.status).toBe(200);
      const body = response.body;
      if (body === null) throw new Error("没有响应体");
      return new SseReader(body.getReader());
    };

    const first = await connect();
    const ready = await first.next((frame) => frame.event === "ready");
    expect(JSON.parse(ready.data)).toEqual({ epoch: context.rooms.realtime.epoch });

    const message = await sendMessage(context, user, room.id, { body: "推送测试" });
    const roomFrame = await first.next((frame) => frame.event === "room");
    const event = JSON.parse(roomFrame.data) as RoomEventDto;
    expect(roomFrame.id).toBe(String(event.id));
    expect(event).toMatchObject({
      type: "room.message",
      projectId: project.id,
      roomId: room.id,
      message: { id: message.id, body: "推送测试", seq: message.seq },
    });

    // 需求事件：默认事件名、uuid id、只提示刷新。
    await context.server.inject({
      method: "PATCH",
      url: `/v2/projects/${project.id}`,
      headers: user.headers,
      payload: { name: "推送项目（改名）" },
    });
    const requirementFrame = await first.next((frame) => frame.event === null);
    expect(requirementFrame.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.parse(requirementFrame.data)).toMatchObject({ type: "project.changed", projectId: project.id });
    await first.close();

    // 断线期间的两条消息：带 Last-Event-ID + 同 epoch 重连时补发。
    const missedA = await sendMessage(context, user, room.id, { body: "断线期间 A" });
    const missedB = await sendMessage(context, user, room.id, { body: "断线期间 B" });
    const resumed = await connect(`?epoch=${context.rooms.realtime.epoch}`, event.id);
    await resumed.next((frame) => frame.event === "ready");
    const replayA = JSON.parse((await resumed.next((frame) => frame.event === "room")).data) as RoomEventDto;
    const replayB = JSON.parse((await resumed.next((frame) => frame.event === "room")).data) as RoomEventDto;
    expect([replayA.id, replayB.id]).toEqual([event.id + 1, event.id + 2]);
    expect([replayA.message?.id, replayB.message?.id]).toEqual([missedA.id, missedB.id]);
    await resumed.close();

    // epoch 不一致：不补发（客户端应按房间序号补拉），只收新事件。
    const stale = await connect("?epoch=old-epoch", event.id);
    await stale.next((frame) => frame.event === "ready");
    const fresh = await sendMessage(context, user, room.id, { body: "新消息" });
    const live = JSON.parse((await stale.next((frame) => frame.event === "room")).data) as RoomEventDto;
    expect(live.message?.id).toBe(fresh.id);
    expect(stale.pendingRoomFrames()).toEqual([]);
    await stale.close();
  });
});
