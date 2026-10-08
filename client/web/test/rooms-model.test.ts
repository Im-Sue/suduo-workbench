import { describe, expect, it } from "vitest";
import { collectMentions } from "../src/features/rooms/drafts.js";
import {
  agentAvailabilityNote,
  agentLabel,
  agentName,
  applyRunToMessages,
  buildMentionCandidates,
  canRetryRun,
  canStopRun,
  catchUpAfter,
  endOfLocalDay,
  expiresLabel,
  lastMessageAuthor,
  lastMessagePreview,
  shareDurationOf,
  mentionHighlights,
  mergeMessages,
  mergeOlderPage,
  mergeThreadRefetch,
  roomAfterMessage,
  roomAfterRead,
  rootMessages,
  runStatusText,
  sortRooms,
  totalUnread,
  type MessagesData,
} from "../src/features/rooms/model.js";
import { agent, member, message, ME, room, run, share, WANG, ZHANG } from "./fixtures/rooms.js";
import { formatDayLabel } from "../src/ui/format.js";

const data = (items: MessagesData["items"], lastSeq = 0): MessagesData => ({ items, hasMoreBefore: false, lastSeq });

describe("房间消息合并", () => {
  it("同 id 替换、新消息按序号插入；新回复给缓存里的根加计数与最近回复者", () => {
    const root = message({ id: "m-1", seq: 1 });
    const base = data([root, message({ id: "m-3", seq: 3 })], 3);
    const reply = message({ id: "m-4", seq: 4, threadRootId: "m-1", author: ZHANG });
    const { data: next, added } = mergeMessages(base, [message({ id: "m-2", seq: 2, body: "补到的" }), reply]);
    expect(next.items.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    expect(added.map((item) => item.id)).toEqual(["m-2", "m-4"]);
    expect(next.lastSeq).toBe(4);
    const bumped = next.items.find((item) => item.id === "m-1");
    expect(bumped?.thread?.replyCount).toBe(1);
    expect(bumped?.thread?.lastRepliers.map((user) => user.id)).toEqual([ZHANG.id]);
  });

  it("根本身也在这一批里时以服务端为准，不重复加；已有的回复再来一次也不加", () => {
    const base = data([message({ id: "m-1", seq: 1 }), message({ id: "m-4", seq: 4, threadRootId: "m-1" })], 4);
    const serverRoot = message({ id: "m-1", seq: 1, thread: { replyCount: 2, lastReplyAt: null, lastRepliers: [] } });
    const after = mergeMessages(base, [serverRoot, message({ id: "m-5", seq: 5, threadRootId: "m-1" })]).data;
    expect(after.items.find((item) => item.id === "m-1")?.thread?.replyCount).toBe(2);
    const again = mergeMessages(after, [message({ id: "m-5", seq: 5, threadRootId: "m-1", body: "改过" })]).data;
    expect(again.items.find((item) => item.id === "m-1")?.thread?.replyCount).toBe(2);
  });

  it("根是这一批里新出现的（向上翻历史、断线补拉）：服务端给的根已经算上同批的回复，不再加", () => {
    // 补拉：缓存停在 10，这一批带回了新的根 m-20 和它的两条回复。
    const base = data([message({ id: "m-10", seq: 10 })], 10);
    const root = message({ id: "m-20", seq: 20, thread: { replyCount: 2, lastReplyAt: null, lastRepliers: [ZHANG] } });
    const caughtUp = mergeMessages(base, [
      root,
      message({ id: "m-21", seq: 21, threadRootId: "m-20", author: ZHANG }),
      message({ id: "m-22", seq: 22, threadRootId: "m-20", author: ZHANG }),
    ]).data;
    expect(caughtUp.items.find((item) => item.id === "m-20")?.thread?.replyCount).toBe(2);
    // 回复在根前面出现也一样（同一批里的顺序不影响）。
    const reversed = mergeMessages(base, [message({ id: "m-21", seq: 21, threadRootId: "m-20" }), root]).data;
    expect(reversed.items.find((item) => item.id === "m-20")?.thread?.replyCount).toBe(2);
    // 之后实时来的新回复（根不在这一批里）照常 +1。
    const live = mergeMessages(caughtUp, [message({ id: "m-23", seq: 23, threadRootId: "m-20" })]).data;
    expect(live.items.find((item) => item.id === "m-20")?.thread?.replyCount).toBe(3);
  });

  it("更早的一页按 id 合并、不给根加计数，「还有更早的」以这一页为准", () => {
    const root = message({ id: "m-1", seq: 1, thread: { replyCount: 3, lastReplyAt: null, lastRepliers: [] } });
    const base: MessagesData = { items: [root, message({ id: "m-9", seq: 9, threadRootId: "m-1" })], hasMoreBefore: true, lastSeq: 9 };
    const older = mergeOlderPage(base, {
      items: [message({ id: "m-4", seq: 4, threadRootId: "m-1" }), message({ id: "m-6", seq: 6, threadRootId: "m-1" })],
      hasMoreBefore: false,
    });
    expect(older.items.map((item) => item.seq)).toEqual([1, 4, 6, 9]);
    expect(older.items[0]?.thread?.replyCount).toBe(3);
    expect(older.hasMoreBefore).toBe(false);
  });

  it("话题重取只拿回根 + 最新一页：不丢已翻出的更早回复和重取期间推送进来的，同一条以重取为准", () => {
    const root = message({ id: "m-1", seq: 1 });
    const reply = (seq: number, body = "回复") => message({ id: `m-${seq}`, seq, threadRootId: "m-1", body });
    // 缓存：根 + 翻出来的更早回复（4、6）+ 最新一页（9、10）+ 重取期间推送进来的 12。
    const cached: MessagesData = { items: [root, reply(4), reply(6), reply(9), reply(10, "旧正文"), reply(12)], hasMoreBefore: false, lastSeq: 12 };
    // 重取结果：根（单独取的）+ 最新一页 9、10、11，还有更早的。
    const fresh: MessagesData = { items: [root, reply(9), reply(10, "新正文"), reply(11)], hasMoreBefore: true, lastSeq: 11 };
    const merged = mergeThreadRefetch(cached, fresh, "m-1");
    expect(merged.items.map((item) => item.seq)).toEqual([1, 4, 6, 9, 10, 11, 12]);
    expect(merged.items.find((item) => item.seq === 10)?.body).toBe("新正文");
    // 缓存已经翻到头了。
    expect(merged.hasMoreBefore).toBe(false);
    expect(merged.lastSeq).toBe(12);
    // 缓存没有翻得更早时，以重取结果为准；没有缓存直接用重取结果。
    expect(mergeThreadRefetch({ ...cached, items: [root, reply(9)], hasMoreBefore: false }, fresh, "m-1").hasMoreBefore).toBe(true);
    expect(mergeThreadRefetch(undefined, fresh, "m-1")).toBe(fresh);
  });

  it("最近回复者与服务端同口径：只算真人；Agent 的回答只加回复数，不把所有者算进来", () => {
    const base = data([message({ id: "m-1", seq: 1, thread: { replyCount: 1, lastReplyAt: null, lastRepliers: [ZHANG] } })], 1);
    const answer = message({ id: "m-2", seq: 2, threadRootId: "m-1", authorKind: "agent", author: WANG, agent: agent() });
    const root = mergeMessages(base, [answer]).data.items[0];
    expect(root?.thread?.replyCount).toBe(2);
    expect(root?.thread?.lastRepliers.map((user) => user.id)).toEqual([ZHANG.id]);
  });

  it("主消息流只显示根与普通消息", () => {
    const items = [message({ id: "a", seq: 1 }), message({ id: "b", seq: 2, threadRootId: "a" })];
    expect(rootMessages(items).map((item) => item.id)).toEqual(["a"]);
  });

  it("任务状态写回触发消息（替换或追加）；找不到触发消息时原样返回", () => {
    const base = data([message({ id: "m-2", seq: 2, runs: [run()] })], 2);
    const running = applyRunToMessages(base, run({ status: "running", progress: "查看了 6 个文件" }));
    expect(running.items[0]?.runs[0]?.status).toBe("running");
    const second = applyRunToMessages(running, run({ id: "run-2", agent: agent({ id: "agent-zhang", owner: ZHANG }) }));
    expect(second.items[0]?.runs.map((entry) => entry.id)).toEqual(["run-1", "run-2"]);
    expect(applyRunToMessages(base, run({ triggerMessageId: "nope" }))).toBe(base);
  });

  it("补拉起点：本地最大序号；还有排队 / 执行中的任务时从那条之前开始", () => {
    expect(catchUpAfter(data([message({ seq: 5 }), message({ id: "x", seq: 9 })], 9))).toBe(9);
    expect(catchUpAfter(data([], 7))).toBe(7);
    const active = data([message({ seq: 5 }), message({ id: "x", seq: 6, runs: [run({ status: "running" })] }), message({ id: "y", seq: 9 })], 9);
    expect(catchUpAfter(active)).toBe(5);
  });
});

describe("房间列表与未读", () => {
  it("别人发的、我没在看：未读 +1，@ 我（或所有人）再记一次提醒；自己发的不算并顺带前进已读", () => {
    const base = room({ lastSeq: 3, viewer: { joined: true, lastReadSeq: 3, unreadCount: 0, mentionCount: 0 } });
    const fromWang = roomAfterMessage(base, message({ seq: 4, mentions: [{ kind: "user", id: ME.id, label: ME.displayName }] }), { meId: ME.id, reading: false });
    expect(fromWang.viewer).toMatchObject({ unreadCount: 1, mentionCount: 1 });
    expect(fromWang.lastSeq).toBe(4);
    expect(fromWang.lastMessage).toMatchObject({ seq: 4, authorName: WANG.displayName, preview: "早" });
    const toAll = roomAfterMessage(fromWang, message({ id: "m-5", seq: 5, mentions: [{ kind: "all", id: null, label: "所有人" }] }), { meId: ME.id, reading: false });
    expect(toAll.viewer).toMatchObject({ unreadCount: 2, mentionCount: 2 });
    const mine = roomAfterMessage(toAll, message({ id: "m-6", seq: 6, author: ME }), { meId: ME.id, reading: false });
    expect(mine.viewer).toMatchObject({ unreadCount: 2, lastReadSeq: 6 });
  });

  it("正在看（前台且在底部）不加未读", () => {
    const base = room({ lastSeq: 3 });
    expect(roomAfterMessage(base, message({ seq: 4 }), { meId: ME.id, reading: true }).viewer.unreadCount).toBe(0);
  });

  it("推送乱序：较早的一条晚到照样算未读（不比房间最大序号），最后一条与最大序号不倒退", () => {
    const base = room({ lastSeq: 3, viewer: { joined: true, lastReadSeq: 3, unreadCount: 0, mentionCount: 0 } });
    const newer = roomAfterMessage(base, message({ id: "m-5", seq: 5, body: "后发的" }), { meId: ME.id, reading: false });
    const older = roomAfterMessage(newer, message({ id: "m-4", seq: 4, body: "先发的" }), { meId: ME.id, reading: false });
    expect(older.viewer.unreadCount).toBe(2);
    expect(older.lastSeq).toBe(5);
    expect(older.lastMessage).toMatchObject({ seq: 5, preview: "后发的" });
    // 已读之前的消息（序号不大于已读）不算。
    expect(roomAfterMessage(base, message({ id: "m-3", seq: 3 }), { meId: ME.id, reading: false }).viewer.unreadCount).toBe(0);
  });

  it("最后一条按结构化字段渲染：只有附件时「[图片]」「[文件] 名」，多个附件补「等 N 个」；Agent 作者不带设备名", () => {
    const file = (fileName: string, kind: "image" | "file") => ({
      id: fileName,
      roomId: "room-1",
      fileName,
      contentType: kind === "image" ? "image/png" : "application/pdf",
      kind,
      sizeBytes: 1,
      sha256: "",
      uploadedBy: WANG,
      createdAt: "2026-09-30T09:00:00.000Z",
    });
    const base = room({ lastSeq: 3 });
    const image = roomAfterMessage(base, message({ seq: 4, body: "", files: [file("截图.png", "image")] }), { meId: ME.id, reading: true }).lastMessage;
    expect(image === null ? null : [lastMessageAuthor(image), lastMessagePreview(image)]).toEqual(["小王", "[图片]"]);
    const many = roomAfterMessage(
      base,
      message({ seq: 4, authorKind: "agent", agent: agent(), body: "", files: [file("方案.pdf", "file"), file("截图.png", "image"), file("b.png", "image")] }),
      { meId: ME.id, reading: true },
    ).lastMessage;
    expect(many === null ? null : [lastMessageAuthor(many), lastMessagePreview(many)]).toEqual(["小王 的 Codex", "[文件] 方案.pdf 等 3 个"]);
    // 多 Agent S6：按种类写产品名；老云端没给种类按 Codex。
    const claude = roomAfterMessage(base, message({ seq: 5, authorKind: "agent", agent: agent({ kind: "claude-code" }), body: "好" }), {
      meId: ME.id,
      reading: true,
    }).lastMessage;
    expect(claude === null ? null : lastMessageAuthor(claude)).toBe("小王 的 Claude Code");
    expect(lastMessageAuthor({ seq: 1, authorName: "x", preview: "", createdAt: "", authorKind: "agent", agent: { ownerName: "小王", deviceName: "M" } })).toBe(
      "小王 的 Codex",
    );
  });

  it("没加入的需求房间不算未读；自己在里面发言后算加入", () => {
    const outsider = room({ kind: "requirement", lastSeq: 3, viewer: { joined: false, lastReadSeq: 0, unreadCount: 0, mentionCount: 0 } });
    expect(roomAfterMessage(outsider, message({ seq: 4 }), { meId: ME.id, reading: false }).viewer.unreadCount).toBe(0);
    expect(roomAfterMessage(outsider, message({ seq: 4, author: ME }), { meId: ME.id, reading: false }).viewer.joined).toBe(true);
  });

  it("记已读：读到最新时清零；回退不处理", () => {
    const base = room({ lastSeq: 8, viewer: { joined: true, lastReadSeq: 3, unreadCount: 5, mentionCount: 1 } });
    expect(roomAfterRead(base, 8).viewer).toMatchObject({ lastReadSeq: 8, unreadCount: 0, mentionCount: 0 });
    expect(roomAfterRead(base, 2)).toBe(base);
  });

  it("默认房间最上，其余按最近活动；归档另放；未读合计不含归档", () => {
    const rooms = [
      room({ id: "r-old", kind: "requirement", name: "REQ-1 讨论", createdAt: "2026-09-01T00:00:00.000Z", viewer: { joined: true, lastReadSeq: 0, unreadCount: 2, mentionCount: 0 } }),
      room({ id: "r-new", kind: "requirement", name: "REQ-2 讨论", createdAt: "2026-09-20T00:00:00.000Z", viewer: { joined: true, lastReadSeq: 0, unreadCount: 1, mentionCount: 0 } }),
      room({ id: "r-default", viewer: { joined: true, lastReadSeq: 0, unreadCount: 3, mentionCount: 0 } }),
      room({ id: "r-archived", kind: "requirement", archivedAt: "2026-09-25T00:00:00.000Z", viewer: { joined: true, lastReadSeq: 0, unreadCount: 9, mentionCount: 0 } }),
    ];
    const sorted = sortRooms(rooms);
    expect(sorted.active.map((item) => item.id)).toEqual(["r-default", "r-new", "r-old"]);
    expect(sorted.archived.map((item) => item.id)).toEqual(["r-archived"]);
    expect(totalUnread(rooms)).toBe(6);
  });
});

describe("任务状态与权限", () => {
  it.each([
    [run({ status: "queued", queuePosition: 2 }), "排队中（前面还有 2 个）"],
    [run({ status: "queued", queuePosition: 0 }), "排队中"],
    [run({ status: "running", progress: "查看了 6 个文件" }), "执行中 · 查看了 6 个文件"],
    [run({ status: "completed", summary: "后端已有 receiverSnapshot" }), "已完成 · 后端已有 receiverSnapshot"],
    [run({ status: "failed", reason: "所有者本机下线，执行中断" }), "失败 · 所有者本机下线，执行中断"],
    [run({ status: "stopped" }), "已停止"],
    [run({ status: "offline", reason: "未共享" }), "离线，未执行 · 未共享"],
    [run({ status: "running", stopRequested: true }), "正在停止…"],
  ])("%#：状态行文字", (entry, text) => {
    expect(runStatusText(entry)).toBe(text);
  });

  it("停止：触发人或所有者，且还在排队 / 执行；重试：只有触发人，失败 / 已停止 / 离线", () => {
    const queued = run({ status: "queued", triggeredBy: ME });
    expect(canStopRun(queued, ME.id)).toBe(true);
    expect(canStopRun(queued, WANG.id)).toBe(true); // 所有者
    expect(canStopRun(queued, ZHANG.id)).toBe(false);
    expect(canStopRun(run({ status: "completed" }), ME.id)).toBe(false);
    expect(canStopRun(run({ status: "running", stopRequested: true }), ME.id)).toBe(false);
    for (const status of ["failed", "stopped", "offline"] as const) {
      expect(canRetryRun(run({ status }), ME.id)).toBe(true);
      expect(canRetryRun(run({ status }), WANG.id)).toBe(false); // 所有者不能替别人重试
    }
    expect(canRetryRun(run({ status: "completed" }), ME.id)).toBe(false);
  });
});

describe("@ 候选", () => {
  const agents = [
    agent({ id: "a-off", owner: ZHANG, label: "小张 的 Codex · ThinkPad", deviceName: "ThinkPad", online: false }),
    agent({ id: "a-unshared", owner: { id: "u-chen", displayName: "陈思远" }, label: "陈思远 的 Codex · iMac", deviceName: "iMac" }),
    agent({ id: "agent-wang" }),
    agent({ id: "a-mine", owner: ME, label: "李娜 的 Codex · MacBook Air", deviceName: "MacBook Air" }),
  ];
  const shares = [share(), share({ id: "share-off", agent: agents[0]! })];

  it("真人在前（不含自己、在线优先），然后所有人，Agent 按 可用 → 未共享 → 离线", () => {
    const list = buildMentionCandidates({
      members: [member(ZHANG, false), member(WANG, true), member(ME, true)],
      agents,
      shares,
      requestedAgentIds: new Set(),
      meId: ME.id,
      query: "",
    });
    expect(list.map((item) => `${item.kind}:${item.kind === "agent" ? item.availability : item.text}`)).toEqual([
      "user:小王",
      "user:小张",
      "all:所有人",
      "agent:available",
      "agent:unshared",
      "agent:unshared",
      "agent:offline",
    ]);
    const agentText = list.find((item) => item.kind === "agent" && item.id === "agent-wang");
    expect(agentText?.text).toBe("小王的Codex");
  });

  it("说明文字：离线、未共享可申请、已申请、自己的没共享", () => {
    const list = buildMentionCandidates({ members: [], agents, shares, requestedAgentIds: new Set(["a-unshared"]), meId: ME.id, query: "codex" });
    const note = (id: string) => {
      const found = list.find((item) => item.kind === "agent" && item.id === id);
      return found?.kind === "agent" ? agentAvailabilityNote(found) : "";
    };
    expect(note("agent-wang")).toBe("可用");
    expect(note("a-off")).toBe("离线");
    expect(note("a-unshared")).toBe("未共享 · 已申请");
    expect(note("a-mine")).toBe("未共享 · 在「共享 Agent」里开启");
  });

  it("按 @ 后输入的字过滤", () => {
    const list = buildMentionCandidates({ members: [member(WANG), member(ZHANG)], agents, shares, requestedAgentIds: new Set(), meId: ME.id, query: "小王" });
    expect(list.map((item) => item.text)).toEqual(["小王", "小王的Codex"]);
  });

  it("发送时只带正文里还在的 @，同一对象只带一次", () => {
    const picked = [
      { kind: "agent" as const, id: "agent-wang", text: "小王的Codex" },
      { kind: "user" as const, id: ZHANG.id, text: "小张" },
      { kind: "all" as const, id: null, text: "所有人" },
      { kind: "agent" as const, id: "agent-wang", text: "小王的Codex" },
    ];
    expect(collectMentions("@小王的Codex 订单详情能拿到收货信息吗？@所有人", picked)).toEqual([
      { kind: "agent", id: "agent-wang" },
      { kind: "all" },
    ]);
  });

  it("正文高亮的写法：服务端标签、去掉设备名、去掉空格", () => {
    expect(mentionHighlights([{ kind: "agent", id: "a", label: "小王 的 Codex · MacBook Pro" }])).toEqual(
      expect.arrayContaining(["小王 的 Codex · MacBook Pro", "小王 的 Codex", "小王的Codex"]),
    );
  });

  it("插进正文的 @ 文字：同一个人有多台设备时带设备名（「小王的Codex·设备」）", () => {
    const list = buildMentionCandidates({
      members: [],
      agents: [agent(), agent({ id: "agent-wang-2", deviceName: "ThinkPad" })],
      shares: [share()],
      requestedAgentIds: new Set(),
      meId: ME.id,
      query: "",
    });
    expect(list.filter((item) => item.kind === "agent").map((item) => item.text)).toEqual(["小王的Codex·MacBook Pro", "小王的Codex·ThinkPad"]);
  });

  it("多种 Agent（S6）：同一台电脑上的 Codex 与 Claude Code 靠产品名区分，不带设备名；按产品名或种类都能搜到；正文按种类高亮", () => {
    const claude = agent({ id: "agent-wang-claude", kind: "claude-code", label: "小王's Claude Code · MacBook Pro" });
    const input = { members: [], agents: [agent(), claude], shares: [share()], requestedAgentIds: new Set<string>(), meId: ME.id };
    expect(buildMentionCandidates({ ...input, query: "" }).filter((item) => item.kind === "agent").map((item) => item.text)).toEqual([
      "小王的Codex",
      "小王的Claude Code",
    ]);
    for (const query of ["claude", "Claude Code", "claude-code"]) {
      expect(buildMentionCandidates({ ...input, query }).map((item) => item.id), query).toEqual(["agent-wang-claude"]);
    }
    expect(agentName(claude)).toBe("小王 的 Claude Code");
    expect(agentLabel(claude)).toBe("小王 的 Claude Code · MacBook Pro");
    // 列表里找得到：按所有者名与种类拼各语言的写法；找不到（旧消息）：由云端英文标签推出产品名。
    expect(mentionHighlights([{ kind: "agent", id: "agent-wang-claude", label: "x" }], [claude])).toEqual(
      expect.arrayContaining(["小王的Claude Code", "小王's Claude Code", "小王的Claude Code·MacBook Pro"]),
    );
    expect(mentionHighlights([{ kind: "agent", id: "gone", label: "小王's Gemini CLI · ThinkPad" }])).toEqual(
      expect.arrayContaining(["小王的Gemini CLI", "小王's Gemini CLI · ThinkPad"]),
    );
    // 所有者名里带「's」：先按已知产品名拆，不会把 “Team's Codex” 当成产品名。
    expect(mentionHighlights([{ kind: "agent", id: "gone", label: "Sam's Team's Codex · Mac" }])).toEqual(
      expect.arrayContaining(["Sam's Team的Codex", "Sam's Team的Codex·Mac"]),
    );
    // 不认识的产品名照样能拆。
    expect(mentionHighlights([{ kind: "agent", id: "gone", label: "小王's Foo Agent · Mac" }])).toEqual(expect.arrayContaining(["小王的Foo Agent"]));
  });

  it("新云端的标签是英文兜底：中文写的 @小王的Codex、@所有人 照样高亮（按 kind）", () => {
    const highlights = mentionHighlights([
      { kind: "agent", id: "agent-gone", label: "小王's Codex · MacBook Pro" },
      { kind: "all", id: null, label: "everyone" },
    ]);
    expect(highlights).toEqual(expect.arrayContaining(["小王的Codex", "小王的Codex·MacBook Pro", "所有人", "everyone"]));
  });
});

describe("时间", () => {
  it("「今天」到期是浏览器本地当天 23:59:59", () => {
    const now = new Date(2026, 8, 30, 10, 15);
    const end = new Date(endOfLocalDay(now));
    expect([end.getFullYear(), end.getMonth(), end.getDate(), end.getHours(), end.getMinutes(), end.getSeconds()]).toEqual([2026, 8, 30, 23, 59, 59]);
    expect(expiresLabel(null, now)).toBe("直到关闭");
    expect(expiresLabel(endOfLocalDay(now), now)).toBe("到 23:59");
  });

  it("共享按哪一档开的：没有到期 = 直到我关闭，本地 23:59:59 到期 = 今天，其余 = 2 小时", () => {
    const now = new Date(2026, 8, 30, 15, 20);
    expect(shareDurationOf(null)).toBe("until_closed");
    expect(shareDurationOf(endOfLocalDay(now))).toBe("today");
    expect(shareDurationOf(new Date(2026, 8, 30, 23, 59, 59, 999).toISOString())).toBe("today");
    expect(shareDurationOf(new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString())).toBe("two_hours");
    expect(shareDurationOf(new Date(2026, 9, 1, 0, 40).toISOString())).toBe("two_hours");
  });

  it("日期分隔：今天 / 昨天 / 月日 / 年月日", () => {
    const now = new Date(2026, 8, 30, 12);
    expect(formatDayLabel(new Date(2026, 8, 30, 8).toISOString(), now)).toBe("今天");
    expect(formatDayLabel(new Date(2026, 8, 29, 8).toISOString(), now)).toBe("昨天");
    expect(formatDayLabel(new Date(2026, 8, 2, 8).toISOString(), now)).toBe("9月2日");
    expect(formatDayLabel(new Date(2025, 8, 2, 8).toISOString(), now)).toBe("2025年9月2日");
  });
});
