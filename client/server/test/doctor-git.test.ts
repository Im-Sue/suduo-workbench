import { describe, expect, it } from "vitest";
import { checkGit, type DoctorCheck, type GitHost } from "../src/infrastructure/doctor/doctor-service.js";
import { messagesFor } from "../src/i18n/messages/index.js";

/** Git 检查（桌面应用 D2）：没装只提醒、给安装引导；Mac 上没装命令行工具时不碰 /usr/bin/git（会弹安装框）。 */
function host(platform: NodeJS.Platform, results: Record<string, { status: number | null; stdout: string }>): GitHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    platform,
    calls,
    run: (command, args) => {
      calls.push([command, ...args].join(" "));
      return results[command] ?? { status: null, stdout: "" };
    },
  };
}

describe("Git 检查", () => {
  it("装了：通过，带版本", () => {
    const checks: DoctorCheck[] = [];
    checkGit(checks, messagesFor("zh-CN"), host("linux", { git: { status: 0, stdout: "git version 2.43.0\n" } }));
    expect(checks).toEqual([expect.objectContaining({ id: "suduo.git", status: "pass", version: "2.43.0", message: "版本 2.43.0" })]);
  });

  it("Mac 没装命令行工具：提醒并给 xcode-select --install，不去跑 git", () => {
    const checks: DoctorCheck[] = [];
    const mac = host("darwin", { "xcode-select": { status: 2, stdout: "" } });
    checkGit(checks, messagesFor("zh-CN"), mac);
    expect(checks[0]).toMatchObject({ status: "warn", remediation: expect.stringContaining("xcode-select --install") });
    expect(mac.calls).toEqual(["xcode-select -p"]);
  });

  it("Windows 没装：提醒并给 Git for Windows", () => {
    const checks: DoctorCheck[] = [];
    checkGit(checks, messagesFor("en"), host("win32", {}));
    expect(checks[0]).toMatchObject({ status: "warn", remediation: expect.stringContaining("Git for Windows") });
  });
});
