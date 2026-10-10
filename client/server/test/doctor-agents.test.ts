import type { AgentDto, AgentListDto } from "@suduo/client-contracts";
import { describe, expect, it } from "vitest";
import { isVerifiedVersion } from "../src/application/agents/catalog.js";
import { checkAgents, formatDoctorText, runDoctor, type DoctorCheck, type DoctorResult } from "../src/infrastructure/doctor/doctor-service.js";
import { messagesFor } from "../src/i18n/messages/index.js";

/** 诊断按 Agent 分组、已验证版本只提示（多 Agent S12）。 */

function agent(overrides: Partial<AgentDto>): AgentDto {
  return {
    id: "opencode",
    displayName: "OpenCode",
    vendor: "OpenCode",
    channel: "acp",
    bundled: false,
    runtimeAvailable: true,
    enabled: true,
    status: "installed",
    reasonCode: null,
    reasonDetail: null,
    version: "1.18.35",
    minVersion: null,
    verifiedVersions: ["1.18.35"],
    versionVerified: true,
    executablePath: "/usr/local/bin/opencode",
    actions: [],
    capabilities: [],
    readOnlyCapable: true,
    homepageUrl: "https://opencode.ai",
    termsUrl: null,
    checkedAt: 1,
    ...overrides,
  };
}

describe("诊断里的各家 Agent", () => {
  it("启用了、装了的一家一项（按 agentId 分组）；Codex、停用的、没装的非默认 Agent 不列；没装的默认 Agent 提醒并给安装说明", () => {
    const list: AgentListDto = {
      defaultAgentId: "gemini",
      agents: [
        agent({ id: "codex", displayName: "Codex", bundled: true, channel: "codex-app-server" }),
        agent({}),
        agent({ id: "claude-code", displayName: "Claude Code", channel: "claude-sdk", status: "ready", version: "2.1.284", verifiedVersions: ["2.1.284"] }),
        agent({ id: "cursor", displayName: "Cursor", status: "not_installed", version: null, executablePath: null }),
        agent({ id: "qwen-code", displayName: "Qwen Code", enabled: false }),
        agent({ id: "gemini", displayName: "Gemini CLI", status: "not_installed", version: null, executablePath: null, homepageUrl: "https://g.dev" }),
      ],
    };
    const checks: DoctorCheck[] = [];
    checkAgents(checks, messagesFor("zh-CN"), list);
    expect(checks.map((check) => [check.agentId, check.id, check.status])).toEqual([
      ["opencode", "suduo.agent", "pass"],
      ["claude-code", "suduo.agent", "pass"],
      ["gemini", "suduo.agent", "warn"],
    ]);
    expect(checks[0]!.message).toBe("已安装，版本 1.18.35，登录状态第一次用时确认；位置 /usr/local/bin/opencode");
    expect(checks[2]!.remediation).toContain("https://g.dev");
  });

  it("版本没验证过只提醒（不失败）；需要登录给登录命令；低于最低版本才算失败", () => {
    const checks: DoctorCheck[] = [];
    checkAgents(checks, messagesFor("en"), {
      defaultAgentId: "codex",
      agents: [
        agent({ version: "2.0.1", versionVerified: false }),
        agent({ id: "claude-code", displayName: "Claude Code", status: "auth_required", actions: [{ kind: "open_terminal_login", command: "claude /login" }] }),
        agent({ id: "gemini", displayName: "Gemini CLI", status: "version_unsupported", version: "0.1.0", minVersion: "0.5.0" }),
      ],
    });
    expect(checks.map((check) => check.status)).toEqual(["warn", "warn", "fail"]);
    expect(checks[0]!.message).toContain("isn't in the range SuDuo has verified (1.18.35)");
    expect(checks[1]!.remediation).toContain("claude /login");
  });

  it("命令行输出：SuDuo 自己的项在前，各家 Agent 分组列出", () => {
    const result = {
      status: "PASS",
      checkedAt: "t",
      platform: "darwin",
      mode: "source",
      codexHome: "/c",
      dataDir: "/d",
      port: 8787,
      configDir: "/c",
      checks: [
        { id: "suduo.node", name: "Node.js", status: "pass", message: "24" },
        { id: "suduo.codex-cli", name: "Codex CLI", status: "pass", message: "0.159.2", agentId: "codex" },
        { id: "suduo.agent", name: "OpenCode", status: "warn", message: "x", agentId: "opencode" },
        { id: "suduo.port", name: "port", status: "pass", message: "ok" },
      ],
    } as DoctorResult;
    const text = formatDoctorText(result);
    expect(text.indexOf("PASS port")).toBeLessThan(text.indexOf("[codex]"));
    expect(text.indexOf("[codex]")).toBeLessThan(text.indexOf("PASS Codex CLI"));
    expect(text.indexOf("[opencode]\nWARN OpenCode: x")).toBeGreaterThan(text.indexOf("PASS Codex CLI"));
  });

  it("服务里跑诊断时最多等一会儿：检测没完成就用手上已有的结果（还在检测），不拖住设置页与首启向导", async () => {
    const started = Date.now();
    const result = await runDoctor(
      {
        installed: true,
        allowPortInUse: true,
        port: 1,
        codexHome: "/tmp/none",
        codexBin: "/bin/false",
        codexDoctorRunner: () => ({ status: 1, stdout: null, stderr: Buffer.from("x") }),
        linuxSandbox: { platform: "darwin" },
        agents: () => new Promise(() => undefined),
        agentsNow: () => ({ defaultAgentId: "codex", agents: [agent({ status: "checking", version: null })] }),
        agentsWaitMs: 50,
      },
      "zh-CN",
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.checks.find((check) => check.agentId === "opencode")).toMatchObject({ status: "warn", message: expect.stringContaining("还在检测") });
  });

  it("验证过的范围：同一大版本、次版本即算；没读到版本或没有验证过的版本为 null", () => {
    expect(isVerifiedVersion("2.1.290", ["2.1.284"])).toBe(true);
    expect(isVerifiedVersion("2.2.0", ["2.1.284"])).toBe(false);
    expect(isVerifiedVersion("1.18.35-beta.1", ["1.18.35"])).toBe(true);
    expect(isVerifiedVersion(null, ["1.0.0"])).toBeNull();
    expect(isVerifiedVersion("1.0.0", [])).toBeNull();
  });
});
