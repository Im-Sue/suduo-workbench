// 走剧本的假 ACP Agent（多 Agent S12，gate-c「模拟示例」步骤用）：消息里每行
// - `@call <工具名> <JSON 参数>`：经 SuDuo 本机工具服务（MCP，session/new 给的地址与令牌）调用，结果写进回答；
//   参数里的 $ID 换成上一个结果里的第一个 UUID（比如委派编号）；
// - `@say <文字>`：原样写进回答；
// 一行里先认 @call（JSON 里可以带给别的 Agent 的 @say）。没有剧本的消息回答 "ok"。`--version` 打印版本后退出。
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

if (process.argv.includes("--version")) {
  process.stdout.write("1.18.35\n");
  process.exit(0);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;
const servers = new Map();
let sessionCount = 0;

class ScriptAgent {
  constructor(connection) {
    this.connection = connection;
  }

  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: false }, mcpCapabilities: { http: true } },
      authMethods: [],
    };
  }

  async newSession(params) {
    sessionCount += 1;
    const sessionId = `script-${String(process.pid)}-${String(sessionCount)}`;
    this.remember(sessionId, params.mcpServers);
    return { sessionId };
  }

  async loadSession(params) {
    this.remember(params.sessionId, params.mcpServers);
    return {};
  }

  async authenticate() {
    return {};
  }

  async cancel() {}

  async prompt(params) {
    const sessionId = params.sessionId;
    const text = params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const outputs = [];
    let last = "";
    let step = 0;
    for (const line of text.split("\n")) {
      const call = /@call (\S+) (\{.*\})\s*$/u.exec(line);
      if (call !== null) {
        step += 1;
        const name = call[1];
        const id = UUID.exec(last)?.[0] ?? "";
        const args = JSON.parse(call[2].replaceAll("$ID", id));
        const toolCallId = `call-${String(step)}`;
        await this.update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: name, kind: "other", status: "in_progress", rawInput: args });
        let result;
        try {
          result = await this.callTool(sessionId, name, args);
        } catch (error) {
          result = `tool failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        await this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: result } }] });
        last = result;
        outputs.push(result);
        continue;
      }
      const say = /@say (.+)$/u.exec(line);
      if (say !== null) outputs.push(say[1]);
    }
    await this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: outputs.length === 0 ? "ok" : outputs.join("\n\n") } });
    return { stopReason: "end_turn" };
  }

  remember(sessionId, mcpServers) {
    const server = (mcpServers ?? []).find((entry) => typeof entry.url === "string");
    if (server !== undefined) servers.set(sessionId, server);
  }

  async callTool(sessionId, name, args) {
    const server = servers.get(sessionId);
    if (server === undefined) throw new Error("no SuDuo tool server for this session");
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    for (const header of server.headers ?? []) headers[header.name] = header.value;
    const rpc = async (method, params, id) => {
      const response = await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
      const body = await response.json();
      if (body.error) throw new Error(body.error.message);
      return body.result;
    };
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-script-agent", version: "1" } }, 1);
    // MCP 上的工具名不带 suduo_ 前缀（服务端再加回去）；剧本里写内部名，这里换。
    const result = await rpc("tools/call", { name: name.replace(/^suduo_/u, ""), arguments: args }, 2);
    return (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
  }

  update(sessionId, update) {
    return this.connection.sessionUpdate({ sessionId, update });
  }
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new AgentSideConnection((connection) => new ScriptAgent(connection), stream);
