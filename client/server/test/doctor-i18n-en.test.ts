import { CODEX_VERSION, SUDUO_DOCTOR_CHECK_IDS, type Locale } from "@suduo/client-contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor, type LinuxSandboxHost } from "../src/infrastructure/doctor/doctor-service.js";
import { renderDoctorPage } from "../src/infrastructure/http/doctor-page.js";

/**
 * `doctor` 分区：检查项的名称、结论与处理建议按语言生成；SuDuo 自己的检查项带稳定 id，
 * Codex CLI 一项带结构化的版本（前端按 id 认项、直接读版本，不再看中文名称和全角括注）。
 */

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function officialReport(codexVersion: string | null = CODEX_VERSION) {
  return {
    schemaVersion: 1,
    overallStatus: "ok",
    ...(codexVersion === null ? {} : { codexVersion }),
    checks: {
      "auth.credentials": { id: "auth.credentials", category: "auth", status: "ok", summary: "credentials found", details: {}, remediation: null },
    },
  };
}

const failingSandbox: Partial<LinuxSandboxHost> = {
  platform: "linux",
  probe: async () => ({
    status: 1,
    stdout: Buffer.from(""),
    stderr: Buffer.from("bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n"),
  }),
  systemBwrap: () => null,
  usernsRestricted: () => true,
  inContainer: () => false,
  underSystemdService: () => false,
};

async function run(
  locale: Locale,
  options: { stdout?: string; status?: number; linuxSandbox?: Partial<LinuxSandboxHost> } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "suduo-doctor-i18n-"));
  homes.push(home);
  return await runDoctor(
    {
      installed: true,
      allowPortInUse: true,
      port: 0,
      codexHome: home,
      codexBin: "/fixture/codex",
      linuxSandbox: { platform: "darwin", underSystemdService: () => false, inContainer: () => false, ...options.linuxSandbox },
      codexDoctorRunner: () => ({
        status: options.status ?? 0,
        stdout: Buffer.from(options.stdout ?? JSON.stringify(officialReport())),
        stderr: Buffer.from(""),
      }),
    },
    locale,
  );
}

describe("SuDuo 自己的检查项带稳定 id", () => {
  it("每一项都有 id，Codex CLI 带版本", async () => {
    const result = await run("en", { linuxSandbox: failingSandbox });
    const ids = result.checks.map((check) => check.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        SUDUO_DOCTOR_CHECK_IDS.node,
        SUDUO_DOCTOR_CHECK_IDS.codexDoctor,
        SUDUO_DOCTOR_CHECK_IDS.codexCli,
        SUDUO_DOCTOR_CHECK_IDS.linuxSandbox,
        SUDUO_DOCTOR_CHECK_IDS.sqlite,
        SUDUO_DOCTOR_CHECK_IDS.port,
        "auth.credentials",
      ]),
    );
    expect(result.checks.find((check) => check.id === SUDUO_DOCTOR_CHECK_IDS.codexCli)).toMatchObject({
      status: "pass",
      version: CODEX_VERSION,
    });
  });

  it("官方诊断没报版本时 version 为 null", async () => {
    const result = await run("zh-CN", { stdout: JSON.stringify(officialReport(null)) });
    expect(result.checks.find((check) => check.id === SUDUO_DOCTOR_CHECK_IDS.codexCli)).toMatchObject({
      status: "fail",
      version: null,
      message: `需要 codex-cli ${CODEX_VERSION}，当前为 未知`,
    });
  });
});

