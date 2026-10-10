import { describe, expect, it } from "vitest";
import type { DesktopUpdateState } from "@suduo/client-contracts";
import { CHECK_INTERVAL_MS, DesktopUpdater, FIRST_CHECK_MS, type UpdateBackend } from "../src/main/updater.js";
// @ts-expect-error -- 打包脚本是 .mjs，没有类型声明。
import { formatUpdateInfo, mergeUpdateInfo, parseUpdateInfo } from "../scripts/merge-update-info.mjs";

/** 桌面应用 D3：应用内更新的状态机（只提示不强制），以及合并两台 Mac 的 latest-mac.yml。 */

function setup(options: { backend?: Partial<UpdateBackend> | null; canInstall?: boolean; confirm?: boolean; quitting?: boolean } = {}) {
  const states: DesktopUpdateState[] = [];
  const opened: string[] = [];
  const installs: string[] = [];
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  const backend: UpdateBackend | null =
    options.backend === null
      ? null
      : {
          check: async () => ({ version: "1.2.0" }),
          download: async (onProgress) => {
            onProgress(40.4);
            onProgress(100);
          },
          install: () => installs.push("installed"),
          ...options.backend,
        };
  const updater = new DesktopUpdater({
    backend,
    canInstall: options.canInstall ?? true,
    releasePage: (version) => `https://example.test/releases/tag/v${version}`,
    openExternal: (url) => opened.push(url),
    emit: (state) => states.push(state),
    confirmInstall: async () => options.confirm ?? true,
    quitAndInstall: (install) => {
      if (options.quitting === true) return false;
      installs.push("quit");
      install();
      return true;
    },
    log: () => undefined,
    text: () => ({ devBuild: "dev", failed: (reason) => `failed: ${reason}` }),
    schedule: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
  });
  return { updater, states, opened, installs, timers };
}

describe("应用内更新", () => {
  it("手动检查：检查中 → 有新版本（带发布页）；Windows 点更新：下载进度 → 下好后确认 → 走退出流程再安装", async () => {
    const { updater, states, installs } = setup();
    const found = await updater.check(true);
    expect(found).toEqual({ kind: "available", version: "1.2.0", notesUrl: "https://example.test/releases/tag/v1.2.0", canInstall: true });
    await updater.install();
    expect(states.map((state) => state.kind)).toEqual(["checking", "available", "downloading", "downloading", "downloading"]);
    expect(states.filter((state) => state.kind === "downloading").map((state) => (state as { percent: number }).percent)).toEqual([0, 40, 100]);
    expect(installs).toEqual(["quit", "installed"]);
  });

  it("Mac 未签名：点更新只打开发布页；下好后使用者取消、或正在退出：先不装，回到有新版本", async () => {
    const mac = setup({ canInstall: false });
    await mac.updater.check(true);
    await mac.updater.install();
    expect(mac.opened).toEqual(["https://example.test/releases/tag/v1.2.0"]);
    expect(mac.installs).toEqual([]);
    const cancelled = setup({ confirm: false });
    await cancelled.updater.check(true);
    await cancelled.updater.install();
    expect(cancelled.installs).toEqual([]);
    expect(cancelled.updater.current().kind).toBe("available");
    const quitting = setup({ quitting: true });
    await quitting.updater.check(true);
    await quitting.updater.install();
    expect(quitting.installs).toEqual([]);
    expect(quitting.updater.current().kind).toBe("available");
  });

  it("安装进行中再点不起第二次；下载中自动检查回来不把状态盖回有新版本；进度没变不重复推", async () => {
    let release: () => void = () => undefined;
    const slow = setup({
      backend: {
        download: (onProgress) =>
          new Promise<void>((resolve) => {
            onProgress(10);
            onProgress(10.2);
            release = resolve;
          }),
      },
    });
    await slow.updater.check(true);
    const first = slow.updater.install();
    await slow.updater.install();
    await slow.updater.check(false);
    expect(slow.updater.current()).toEqual({ kind: "downloading", version: "1.2.0", percent: 10 });
    expect(slow.states.filter((state) => state.kind === "downloading")).toHaveLength(2);
    release();
    await first;
    expect(slow.installs).toEqual(["quit", "installed"]);
  });

  it("自动检查出错不打扰（回到原来的状态），手动检查出错如实说明；没有新版本：手动显示已是最新", async () => {
    const failing = setup({ backend: { check: async () => { throw new Error("offline"); } } });
    expect(await failing.updater.check(false)).toEqual({ kind: "idle" });
    expect(await failing.updater.check(true)).toEqual({ kind: "failed", message: "failed: offline" });
    const none = setup({ backend: { check: async () => null } });
    expect(await none.updater.check(false)).toEqual({ kind: "idle" });
    expect(await none.updater.check(true)).toEqual({ kind: "upToDate" });
  });

  it("下载失败说明原因、不安装；开发版没有更新源时手动检查说明，自动检查不排", async () => {
    const broken = setup({ backend: { download: async () => { throw new Error("disk full"); } } });
    await broken.updater.check(true);
    await broken.updater.install();
    expect(broken.updater.current()).toEqual({ kind: "failed", message: "failed: disk full" });
    expect(broken.installs).toEqual([]);
    const dev = setup({ backend: null });
    expect(await dev.updater.check(true)).toEqual({ kind: "failed", message: "dev" });
    dev.updater.startAuto(() => true);
    expect(dev.timers).toEqual([]);
  });

  it("定时：启动 30 秒后一次、之后每 24 小时一次；设置里关了就跳过这次", async () => {
    let enabled = true;
    let checks = 0;
    const { updater, timers } = setup({ backend: { check: async () => { checks += 1; return null; } } });
    updater.startAuto(() => enabled);
    expect(timers.map((timer) => timer.ms)).toEqual([FIRST_CHECK_MS]);
    timers[0]!.run();
    expect(checks).toBe(1);
    expect(timers.at(-1)!.ms).toBe(CHECK_INTERVAL_MS);
    enabled = false;
    timers.at(-1)!.run();
    expect(checks).toBe(1);
    updater.stop();
    expect(timers.every((timer) => timer.cancelled)).toBe(true);
  });
});

describe("合并两台 Mac 的更新信息", () => {
  const arm = [
    "version: 1.2.0",
    "files:",
    "  - url: SuDuo-1.2.0-mac-arm64.dmg",
    "    sha512: aaa+/=",
    "    size: 10",
    "path: SuDuo-1.2.0-mac-arm64.dmg",
    "sha512: aaa+/=",
    "releaseDate: '2026-10-10T01:00:00.000Z'",
  ].join("\n");
  const x64 = arm.replaceAll("arm64", "x64").replaceAll("aaa", "bbb").replace("01:00", "02:00");

  it("两份的文件并在一起、版本一致、发布时间取最新；不认识的行直接失败", () => {
    const merged = mergeUpdateInfo([parseUpdateInfo(arm), parseUpdateInfo(x64)]);
    expect(merged.files.map((file: { url: string }) => file.url)).toEqual(["SuDuo-1.2.0-mac-arm64.dmg", "SuDuo-1.2.0-mac-x64.dmg"]);
    expect(merged.releaseDate).toBe("2026-10-10T02:00:00.000Z");
    const text = formatUpdateInfo(merged);
    expect(parseUpdateInfo(text)).toEqual(merged);
    expect(() => mergeUpdateInfo([parseUpdateInfo(arm), parseUpdateInfo(arm.replace("1.2.0", "1.3.0"))])).toThrow(/versions differ/u);
    expect(() => parseUpdateInfo(`${arm}\nstagingPercentage: 50`)).toThrow(/unexpected/u);
  });
});
