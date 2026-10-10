import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { JsonValue } from "@suduo/client-contracts";
import type { ToolGrant, ToolTokenRegistry } from "./tool-tokens.js";

/** MCP 的工具定义（tools/list 的一项）。 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonValue;
}

export type McpToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolCallResult {
  content: McpToolContent[];
  isError: boolean;
}

/** 工具的业务实现由会话工具服务提供（ADR-0015：MCP 只是外壳）。 */
export interface McpToolHost {
  listTools(grant: ToolGrant): McpToolDefinition[];
  callTool(
    grant: ToolGrant,
    name: string,
    args: Record<string, unknown>,
    call: { requestKey: string; signal: AbortSignal },
  ): Promise<McpToolCallResult>;
}

export const MCP_ENDPOINT_PATH = "/mcp";

/** 本服务认识的 MCP 协议版本（S0：Codex、Claude、OpenCode 都在这几个里）。 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * SuDuo 本机 MCP 工具服务（ADR-0015）：Streamable HTTP 的最小实现——POST 收单条 JSON-RPC、直接回 JSON，
 * 不开 SSE 流（S0 实测四家 Agent 都接受）。守卫：Host 必须是 loopback、必须带有效会话令牌、带 Origin 时
 * 必须同源（防浏览器跨站调用）；全局 LoopbackGuard 对这个路径豁免（Agent 的请求不带 Origin）。
 */
export function registerMcpEndpoint(
  server: FastifyInstance,
  deps: { tokens: ToolTokenRegistry; host: McpToolHost; serverVersion: string },
): void {
  const inflight = new Map<string, AbortController>();
  let callSeq = 0;

  server.post(MCP_ENDPOINT_PATH, async (request, reply) => {
    const rejection = guard(request);
    if (rejection !== null) {
      return reply.code(403).send(rpcError(null, -32000, rejection));
    }
    const grant = grantOf(request, deps.tokens);
    if (grant === null) {
      return reply.code(401).send(rpcError(null, -32001, "invalid or expired SuDuo session token"));
    }
    const sessionId = grant.sessionId;
    const message = request.body as JsonRpcMessage | JsonRpcMessage[] | null;
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      return reply.code(400).send(rpcError(null, -32600, "expected a single JSON-RPC message"));
    }
    const id = message.id ?? null;
    if (message.id === undefined) {
      // 通知：取消某个进行中的调用；其余（initialized 等）只确认收到。
      if (message.method === "notifications/cancelled") {
        const requestId = message.params?.["requestId"];
        if (typeof requestId === "string" || typeof requestId === "number") {
          inflight.get(keyOf(sessionId, requestId))?.abort();
        }
      }
      return reply.code(202).send();
    }
    if (message.method === undefined) {
      // 客户端发来的 JSON-RPC 响应（本服务不发请求，不会有）：规范要求回 202。
      return reply.code(202).send();
    }
    switch (message.method) {
      case "initialize": {
        const requested = message.params?.["protocolVersion"];
        const protocolVersion =
          typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0]!;
        return sendResult(reply, id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "suduo", version: deps.serverVersion },
        });
      }
      case "ping":
        return sendResult(reply, id, {});
      case "tools/list":
        return sendResult(reply, id, { tools: deps.host.listTools(grant) as unknown as JsonValue });
      case "tools/call": {
        const name = message.params?.["name"];
        const rawArgs = message.params?.["arguments"];
        if (typeof name !== "string") {
          return reply.send(rpcError(id, -32602, "tools/call needs a tool name"));
        }
        const args = rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
        const key = keyOf(sessionId, id ?? "");
        const controller = new AbortController();
        inflight.set(key, controller);
        callSeq += 1;
        // 连接被 Agent 关掉也当作取消（有的 Agent 超时会断开）。要听响应的 close：请求的 close
        // 在请求体读完时就会触发，并不代表断开（S2 端到端实测）。
        reply.raw.once("close", () => {
          if (!reply.raw.writableEnded) controller.abort();
        });
        try {
          const result = await deps.host.callTool(grant, name, args, { requestKey: `${key}#${String(callSeq)}`, signal: controller.signal });
          if (controller.signal.aborted && reply.raw.destroyed) {
            return reply;
          }
          return sendResult(reply, id, result as unknown as JsonValue);
        } finally {
          // 同一会话的另一个客户端可能用了同一个请求 id：只删自己的。
          if (inflight.get(key) === controller) inflight.delete(key);
        }
      }
      default:
        return reply.send(rpcError(id, -32601, `method not found: ${String(message.method)}`));
    }
  });

  // 不提供服务端主动推送的 SSE 流（规范允许返回 405）。
  server.get(MCP_ENDPOINT_PATH, async (_request, reply) => reply.code(405).send());
  server.delete(MCP_ENDPOINT_PATH, async (_request, reply) => reply.code(200).send());
}

function keyOf(sessionId: string, requestId: string | number): string {
  return sessionId + ":" + String(requestId);
}

function grantOf(request: FastifyRequest, tokens: ToolTokenRegistry): ToolGrant | null {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  return token === "" ? null : tokens.resolve(token);
}

/** Host 必须是 loopback；带 Origin 时必须同源（Agent 的请求不带 Origin，浏览器跨站请求带）。 */
function guard(request: FastifyRequest): string | null {
  const host = request.headers.host;
  if (typeof host !== "string" || !isLoopbackHost(host)) {
    return "host must be a loopback address";
  }
  const origin = request.headers.origin;
  if (origin !== undefined) {
    try {
      const url = new URL(origin);
      if (url.host !== host || !isLoopbackHost(url.host)) {
        return "cross-origin requests are not allowed";
      }
    } catch {
      return "invalid origin";
    }
  }
  return null;
}

function isLoopbackHost(host: string): boolean {
  try {
    const hostname = new URL("http://" + host).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

function sendResult(reply: FastifyReply, id: string | number | null, result: JsonValue): FastifyReply {
  return reply.header("content-type", "application/json").send({ jsonrpc: "2.0", id, result });
}

function rpcError(id: string | number | null, code: number, message: string): JsonValue {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
