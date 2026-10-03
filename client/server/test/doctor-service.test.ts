import { CODEX_VERSION } from "@suduo/client-contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor, type LinuxSandboxHost } from "../src/infrastructure/doctor/doctor-service.js";

const INSTALLATION_REMEDIATION =
  "Fix PATH or npm prefix so the running package root matches the npm global package root.";
const UPDATES_REMEDIATION =
  "Fix PATH or npm prefix so the running package root matches the npm global package root.";

describe("doctor-service · Codex 官方诊断", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("只有 installation 与 updates.status 失败时整体通过但保留 warning 与 remediation", async () => {
    const result = await runFixture({
      status: 1,
      stdout: JSON.stringify(failingOfficialReport()),
    });

    const official = result.checks.filter((check) => check.id !== undefined);
    expect(official).toHaveLength(18);
    expect(result.status).toBe("PASS");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Codex 官方诊断",
          status: "warn",
          message: "overallStatus=fail",
        }),
        expect.objectContaining({
          id: "installation",
          status: "warn",
          remediation: INSTALLATION_REMEDIATION,
        }),
        expect.objectContaining({
          id: "updates.status",
          status: "warn",
          remediation: UPDATES_REMEDIATION,
        }),
      ]),
    );
    expect(result.checks.some((check) => check.message.includes("执行失败"))).toBe(false);
  });

  it("官方 warning 记为需留意、不阻断启动（例如新版的桌面端检查）", async () => {
    const report = failingOfficialReport({ includeNonBlockingFailures: false });
    report.overallStatus = "warning";
    report.checks["desktop.security.enforcement"] = {
      id: "desktop.security.enforcement",
      category: "desktop",
      status: "warning",
      summary: "the desktop security assessment was unavailable",
      details: {},
      remediation: "check access to macos gatekeeper diagnostics",
    };
    const result = await runFixture({ status: 0, stdout: JSON.stringify(report) });

    expect(result.status).toBe("PASS");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Codex 官方诊断", status: "warn", message: "overallStatus=warning" }),
        expect.objectContaining({ id: "desktop.security.enforcement", status: "warn", officialStatus: "warning" }),
      ]),
    );
  });

  it("config.load 失败时仍阻断启动", async () => {
    const result = await runFixture({
      status: 1,
      stdout: JSON.stringify(
        failingOfficialReport({
          includeNonBlockingFailures: false,
          configLoadStatus: "fail",
        }),
      ),
    });

    expect(result.status).toBe("FAIL");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Codex 官方诊断", status: "fail" }),
        expect.objectContaining({ id: "config.load", status: "fail" }),
      ]),
    );
  });

  it("非阻断项与 config.load 同时失败时仍阻断启动", async () => {
    const result = await runFixture({
      status: 1,
      stdout: JSON.stringify(failingOfficialReport({ configLoadStatus: "fail" })),
    });

    expect(result.status).toBe("FAIL");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "installation", status: "warn" }),
        expect.objectContaining({ id: "updates.status", status: "warn" }),
        expect.objectContaining({ id: "config.load", status: "fail" }),
        expect.objectContaining({ name: "Codex 官方诊断", status: "fail" }),
      ]),
    );
  });

  it("exit=1 且 stdout 为空时才报告执行失败", async () => {
    const result = await runFixture({ status: 1, stdout: "", stderr: "spawn failed" });
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Codex 官方诊断",
          status: "fail",
          message: expect.stringContaining("执行失败 status=1"),
        }),
      ]),
    );
    expect(result.checks.some((check) => check.id !== undefined)).toBe(false);
  });

  it("exit=0 但 stdout 非法时仍报告返回无效 JSON", async () => {
    const result = await runFixture({ status: 0, stdout: "not json" });
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Codex 官方诊断",
          status: "fail",
          message: expect.stringContaining("返回无效 JSON"),
        }),
      ]),
    );
  });

  describe("Linux 沙箱", () => {
    const probeOk = async () => ({ status: 0, stdout: Buffer.from("suduo-sandbox-ok\n"), stderr: Buffer.from("") });
    const probeFailed = async () => ({
      status: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("WARNING: proceeding\nbwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n"),
    });
    const sandboxCheck = (result: Awaited<ReturnType<typeof runFixture>>) =>
      result.checks.find((check) => check.name === "Codex 沙箱（Linux）");
    const linux = (overrides: Partial<LinuxSandboxHost>): Partial<LinuxSandboxHost> => ({
      platform: "linux",
      systemBwrap: () => "/usr/bin/bwrap",
      usernsRestricted: () => true,
      inContainer: () => false,
      ...overrides,
    });
    const report = () => ({ status: 0, stdout: JSON.stringify(passingReport()) });

    it("非 Linux 不做这项检查", async () => {
      const result = await runFixture(report());
      expect(sandboxCheck(result)).toBeUndefined();
    });

    it("在临时目录里真跑一条沙箱命令；可用且有系统 bubblewrap 时通过", async () => {
      const calls: string[][] = [];
      const result = await runFixture(
        report(),
        linux({
          probe: async (_bin, args, options) => {
            calls.push(args);
            expect(options.env["CODEX_HOME"]).toBeDefined();
            expect(args).toContain(options.cwd);
            expect(options.timeoutMs).toBeGreaterThan(0);
            return probeOk();
          },
        }),
      );
      expect(calls[0]?.slice(0, 3)).toEqual(["sandbox", "--permission-profile", ":workspace"]);
      expect(sandboxCheck(result)).toMatchObject({ status: "pass", message: expect.stringContaining("/usr/bin/bwrap") });
      expect(result.status).toBe("PASS");
    });

    it("可用但只能用 Codex 自带的 bubblewrap：需留意，建议装系统的", async () => {
      const result = await runFixture(report(), linux({ probe: probeOk, systemBwrap: () => null, usernsRestricted: () => false }));
      expect(sandboxCheck(result)).toMatchObject({ status: "warn", remediation: expect.stringContaining("sudo apt install bubblewrap") });
      expect(result.status).toBe("PASS");
    });

    it("起不来：需留意（不阻断安装与启动），说明原因并按官方前置条件给出处理办法", async () => {
      const result = await runFixture(report(), linux({ probe: probeFailed, systemBwrap: () => null }));
      const check = sandboxCheck(result);
      expect(result.status).toBe("PASS");
      expect(check?.status).toBe("warn");
      expect(check?.message).toContain("没有安装系统的 bubblewrap");
      expect(check?.message).toContain("AppArmor");
      expect(check?.message).toContain("bwrap: loopback: Failed RTM_NEWADDR");
      expect(check?.remediation).toContain("sudo apt install bubblewrap");
      expect(check?.remediation).toContain("/usr/share/apparmor/extra-profiles/bwrap-userns-restrict");
      expect(check?.remediation).toContain("apparmor_restrict_unprivileged_userns=0");
    });

    it("装了系统 bubblewrap 但仍被限制：只提示加载 AppArmor 配置", async () => {
      const result = await runFixture(report(), linux({ probe: probeFailed }));
      const check = sandboxCheck(result);
      expect(check?.message).not.toContain("没有安装系统的 bubblewrap");
      expect(check?.remediation).not.toContain("sudo apt install bubblewrap（");
      expect(check?.remediation).toContain("apparmor_parser -r");
      expect(check?.remediation).not.toContain("pnpm install:m1");
    });

    it("作为系统服务在跑时，另提示用新版安装脚本更新服务配置", async () => {
      const result = await runFixture(report(), linux({ probe: probeFailed, underSystemdService: () => true }));
      expect(sandboxCheck(result)?.remediation).toContain("pnpm install:m1");
    });

    it("容器里：说容器的事，不建议在容器里装 AppArmor 配置", async () => {
      const result = await runFixture(report(), linux({ probe: probeFailed, inContainer: () => true }));
      const check = sandboxCheck(result);
      expect(check?.message).toContain("容器");
      expect(check?.remediation).toContain("seccomp=unconfined");
      expect(check?.remediation).not.toContain("apparmor_parser");
      expect(check?.remediation).not.toContain("sysctl");
    });

    it("Codex 自己没跑起来（不是命名空间的问题）：不把它说成 bubblewrap 的毛病", async () => {
      const result = await runFixture(
        report(),
        linux({ probe: async () => ({ status: 1, stdout: Buffer.from(""), stderr: Buffer.from("Error loading config.toml: invalid type") }) }),
      );
      const check = sandboxCheck(result);
      expect(check?.status).toBe("warn");
      expect(check?.message).toContain("没能运行 Codex 的沙箱命令");
      expect(check?.message).not.toContain("bubblewrap");
    });

    it("超时：明说超时", async () => {
      const result = await runFixture(
        report(),
        linux({ probe: async () => ({ status: null, stdout: Buffer.from(""), stderr: Buffer.from(""), timedOut: true }) }),
      );
      expect(sandboxCheck(result)).toMatchObject({ status: "warn", message: expect.stringContaining("没有结束") });
    });
  });

  async function runFixture(
    input: {
      status: number;
      stdout: string;
      stderr?: string;
    },
    linuxSandbox: Partial<LinuxSandboxHost> = { platform: "darwin" },
  ) {
    const home = mkdtempSync(join(tmpdir(), "suduo-doctor-official-"));
    homes.push(home);
    return await runDoctor({
      installed: true,
      allowPortInUse: true,
      port: 0,
      codexHome: home,
      codexBin: "/fixture/codex",
      // 默认按非 Linux 跑，免得在 Linux 上真去探测沙箱；也不读真实环境判断是不是系统服务。
      linuxSandbox: { underSystemdService: () => false, inContainer: () => false, ...linuxSandbox },
      codexDoctorRunner: (bin, args, options) => {
        expect(bin).toBe("/fixture/codex");
        expect(args).toEqual(["doctor", "--json"]);
        expect(options.env["CODEX_HOME"]).toBe(home);
        return {
          status: input.status,
          stdout: Buffer.from(input.stdout),
          stderr: Buffer.from(input.stderr ?? ""),
        };
      },
    });
  }
});

