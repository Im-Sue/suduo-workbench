import type { McpServerDto } from "@suduo/client-contracts";
import { currentLocale } from "../../i18n/locale.js";
import { messagesFor } from "../../i18n/messages/index.js";

/**
 * MCP 服务编辑的纯逻辑。
 *
 * 参数（args）在界面上是一行文本，存到 Codex 配置里是字符串数组。两者之间的往返必须无损：
 * 用户可能在 config.toml 里手写过含空格、引号或空字符串的参数，打开编辑、只改了别处就保存，
 * 不能把 "/Users/me/My Projects" 拆成两段写回去（不可逆字节损失）。所以：
 * - 显示时按 shell 习惯给需要的参数加引号（formatArgs）；
 * - 解析时按同样规则拆（parseArgs），formatArgs ∘ parseArgs 是恒等；
 * - 编辑时只发改了的部分（buildMcpUpdate）：参数文本没动就不发 args，什么都没改就不发请求。
 */

/** 需要加引号的参数：空串、含空白或引号 / 反斜杠。 */
function needsQuoting(arg: string): boolean {
  return arg === "" || /[\s"'\\]/.test(arg);
}

export function formatArgs(args: readonly string[]): string {
  return args
    .map((arg) => (needsQuoting(arg) ? `"${arg.replace(/(["\\])/g, "\\$1")}"` : arg))
    .join(" ");
}

export type ParsedArgs = { ok: true; args: string[] } | { ok: false; message: string };

/**
 * 按空白拆分；双引号内可用 \" 与 \\ 转义，单引号内原样；引号外的反斜杠转义下一个字符。
 * 引号没闭合时报错，不猜；报错文字按调用时的界面语言取。
 */
export function parseArgs(text: string): ParsedArgs {
  const args: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === "\\" && (text[index + 1] === '"' || text[index + 1] === "\\")) {
        current += text[index + 1];
        index += 1;
      } else if (char === '"') {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (/\s/.test(char)) {
      if (inToken) {
        args.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    inToken = true;
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "\\" && index + 1 < text.length) {
      current += text[index + 1];
      index += 1;
    } else {
      current += char;
    }
  }
  if (quote !== null) return { ok: false, message: messagesFor(currentLocale()).settingsAgent.mcp.form.argsUnclosedQuote };
  if (inToken) args.push(current);
  return { ok: true, args };
}

export function splitEnvVars(raw: string): string[] {
  return raw
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export interface McpDraft {
  transport: "stdio" | "http";
  name: string;
  command: string;
  args: string;
  envVars: string;
  url: string;
  bearerEnv: string;
}

export function draftFor(target: McpServerDto | "new" | null): McpDraft {
  if (target === null || target === "new") {
    return { transport: "stdio", name: "", command: "", args: "", envVars: "", url: "", bearerEnv: "" };
  }
  return {
    transport: target.transport,
    name: target.name,
    command: target.command ?? "",
    args: formatArgs(target.args),
    envVars: target.envVars.join(", "),
    url: target.url ?? "",
    bearerEnv: target.bearerTokenEnvVar ?? "",
  };
}

export type McpUpdateBody = {
  transport?:
    | { type: "stdio"; command: string; args?: string[] }
    | { type: "http"; url: string; bearerTokenEnvVar?: string | null };
  envVars?: string[];
};

/**
 * 编辑时要发的补丁：只含改动的部分；返回 null 表示什么都没改（不发请求）。
 * - envVars 放在顶层（服务端 mergeServer 只读顶层；transport 里的 envVars 会被忽略）；
 * - 本机命令的参数文本没动时沿用原数组，不经过解析；
 * - 换连接方式时发完整的新 transport（服务端会先删后加）。
 */
export function buildMcpUpdate(target: McpServerDto, draft: McpDraft): { ok: true; body: McpUpdateBody | null } | { ok: false; message: string } {
  const initial = draftFor(target);
  const body: McpUpdateBody = {};
  if (draft.transport === "stdio") {
    const argsChanged = draft.args !== initial.args;
    const parsed: ParsedArgs = argsChanged ? parseArgs(draft.args) : { ok: true, args: [...target.args] };
    if (!parsed.ok) return parsed;
    if (draft.transport !== initial.transport || draft.command.trim() !== initial.command || argsChanged) {
      body.transport = { type: "stdio", command: draft.command.trim(), args: parsed.args };
    }
    const envVars = splitEnvVars(draft.envVars);
    if (draft.transport !== initial.transport || envVars.join(",") !== target.envVars.join(",")) {
      body.envVars = envVars;
    }
  } else if (
    draft.transport !== initial.transport ||
    draft.url.trim() !== initial.url ||
    draft.bearerEnv.trim() !== initial.bearerEnv
  ) {
    body.transport = { type: "http", url: draft.url.trim(), bearerTokenEnvVar: draft.bearerEnv.trim() === "" ? null : draft.bearerEnv.trim() };
  }
  return { ok: true, body: Object.keys(body).length === 0 ? null : body };
}
