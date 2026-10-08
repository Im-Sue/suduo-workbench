// 测试用的假 ACP Agent（多 Agent S4）：按提示词里的关键字走不同剧本，收到的调用逐行写进 FAKE_ACP_LOG。
// 用法：node fake-acp-agent.mjs（stdin / stdout 走 ACP）。
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, RequestError, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const record = (entry) => {
  if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(entry) + "\n");
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const modes = { currentModeId: "default", availableModes: ["default", "autoEdit", "yolo", "plan"].map((id) => ({ id, name: id })) };
const cancelled = new Set();
let sessionCount = 0;

class FakeAgent {
  constructor(connection) {
    this.connection = connection;
  }

  async initialize(params) {
    record({ method: "initialize", clientCapabilities: params.clientCapabilities });
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, mcpCapabilities: { http: true } },
      authMethods: [],
    };
  }

  async newSession(params) {
    record({ method: "session/new", cwd: params.cwd, mcpServers: params.mcpServers, env: { OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT ?? null, NO_PROXY: process.env.NO_PROXY ?? null } });
    if (process.env.FAKE_ACP_AUTH_REQUIRED === "1") throw RequestError.authRequired();
    sessionCount += 1;
    return { sessionId: `fake-${String(process.pid)}-${String(sessionCount)}`, modes };
  }

  async loadSession(params) {
    record({ method: "session/load", sessionId: params.sessionId, mcpServers: params.mcpServers });
    // 回放历史：这些更新不该进账本。
    await this.update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old question" } });
    await this.update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old answer" } });
    return { modes };
  }

  async setSessionMode(params) {
    record({ method: "session/set_mode", modeId: params.modeId });
    return {};
  }

  async authenticate() {
    return {};
  }

  async cancel(params) {
    record({ method: "session/cancel" });
    cancelled.add(params.sessionId);
  }

  async prompt(params) {
    const sessionId = params.sessionId;
    cancelled.delete(sessionId);
    const text = params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    record({ method: "session/prompt", prompt: params.prompt.map((block) => (block.type === "image" ? { type: "image", mimeType: block.mimeType } : block)) });
    if (text.includes("crash")) {
      process.exit(3);
    }
    if (text.includes("hello")) {
      await this.update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
      await this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } });
      await this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " there" } });
      return { stopReason: "end_turn" };
    }
    if (text.includes("permission")) {
      await this.update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call-rm", title: "rm -rf build", kind: "execute", status: "pending", rawInput: { command: "rm -rf build" } });
      const response = await this.connection.requestPermission({
        sessionId,
        toolCall: { toolCallId: "call-rm", title: "rm -rf build", kind: "execute", rawInput: { command: "rm -rf build" } },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      record({ method: "permission-answer", outcome: response.outcome });
      if (response.outcome.outcome === "cancelled") return { stopReason: "cancelled" };
      const allowed = response.outcome.optionId.startsWith("allow");
      await this.update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-rm",
        status: allowed ? "completed" : "failed",
        content: [{ type: "content", content: { type: "text", text: allowed ? "removed" : "denied" } }],
      });
      return { stopReason: "end_turn" };
    }
    if (text.includes("edit")) {
      await this.update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call-edit",
        title: "Edit src/a.ts",
        kind: "edit",
        status: "completed",
        locations: [{ path: `${process.cwd()}/src/a.ts` }],
        content: [{ type: "diff", path: `${process.cwd()}/src/a.ts`, oldText: "a\nb\n", newText: "a\nB\n" }],
      });
      return { stopReason: "end_turn" };
    }
    if (text.includes("suduo")) {
      await this.update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call-suduo", title: "suduo_requirement_get", kind: "other", status: "in_progress", rawInput: {} });
      await this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-suduo", status: "completed", content: [{ type: "content", content: { type: "text", text: "REQ-1" } }] });
      await this.update(sessionId, { sessionUpdate: "plan", entries: [{ content: "read requirement", priority: "high", status: "completed" }] });
      await this.update(sessionId, { sessionUpdate: "usage_update", used: 1200, size: 128000 });
      return { stopReason: "end_turn" };
    }
    if (text.includes("slow")) {
      for (let i = 0; i < 200; i++) {
        if (cancelled.has(sessionId)) return { stopReason: "cancelled" };
        await this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } });
        await sleep(20);
      }
      return { stopReason: "end_turn" };
    }
    await this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
    return { stopReason: "end_turn" };
  }

  update(sessionId, update) {
    return this.connection.sessionUpdate({ sessionId, update });
  }
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new AgentSideConnection((connection) => new FakeAgent(connection), stream);