function failingOfficialReport(options: {
  includeNonBlockingFailures?: boolean;
  configLoadStatus?: "fail";
} = {}) {
  const checks: Record<
    string,
    {
      id: string;
      category: string;
      status: string;
      summary: string;
      details: Record<string, never>;
      remediation: string | null;
    }
  > = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => {
      const id = "fixture.ok." + String(index + 1);
      return [
        id,
        {
          id,
          category: "fixture",
          status: "ok",
          summary: "fixture check " + String(index + 1),
          details: {},
          remediation: null,
        },
      ];
    }),
  );
  if (options.configLoadStatus === "fail") {
    checks["config.load"] = {
      id: "config.load",
      category: "config",
      status: "fail",
      summary: "config could not be loaded",
      details: {},
      remediation: "Fix config.toml.",
    };
  }
  if (options.includeNonBlockingFailures ?? true) {
    checks["installation"] = {
      id: "installation",
      category: "install",
      status: "fail",
      summary: "npm install -g @openai/codex would update a different install",
      details: {},
      remediation: INSTALLATION_REMEDIATION,
    };
    checks["updates.status"] = {
      id: "updates.status",
      category: "updates",
      status: "fail",
      summary: "update would target a different npm install",
      details: {},
      remediation: UPDATES_REMEDIATION,
    };
  }
  return {
    schemaVersion: 1,
    overallStatus: "fail",
    codexVersion: CODEX_VERSION,
    checks,
  };
}

function passingReport() {
  const report = failingOfficialReport({ includeNonBlockingFailures: false });
  report.overallStatus = "ok";
  return report;
}
