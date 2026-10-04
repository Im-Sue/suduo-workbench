import { describe, expect, it } from "vitest";
import { describeActivity, redactSecrets } from "../src/application/session-activity.js";
import { messagesFor } from "../src/i18n/messages/index.js";

/** 中文下的描述（与迁移前逐字一致）；英文见 session-i18n-en.test.ts。 */
const describeZh = (step: Parameters<typeof describeActivity>[0]) => describeActivity(step, messagesFor("zh-CN"));

describe("会话卡上的「正在做什么」", () => {
  it("命令去掉 shell 包装并截短", () => {
    expect(describeZh({ type: "commandExecution", command: "/bin/zsh -lc \"npm test\"" })).toBe("运行命令：npm test");
    expect(describeZh({ type: "commandExecution", command: ["git", "status"] })).toBe("运行命令：git status");
    const long = describeZh({ type: "commandExecution", command: "x".repeat(200) });
    expect(long?.length).toBeLessThanOrEqual(65);
    expect(long?.endsWith("…")).toBe(true);
  });

  it("改文件只给文件名，多个文件说数量", () => {
    expect(describeZh({ type: "fileChange", changes: [{ path: "/workspace/demo/src/cart.js" }] })).toBe("修改 cart.js");
    expect(describeZh({ type: "fileChange", changes: [{ path: "/a/b.ts" }, { path: "/a/c.ts" }] })).toBe("修改 b.ts 等 2 个文件");
  });

  it("思考、回复、工具、网页；认不出的不显示", () => {
    expect(describeZh({ type: "reasoning" })).toBe("正在思考");
    expect(describeZh({ type: "agentMessage", text: "" })).toBe("正在回复");
    expect(describeZh({ type: "mcpToolCall", tool: "search_docs" })).toBe("调用工具：search_docs");
    expect(describeZh({ type: "webSearch" })).toBe("搜索网页");
    expect(describeZh({ type: "userMessage" })).toBeNull();
    expect(describeZh(null)).toBeNull();
  });

  it("已经做完的步骤说「刚完成」，思考 / 回复做完不再显示", () => {
    expect(describeZh({ item: { type: "commandExecution", command: "npm test" }, completed: true })).toBe("刚完成：运行命令：npm test");
    expect(describeZh({ item: { type: "commandExecution", command: "npm test" }, completed: false })).toBe("运行命令：npm test");
    expect(describeZh({ item: { type: "agentMessage", text: "好" }, completed: true })).toBeNull();
  });

  it("命令里像密钥的片段打码", () => {
    expect(redactSecrets("curl -H 'Authorization: Bearer abcdefghijklmnop' https://x")).toContain("Bearer ***");
    expect(redactSecrets("OPENAI_API_KEY=sk-abcdefghijklmnop node run.js")).toBe("OPENAI_API_KEY=*** node run.js");
    expect(redactSecrets("deploy --token s3cr3tvalue --env prod")).toBe("deploy --token *** --env prod");
    expect(redactSecrets("login --password=\"p a s s\"")).toBe("login --password=***");
    expect(redactSecrets("echo sk-proj_abcdefghijk")).toBe("echo sk-***");
    expect(redactSecrets("npm test")).toBe("npm test");
    expect(redactSecrets("python run.py api_key=abc123def")).toBe("python run.py api_key=***");
    expect(redactSecrets("curl -u admin:hunter2 https://x")).toBe("curl -u *** https://x");
    expect(redactSecrets("git clone https://bot:ghp_abcdefghijklmnopqrstuvwxyz@github.com/o/r")).toBe("git clone https://***@github.com/o/r");
    expect(redactSecrets("echo ghp_abcdefghijklmnopqrst | gh auth login")).toBe("echo ghp_*** | gh auth login");
    expect(redactSecrets("gh auth login --with-token ghp_abcdefghijklmnopqrst")).not.toContain("abcdefghijklmnopqrst");
    expect(redactSecrets("echo github_pat_11ABCDEFGHIJKLMNOPQRST_xyz")).toBe("echo github_pat_***");
    expect(redactSecrets("slack xoxb-1234-5678-abcdefgh")).toBe("slack xoxb-***");
    expect(redactSecrets("aws AKIAABCDEFGHIJKLMNOP s3 ls")).toBe("aws AKIA*** s3 ls");
    expect(redactSecrets("curl -H 'Authorization: token abc123' https://x")).toBe("curl -H 'Authorization: token ***' https://x");
    expect(redactSecrets("mysql -uroot -phunter2 db")).toBe("mysql -uroot -p*** db");
    // 不误伤：普通参数与路径。
    expect(redactSecrets("pnpm -r test -- --run")).toBe("pnpm -r test -- --run");
    expect(redactSecrets("ls -p src")).toBe("ls -p src");
    expect(redactSecrets("git log -p --stat")).toBe("git log -p --stat");
  });
});