describe("名称、结论与处理建议按语言生成", () => {
  it("英文", async () => {
    const result = await run("en", { linuxSandbox: failingSandbox });
    const byId = (id: string) => result.checks.find((check) => check.id === id);
    expect(byId(SUDUO_DOCTOR_CHECK_IDS.node)?.message).toMatch(/^(.+ \(pinned\)|Needs 24\.10\.0; found .+)$/);
    expect(byId(SUDUO_DOCTOR_CHECK_IDS.codexDoctor)).toMatchObject({ name: "Codex doctor", message: "overallStatus=ok" });
    expect(byId(SUDUO_DOCTOR_CHECK_IDS.codexCli)?.message).toBe(`codex-cli ${CODEX_VERSION} (pinned in the workspace)`);
    expect(byId(SUDUO_DOCTOR_CHECK_IDS.port)).toMatchObject({ name: "Listening port", message: "127.0.0.1:0 is available" });
    expect(byId(SUDUO_DOCTOR_CHECK_IDS.sqlite)?.message).toBe(
      "The native addon loads, and migrations and WAL reads and writes work on a temporary database",
    );
    const sandbox = byId(SUDUO_DOCTOR_CHECK_IDS.linuxSandbox);
    expect(sandbox?.name).toBe("Codex sandbox (Linux)");
    expect(sandbox?.message).toBe(
      "Codex's sandbox can't start on this machine, so commands that need approval or restricted execution will fail: " +
        "the system bubblewrap isn't installed; the system restricts unprivileged user namespaces with AppArmor (the default on Ubuntu 24.04) " +
        "(bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted)",
    );
    expect(sandbox?.remediation).toMatch(/^To fix: sudo apt install bubblewrap \(Fedora: sudo dnf install bubblewrap\); then load OpenAI's AppArmor profile/);
    expect(sandbox?.remediation).toContain("Follow OpenAI's sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing");
    expect(sandbox?.remediation).toContain("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0");
    expect(JSON.stringify(result.checks)).not.toMatch(/[㐀-鿿＀-￯]/u);
  });

  it("中文与迁移前逐字一致", async () => {
    const result = await run("zh-CN", { linuxSandbox: failingSandbox });
    const byId = (id: string) => result.checks.find((check) => check.id === id);
    expect(byId(SUDUO_DOCTOR_CHECK_IDS.codexDoctor)?.name).toBe("Codex 官方诊断");
    expect(byId(SUDUO_DOCTOR_CHECK_IDS.codexCli)?.message).toBe(`codex-cli ${CODEX_VERSION}（workspace 锁定版本）`);
    expect(byId(SUDUO_DOCTOR_CHECK_IDS.port)).toMatchObject({ name: "监听端口", message: "127.0.0.1:0 可用" });
    expect(byId(SUDUO_DOCTOR_CHECK_IDS.sqlite)?.message).toBe("原生 addon 可加载，临时库 migration/WAL 写读正常");
    const sandbox = byId(SUDUO_DOCTOR_CHECK_IDS.linuxSandbox);
    expect(sandbox?.name).toBe("Codex 沙箱（Linux）");
    expect(sandbox?.message).toBe(
      "Codex 的沙箱在这台机器上起不来，需要审批或受限执行的命令都会失败：" +
        "没有安装系统的 bubblewrap；系统用 AppArmor 限制了非特权用户命名空间（Ubuntu 24.04 默认如此）" +
        "（bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted）",
    );
    expect(sandbox?.remediation).toBe(
      "sudo apt install bubblewrap（Fedora：sudo dnf install bubblewrap）；然后 加载官方的 AppArmor 放行配置：" +
        "sudo apt update && sudo apt install apparmor-profiles apparmor-utils && " +
        "sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict && " +
        "sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict。" +
        "按 OpenAI 的沙箱前置条件处理：https://developers.openai.com/codex/concepts/sandboxing" +
        "；若仍不行，可退一步放开限制：sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
    );
  });

  it("官方诊断解析失败的说明", async () => {
    const en = await run("en", { stdout: JSON.stringify({ schemaVersion: 1, checks: {} }) });
    expect(en.checks.find((check) => check.id === SUDUO_DOCTOR_CHECK_IDS.codexDoctor)?.message).toBe(
      "codex doctor --json returned invalid JSON: codex doctor --json is missing overallStatus",
    );
    const zh = await run("zh-CN", { stdout: JSON.stringify({ schemaVersion: 1, checks: {} }) });
    expect(zh.checks.find((check) => check.id === SUDUO_DOCTOR_CHECK_IDS.codexDoctor)?.message).toBe(
      "codex doctor --json 返回无效 JSON：codex doctor --json 缺少 overallStatus",
    );
    const empty = await run("en", { stdout: JSON.stringify({ ...officialReport(), checks: {} }) });
    expect(empty.checks.find((check) => check.id === SUDUO_DOCTOR_CHECK_IDS.codexDoctorEmpty)).toMatchObject({
      name: "Codex doctor",
      status: "fail",
      message: "codex doctor --json returned no checks (overallStatus=ok)",
    });
  });
});

describe("/doctor 页", () => {
  it("页面文字与 <html lang> 按语言", async () => {
    const result = await run("en");
    const html = renderDoctorPage(result, "en");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>SuDuo self-check</title>");
    expect(html).toContain("<h1>Local environment self-check</h1>");
    expect(html).not.toMatch(/[㐀-鿿]/u);
  });
});
