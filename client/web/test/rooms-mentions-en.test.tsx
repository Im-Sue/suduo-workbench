// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RoomLastMessageDto, RoomMentionDto, UserSummaryDto } from "@suduo/cloud-contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, message, room, WANG } from "./fixtures/rooms.js";

/**
 * 提及、Agent 名、房间「最后一条」的英文渲染与新旧混用（中英双语 S6）：
 * - @ 所有人与 @Agent 按 kind 高亮，两种语言的写法都认；插进正文的文字按发送者的界面语言；
 * - Agent 名由前端按所有者名与设备名拼，不读云端标签；
 * - 「最后一条」按结构化字段渲染，老云端（没有结构化字段）原样显示兜底文字。
 */

const apiMocks = vi.hoisted(() => ({ listAgents: vi.fn() }));
vi.mock("../src/api/client.js", () => ({ api: apiMocks, ApiClientError: class ApiClientError extends Error {} }));

const { applyLocalePreference } = await import("../src/i18n/locale.js");
const { messagesFor } = await import("../src/i18n/messages/index.js");
const model = await import("../src/features/rooms/model.js");
const { MessageItem } = await import("../src/features/rooms/components/MessageItem.js");
const { roomKeys } = await import("../src/features/rooms/keys.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const en = messagesFor("en");
const zh = messagesFor("zh-CN");
const SAM: UserSummaryDto = { id: "u-sam", displayName: "Sam" };
const samAgent = agent({ id: "agent-sam", owner: SAM });
const samLaptop = agent({ id: "agent-sam-2", owner: SAM, deviceName: "ThinkPad" });

let client: QueryClient;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  applyLocalePreference("en");
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  apiMocks.listAgents.mockResolvedValue({ items: [samAgent, agent()] });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  applyLocalePreference("system");
  localStorage.clear();
});

async function renderMessage(body: string, mentions: RoomMentionDto[]): Promise<string[]> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <MessageItem
          message={message({ body, mentions })}
          compact={false}
          meId={null}
          variant="stream"
          onOpenThread={() => undefined}
          onOpenRun={() => undefined}
        />
      </QueryClientProvider>,
    ),
  );
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return [...container.querySelectorAll('[data-mention="true"]')].map((node) => node.textContent ?? "");
}

describe("插进正文的 @ 文字：按发送者的界面语言", () => {
  it("所有人：英文 everyone，中文仍是「所有人」", () => {
    expect(model.mentionAllText(en)).toBe("everyone");
    expect(model.mentionAllText(zh)).toBe("所有人");
  });

  it("Agent：英文 “Sam's Codex”，同一个人有多台设备时带设备名；中文写法与原来逐字相同", () => {
    expect(model.agentMentionText(samAgent, [samAgent], en)).toBe("Sam's Codex");
    expect(model.agentMentionText(samLaptop, [samAgent, samLaptop], en)).toBe("Sam's Codex · ThinkPad");
    expect(model.agentMentionText(agent(), [agent()], zh)).toBe("小王的Codex");
    expect(model.agentMentionText(agent(), [agent(), agent({ id: "agent-wang-2", deviceName: "ThinkPad" })], zh)).toBe("小王的Codex·MacBook Pro");
  });

  it("候选：英文界面的「所有人」插 everyone；任一语言的叫法都能搜到", () => {
    const input = { members: [], agents: [samAgent], shares: [], requestedAgentIds: new Set<string>(), meId: null };
    const everyoneIn = (query: string, t = en) =>
      model.buildMentionCandidates({ ...input, query }, t).find((candidate) => candidate.kind === "all")?.text;
    expect(everyoneIn("every")).toBe("everyone");
    expect(everyoneIn("所有")).toBe("everyone");
    expect(everyoneIn("every", zh)).toBe("所有人");
    const agentIn = (query: string) => model.buildMentionCandidates({ ...input, query }, en).find((candidate) => candidate.kind === "agent")?.text;
    expect(agentIn("sam's")).toBe("Sam's Codex");
    expect(agentIn("的 Codex")).toBe("Sam's Codex");
  });
});

