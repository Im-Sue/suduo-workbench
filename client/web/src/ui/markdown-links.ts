import { toProjectPath } from "../features/sessions/paths.js";

/**
 * 回答里的链接怎么处理（需求 4.6）：
 * - http(s) / mailto：新标签页打开；
 * - `#xxx`：页内锚点（GFM 脚注之类），照旧；
 * - 其余当作文件路径：在项目目录里 → 交给文件面板打开（可带行号）；项目外或认不出 → 只显示文字。
 *
 * 不再生成会被浏览器当成站内地址、落到兜底页的 `<a>`。
 */
export type MarkdownLinkTarget =
  | { kind: "external"; href: string }
  | { kind: "anchor"; href: string }
  | { kind: "file"; path: string; line: number | null }
  | { kind: "text" };

const TEXT: MarkdownLinkTarget = { kind: "text" };

/** 带「名字:数字」形状但其实是协议的写法（tel:123 之类），不当文件路径。 */
const NON_FILE_SCHEMES = new Set([
  "tel",
  "sms",
  "ftp",
  "ftps",
  "ssh",
  "git",
  "irc",
  "ircs",
  "xmpp",
  "news",
  "data",
  "javascript",
  "vbscript",
]);

/**
 * 把 Markdown 链接的 href 分类。路径支持：`src/a.ts`、`./src/a.ts`、`src/a.ts:12`、`src/a.ts:12:5`、
 * `src/a.ts#L12`、`<projectRoot>/src/a.ts`、`file:///…`；URL 编码会先解码。
 * 返回的 `path` 是项目内相对路径（不以 ./ 开头、不含 ..），`line` 从 1 开始，没有则为 null。
 */
export function resolveMarkdownLink(href: string | null | undefined, projectRoot: string): MarkdownLinkTarget {
  const raw = (href ?? "").trim();
  if (raw === "") return TEXT;
  if (/^(?:https?:|mailto:)/i.test(raw)) return { kind: "external", href: raw };
  if (raw.startsWith("#")) return { kind: "anchor", href: raw };

  let value = raw;
  if (/^file:/i.test(value)) {
    // file:///Users/a.ts 与 file://localhost/Users/a.ts 都还原成 /Users/a.ts。
    value = value.replace(/^file:(?:\/\/(?:localhost)?)?/i, "");
  } else if (hasScheme(value)) {
    return TEXT;
  }

  let line: number | null = null;
  const hashAt = value.indexOf("#");
  if (hashAt >= 0) {
    const fragment = value.slice(hashAt + 1);
    value = value.slice(0, hashAt);
    line = positiveInt(/^L(\d+)/i.exec(fragment)?.[1]);
  }
  const queryAt = value.indexOf("?");
  if (queryAt >= 0) value = value.slice(0, queryAt);
  value = safeDecode(value);

  // 行号后缀：`:12`、`:12:5`（列号忽略）、`:12-20`（只定位到起始行）。
  const suffix = /:(\d+)(?::\d+)?(?:-\d+)?$/.exec(value);
  if (suffix !== null) {
    value = value.slice(0, suffix.index);
    line ??= positiveInt(suffix[1]);
  }

  const normalized = value.replace(/\\/g, "/");
  if (normalized === "" || normalized.startsWith("~")) return TEXT;
  const absolute = normalized.startsWith("/") || /^[a-z]:\//i.test(normalized);
  const relative = absolute ? toProjectPath(normalized, projectRoot) : normalized;
  if (relative === null) return TEXT;
  const clean = normalizeRelativePath(relative);
  if (clean === null) return TEXT;
  return { kind: "file", path: clean, line };
}

/** 去掉 `.`、折叠 `..`；越出项目目录或为空时返回 null。 */
export function normalizeRelativePath(path: string): string | null {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length === 0 ? null : parts.join("/");
}

function hasScheme(value: string): boolean {
  // Windows 盘符（C:\ 或 C:/）不是协议。
  if (/^[a-z]:[\\/]/i.test(value)) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (scheme === null) return false;
  // 「a.ts:12」这种是带行号的文件名，不是协议。
  const name = scheme[1]?.toLowerCase() ?? "";
  const lineLike = /^[^:/?#]+:\d+/.test(value);
  return !lineLike || NON_FILE_SCHEMES.has(name);
}

function positiveInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * react-markdown 默认会把「名字:…」当协议、不认识就清空（`a.ts:12` 会变成空链接）。
 * 这里放行文件路径形状的地址，只拦掉会执行脚本的协议。
 */
export function markdownUrlTransform(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1]?.toLowerCase();
  if (scheme === "javascript" || scheme === "vbscript" || scheme === "data") return "";
  return url;
}

// ───────────────────────── 行内代码与正文里的路径（会话回答里的文件路径可点击） ─────────────────────────

export interface PathReference {
  /** 项目内相对路径。 */
  path: string;
  /** 从 1 开始；没有行号时为 null。 */
  line: number | null;
}

/**
 * 行内代码 / 正文片段是不是「值得去问在不在」的文件路径：项目内、带 `/` 或有扩展名、没有空白。
 * 只是候选——最后要本机确认文件存在才变成链接（`receiverSnapshot` 不是候选，`order.total` 是候选但不存在）。
 */
export function resolvePathText(text: string, projectRoot: string): PathReference | null {
  const value = text.trim();
  if (value === "" || value.length > 512 || /\s/.test(value)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^mailto:/i.test(value)) return null;
  const target = resolveMarkdownLink(value, projectRoot);
  if (target.kind !== "file") return null;
  const name = target.path.split("/").at(-1) ?? "";
  // 纯数字与版本号（1.5、2.0.1）不是文件名。
  if (/^[\d.]+$/.test(name)) return null;
  const hasExtension = /\.[\p{L}\p{N}_-]{1,16}$/u.test(name);
  if (!target.path.includes("/") && !hasExtension) return null;
  return { path: target.path, line: target.line };
}

/**
 * 正文里一段像路径的文字（remark 插件切出来的），中文行文常和路径贴在一起（「入口是src/a.vue里」）：
 * 依次尝试整段、去掉开头的非 ASCII、去掉结尾的非 ASCII、两头都去，再去掉句末的点。
 * 返回各候选及其前后要原样显示的文字，调用方按顺序取第一个确认存在的。
 */
export function pathTokenCandidates(
  token: string,
  projectRoot: string,
): Array<PathReference & { before: string; text: string; after: string }> {
  const results: Array<PathReference & { before: string; text: string; after: string }> = [];
  const seen = new Set<string>();
  const leading = /^[^\x21-\x7e]+/u.exec(token)?.[0] ?? "";
  const trailing = /[^\x21-\x7e]+$/u.exec(token)?.[0] ?? "";
  const cuts: Array<[number, number]> = [
    [0, 0],
    [leading.length, 0],
    [0, trailing.length],
    [leading.length, trailing.length],
  ];
  for (const [start, end] of cuts) {
    let text = token.slice(start, token.length - end);
    let tail = token.slice(token.length - end);
    const dots = /\.+$/.exec(text)?.[0] ?? "";
    if (dots !== "") {
      text = text.slice(0, -dots.length);
      tail = dots + tail;
    }
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    const reference = resolvePathText(text, projectRoot);
    if (reference !== null) results.push({ ...reference, before: token.slice(0, start), text, after: tail });
  }
  return results;
}
