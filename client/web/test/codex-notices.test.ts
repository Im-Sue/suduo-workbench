import { describe, expect, it } from "vitest";
import { describeCodexError, describePermissions, localizeNotice } from "../src/event-projection/shared.js";

describe("Codex 提示本地化", () => {
  it("忽略了不认识的配置项：列出键名，不带本机配置文件路径", () => {
    const text = [
      "Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.",
      "user (/home/dev/.codex/config.toml): `suduo_gate_c_probe` is ignored.",
      "user (/home/dev/.codex/config.toml): `model_supports_reasoning_summaries` is ignored.",
    ].join("\n");
    const localized = localizeNotice(text);
    expect(localized).toContain("Codex 忽略了 2 个不认识的配置项");
    expect(localized).toContain("suduo_gate_c_probe、model_supports_reasoning_summaries");
    expect(localized).not.toContain("/home/dev");
  });

  it("配置项很多被截断时说「等」", () => {
    const text = [
      "Codex is ignoring 9 unrecognized configuration settings. Check for typos or deprecated settings.",
      "user (/x/config.toml): `a` is ignored.",
      "... and 8 more ignored settings.",
    ].join("\n");
    expect(localizeNotice(text)).toContain("：a 等。");
  });

  it("Linux 上没装 bubblewrap、沙箱建不了命名空间：指向诊断里的处理办法", () => {
    expect(
      localizeNotice(
        "Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.",
      ),
    ).toContain("sudo apt install bubblewrap");
    expect(localizeNotice("Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.")).toContain(
      "「命令沙箱」",
    );
  });

  it("认不出的提示原样透出", () => {
    expect(localizeNotice("something new")).toBe("something new");
  });
});

describe("Codex 错误说成人话", () => {
  it("新版的错误种类都有中文说明", () => {
    for (const info of [
      "rateLimitExceeded",
      "flexUnavailable",
      "misalignmentPolicyViolation",
      "tooManyDenials",
      "sessionBudgetExceeded",
      "cyberPolicy",
      "threadRollbackFailed",
    ]) {
      const text = describeCodexError({ message: "x", codexErrorInfo: info });
      expect(text, info).not.toBe("x");
      expect(text, info).toMatch(/[一-鿿]/);
    }
  });

  it("「等待网络」式的重连也说清楚", () => {
    expect(describeCodexError({ message: "Reconnecting... waiting for network" })).toBe(
      "和模型服务的连接断了，正在等网络恢复后重连…",
    );
    expect(describeCodexError({ message: "Reconnecting... 2/5", codexErrorInfo: null })).toContain("第 2/5 次");
  });
});

describe("权限审批的范围说成人话", () => {
  it("新旧两种文件权限写法与联网都列出来", () => {
    expect(
      describePermissions({
        fileSystem: {
          entries: [
            { access: "write", path: { type: "path", path: "/work/out" } },
            { access: "read", path: { type: "glob_pattern", pattern: "/data/**/*.csv" } },
          ],
          read: ["/etc/hosts"],
        },
        network: { enabled: true },
      }),
    ).toBe("写入 /work/out\n读取 /data/**/*.csv\n读取 /etc/hosts\n联网");
  });

  it("什么都没要时为空", () => {
    expect(describePermissions({ fileSystem: null, network: { enabled: false } })).toBe("");
    expect(describePermissions(undefined)).toBe("");
  });
});