describe("Agent 名：按所有者名与设备名，不读云端标签", () => {
  it("需要区分设备时带设备名", () => {
    const legacy = agent({ owner: SAM, label: "Sam 的 Codex · MacBook Pro" });
    expect(model.agentLabel(legacy, en)).toBe("Sam's Codex · MacBook Pro");
    expect(model.agentLabel(samAgent, zh)).toBe("Sam 的 Codex · MacBook Pro");
    expect(model.agentName(samAgent, en)).toBe("Sam's Codex");
  });
});

describe("正文高亮：按提及的 kind，两种语言的写法都认", () => {
  it("@ 所有人：新云端的英文标签与老云端的中文标签都认 @所有人 与 @everyone", () => {
    for (const label of ["everyone", "所有人"]) {
      expect(model.mentionHighlights([{ kind: "all", id: null, label }])).toEqual(expect.arrayContaining(["所有人", "everyone"]));
    }
  });

  it("@Agent：能在列表里按 id 找到时，用所有者名与设备名拼出两种语言的写法", () => {
    const highlights = model.mentionHighlights([{ kind: "agent", id: "agent-sam", label: "" }], [samAgent]);
    expect(highlights).toEqual(
      expect.arrayContaining(["Sam's Codex", "Sam's Codex · MacBook Pro", "Sam的Codex", "Sam的Codex·MacBook Pro"]),
    );
  });

  it("@Agent：找不到时由云端标签推导（新云端英文、老云端中文都认）", () => {
    const fromEnglish = model.mentionHighlights([{ kind: "agent", id: "gone", label: "小王's Codex · MacBook Pro" }]);
    expect(fromEnglish).toEqual(expect.arrayContaining(["小王的Codex", "小王的Codex·MacBook Pro", "小王's Codex"]));
    const fromChinese = model.mentionHighlights([{ kind: "agent", id: "gone", label: "Sam 的 Codex · Mac (2)" }]);
    expect(fromChinese).toEqual(expect.arrayContaining(["Sam's Codex", "Sam's Codex · Mac (2)", "Sam的Codex", "Sam 的 Codex"]));
  });

  it("@Agent：所有者改过名时，新名字（列表）与发消息时的名字（标签）都认；认不出的标签照旧按原文", () => {
    const renamed = agent({ id: "agent-sam", owner: { id: "u-sam", displayName: "Samuel" } });
    const highlights = model.mentionHighlights([{ kind: "agent", id: "agent-sam", label: "Sam's Codex · MacBook Pro" }], [renamed]);
    expect(highlights).toEqual(expect.arrayContaining(["Samuel's Codex", "Sam's Codex", "Sam的Codex"]));
    expect(model.mentionHighlights([{ kind: "agent", id: "x", label: "Robot" }])).toEqual(["Robot"]);
  });

  it("消息里：英文界面下中文写的 @小王的Codex 与 @所有人 照样高亮", async () => {
    client.setQueryData(roomKeys.agents, { items: [samAgent, agent()] });
    const mentions: RoomMentionDto[] = [
      { kind: "agent", id: "agent-wang", label: "小王's Codex · MacBook Pro" },
      { kind: "all", id: null, label: "everyone" },
    ];
    expect(await renderMessage("@小王的Codex can you check? @所有人", mentions)).toEqual(["@小王的Codex", "@所有人"]);
  });

  it("消息里：Agent 列表还没取到时由标签推导", async () => {
    apiMocks.listAgents.mockReturnValue(new Promise(() => undefined));
    const mentions: RoomMentionDto[] = [{ kind: "agent", id: "agent-sam", label: "Sam's Codex · MacBook Pro" }];
    expect(await renderMessage("@Sam's Codex take a look, @Sam的Codex too", mentions)).toEqual(["@Sam's Codex", "@Sam的Codex"]);
  });
});

