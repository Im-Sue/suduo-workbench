import type { SecretHitDto } from "@suduo/client-contracts";

/**
 * 发布前的疑似密钥检查（多 Agent 协作 S11，需求 4.13）：在待发布内容的每个文字字段里找常见 API Key、令牌、私钥的样子，
 * 标出字段与遮住中间的片段，由人决定是否继续（不拦截，ADR-0004）。只是提示：会漏、也会误报。
 */
const PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu },
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/gu },
  { kind: "openai-key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/gu },
  { kind: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/gu },
  { kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/gu },
  { kind: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu },
  // 起点用同字符类的负向后顾：一串字符只从开头试一次（「eyJ-」连写几千次时逐个起点重试是平方级，第二轮复核）。
  { kind: "jwt", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu },
  // 请求头里的令牌：Authorization: Bearer / token / Basic …，以及单独出现的 Bearer …。
  { kind: "bearer", pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/giu },
  // URL 里的账号密码：postgres://user:pass@host、https://user:token@…。
  { kind: "url-credentials", pattern: /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'<>]+:[^\s/@"'<>]+@/giu },
  // 赋值形式：api_key = "…"、OPENAI_API_KEY=…、AWS_SECRET_ACCESS_KEY=…、DATABASE_PASSWORD: …（名字里带这些词，
  // 前后可以接下划线；值至少 8 个字符，排除明显的占位）。名字前后的部分用有界量词：无界的 `[\w]*` 在长串
  // （比如几万个连写的 token_）上会回溯爆炸，卡住本机服务。
  {
    kind: "assignment",
    pattern:
      /(?<![A-Za-z0-9])[A-Za-z0-9_]{0,40}?(?:api[_-]?key|secret|token|passw(?:or)?d|access[_-]?key|private[_-]?key)[A-Za-z0-9_]{0,40}["']?\s*[:=]\s*["']?(?!<|\$\{|\$[A-Z_]|\{\{|x{4,}|\*{4,}|\.\.\.)[A-Za-z0-9_\-/+=.]{8,}/giu,
  },
];

const MAX_HITS = 50;

/** 在内容里找疑似密钥；同一字段里重叠的片段只报一次（规则按从具体到宽泛排，先报具体的）。 */
export function scanSecrets(content: unknown): SecretHitDto[] {
  const hits: SecretHitDto[] = [];
  visit(content, "", (field, text) => {
    const taken: Array<[number, number]> = [];
    for (const { kind, pattern } of PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        if (hits.length >= MAX_HITS) return;
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if (taken.some(([from, to]) => start < to && from < end)) continue;
        taken.push([start, end]);
        hits.push({ field, kind, excerpt: mask(match[0]) });
      }
    }
  });
  return hits;
}

function visit(value: unknown, path: string, onText: (field: string, text: string) => void): void {
  if (typeof value === "string") {
    if (value !== "") onText(path === "" ? "content" : path, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${path}[${String(index)}]`, onText));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) visit(item, path === "" ? key : `${path}.${key}`, onText);
  }
}

/** 遮住中间：留头 4、尾 4 个字符（太短的只留头 2）。 */
function mask(secret: string): string {
  const compact = secret.replace(/\s+/gu, " ");
  if (compact.length <= 12) return `${compact.slice(0, 2)}…`;
  return `${compact.slice(0, 4)}…${compact.slice(-4)}`;
}
