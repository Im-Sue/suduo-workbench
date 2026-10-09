import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue, RuntimeInput, RuntimeRegistry } from "@suduo/client-contracts";
import { sessionHandles } from "../src/application/context/session-handles.js";
import type { EventLedger } from "../src/application/event-ledger.js";
import { MessageService } from "../src/application/message-service.js";
import type { RuntimeSupervisor } from "../src/application/runtime-supervisor.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { SessionThreadRepository } from "../src/infrastructure/db/repositories/session-thread-repository.js";

/** 消息里引用本机别的会话（多 Agent 协作 S7）：认出句柄，给有会话工具的线程附一句「用 session_read 读」。 */

const SOURCE = "0b7e1a52-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function setup(metadata: JsonValue, locale: "zh-CN" | "en" = "zh-CN") {
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  closers.push(() => database.close());
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const threads = new SessionThreadRepository(database);
  const project = projects.create({ name: "p", rootPath: "/tmp/suduo-handles", rootPathKey: "/tmp/suduo-handles" });
  const session = sessions.create({ projectId: project.id, title: "读取方", state: "active", locale });
  threads.attach({
    sessionId: session.id,
    threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-1" },
    role: "primary",
    ordinal: 0,
    primary: true,
    metadata,
  });
  const inputs: RuntimeInput[][] = [];
  const appended: JsonValue[] = [];
  const runtimes = {
    get: () => ({
      startTurn: async (input: { input: RuntimeInput[] }) => {
        inputs.push(input.input);
        return { turnRef: { threadId: "thread-1", turnId: "turn-1" }, acceptedAt: 1 };
      },
    }),
  } as unknown as RuntimeRegistry;
  const service = new MessageService(
    projects,
    sessions,
    threads,
    runtimes,
    { ensureReadyOrRebuild: async () => null } as unknown as RuntimeSupervisor,
    {
      append: (input: { event: { payload: JsonValue } }) => {
        appended.push(input.event.payload);
        return { seq: 1 };
      },
    } as unknown as EventLedger,
    null,
  );
  const text = `接着 [导出接口](suduo://session/${SOURCE}) 继续：做前端页面`;
  return { service, session, inputs, appended, text };
}

describe("会话句柄", () => {
  it("从文字段里认出 suduo://session/<ID>（去重、不分大小写），其他段不看", () => {
    expect(
      sessionHandles([
        { type: "text", text: `看 suduo://session/${SOURCE.toUpperCase()} 和 [它](suduo://session/${SOURCE})` },
        { type: "image", url: `suduo://session/${SOURCE}` },
        { type: "text", text: "suduo://session/not-a-uuid" },
      ]),
    ).toEqual([SOURCE]);
  });

  it("引用了会话、线程有会话工具：给 Agent 附一句用 session_read 读；账本里的消息照原样", async () => {
    const context = setup({ suDuoToolChannel: "mcp", suDuoTools: ["suduo_requirement_get", "suduo_session_list", "suduo_session_read"] });
    await context.service.send(context.session.id, { content: [{ type: "text", text: context.text }] }, "k1");
    expect(context.inputs[0]).toEqual([
      { type: "text", text: context.text },
      {
        type: "text",
        text: "（这条消息里的 suduo://session/<ID> 是这台电脑上的其他 SuDuo 会话：需要时用 SuDuo 的 session_read 工具按 ID 读取，先读概要（summary），不要当网址打开。）",
      },
    ]);
    expect(JSON.stringify(context.appended)).not.toContain("session_read");
  });

  it("线程没有会话工具（老线程、没关联项目的会话）或没引用会话：不附", async () => {
    const old = setup({ suDuoToolChannel: "mcp", suDuoTools: ["suduo_requirement_get"] });
    await old.service.send(old.session.id, { content: [{ type: "text", text: old.text }] }, "k1");
    expect(old.inputs[0]).toHaveLength(1);
    const plain = setup({ suDuoToolChannel: "mcp", suDuoTools: ["suduo_session_read"] });
    await plain.service.send(plain.session.id, { content: [{ type: "text", text: "普通消息" }] }, "k1");
    expect(plain.inputs[0]).toHaveLength(1);
  });

  it("英文会话附英文提示", async () => {
    const context = setup({ suDuoToolChannel: "mcp", suDuoTools: ["suduo_session_read"] }, "en");
    await context.service.send(context.session.id, { content: [{ type: "text", text: context.text }] }, "k1");
    expect(context.inputs[0]?.[1]).toEqual({
      type: "text",
      text: "(The suduo://session/<ID> links in this message are other SuDuo sessions on this computer. When you need one, read it by ID with SuDuo's session_read tool, starting with the summary; don't open them as URLs.)",
    });
  });
});