describe("房间「最后一条」：按结构化字段用当前语言渲染", () => {
  const last = (patch: Partial<RoomLastMessageDto>): RoomLastMessageDto => ({
    seq: 1,
    authorName: "",
    preview: "",
    createdAt: "2026-09-30T09:00:00.000Z",
    ...patch,
  });

  it("作者：Agent 与系统按语言；真人就是名字", () => {
    const fromAgent = last({ authorName: "Sam's Codex · MacBook Pro", authorKind: "agent", agent: { ownerName: "Sam", deviceName: "MacBook Pro" } });
    expect(model.lastMessageAuthor(fromAgent, en)).toBe("Sam's Codex");
    expect(model.lastMessageAuthor(fromAgent, zh)).toBe("Sam 的 Codex");
    expect(model.lastMessageAuthor(last({ authorName: "System", authorKind: "system", agent: null }), en)).toBe("System");
    expect(model.lastMessageAuthor(last({ authorName: "System", authorKind: "system", agent: null }), zh)).toBe("系统");
    expect(model.lastMessageAuthor(last({ authorName: "Jo", authorKind: "user", agent: null }), en)).toBe("Jo");
  });

  it("预览：有正文给正文；只有附件时按第一个附件，多个附件补上数量", () => {
    const files = (fileName: string, kind: "image" | "video" | "file", fileCount: number) =>
      last({ preview: "fallback", text: "", firstFile: { fileName, kind }, fileCount });
    expect(model.lastMessagePreview(last({ preview: "Hi", text: "Hi" }), en)).toBe("Hi");
    expect(model.lastMessagePreview(files("a.png", "image", 1), en)).toBe("[Image]");
    expect(model.lastMessagePreview(files("a.mp4", "video", 2), en)).toBe("[Video] and 1 more");
    expect(model.lastMessagePreview(files("a.pdf", "file", 3), en)).toBe("[File] a.pdf and 2 more");
    expect(model.lastMessagePreview(files("a.png", "image", 1), zh)).toBe("[图片]");
    expect(model.lastMessagePreview(files("a.pdf", "file", 3), zh)).toBe("[文件] a.pdf 等 3 个");
  });

  it("老云端没有结构化字段：原样显示兜底文字，不吞", () => {
    const legacy = last({ authorName: "小王 的 Codex · MacBook Pro", preview: "[附件] a.png 等 3 个" });
    expect(model.lastMessageAuthor(legacy, en)).toBe("小王 的 Codex · MacBook Pro");
    expect(model.lastMessagePreview(legacy, en)).toBe("[附件] a.png 等 3 个");
  });

  it("推送来的新消息与云端给的走同一套渲染，切换语言跟着变", () => {
    const pushed = message({
      seq: 9,
      authorKind: "agent",
      author: WANG,
      agent: agent(),
      body: "",
      files: [
        { id: "f1", roomId: "room-1", fileName: "plan.pdf", contentType: "application/pdf", kind: "file", sizeBytes: 1, sha256: "", uploadedBy: WANG, createdAt: "2026-09-30T09:00:00.000Z" },
        { id: "f2", roomId: "room-1", fileName: "shot.png", contentType: "image/png", kind: "image", sizeBytes: 1, sha256: "", uploadedBy: WANG, createdAt: "2026-09-30T09:00:00.000Z" },
      ],
    });
    const next = model.roomAfterMessage(room(), pushed, { meId: null, reading: true }).lastMessage;
    expect(next).toMatchObject({ seq: 9, authorKind: "agent", agent: { ownerName: "小王", deviceName: "MacBook Pro" }, text: "", fileCount: 2 });
    if (next === null) throw new Error("没有最后一条");
    expect(`${model.lastMessageAuthor(next, en)}: ${model.lastMessagePreview(next, en)}`).toBe("小王's Codex: [File] plan.pdf and 1 more");
    expect(`${model.lastMessageAuthor(next, zh)}：${model.lastMessagePreview(next, zh)}`).toBe("小王 的 Codex：[文件] plan.pdf 等 2 个");
  });
});
