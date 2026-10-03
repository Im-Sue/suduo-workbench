import { CODEX_VERSION } from "@suduo/client-contracts";
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultCodexHome,
  defaultSuDuoConfigDir,
  defaultSuDuoDataDir,
  prepareCodexHome,
} from "../src/infrastructure/platform/host-platform.js";
import { processTreeTerminationCommand } from "../src/infrastructure/platform/process-control.js";
import { resolvePinnedCodexBin, withNodeOnPath } from "../src/infrastructure/platform/codex-bin.js";
import { applyRuntimeConfigFromArgs } from "../src/infrastructure/platform/runtime-config.js";
import { decodeWindowsCommandOutput } from "../src/infrastructure/platform/windows-command-output.js";
import {
  isContainedPath,
  validateRelativePath,
} from "../src/infrastructure/workspace/path-guard.js";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Windows platform adaptation", () => {
  it("uses APPDATA and LOCALAPPDATA defaults on Windows", () => {
    const env = {
      APPDATA: "C:\\Users\\pm\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\pm\\AppData\\Local",
    };
    expect(
      defaultSuDuoConfigDir({ platform: "win32", env, homeDir: "C:\\Users\\pm" }),
    ).toBe("C:\\Users\\pm\\AppData\\Roaming\\SuDuo");
    expect(
      defaultSuDuoDataDir({ platform: "win32", env, homeDir: "C:\\Users\\pm" }),
    ).toBe("C:\\Users\\pm\\AppData\\Local\\SuDuo");
  });

  it("defaults CODEX_HOME to ~/.codex, where Codex itself keeps its configuration", () => {
    expect(defaultCodexHome({ platform: "darwin", homeDir: "/Users/pm" })).toBe("/Users/pm/.codex");
    expect(defaultCodexHome({ platform: "win32", homeDir: "C:\\Users\\pm" })).toBe("C:\\Users\\pm\\.codex");
  });

  it("creates the default CODEX_HOME when missing, but never an explicitly configured one", () => {
    const home = mkdtempSync(join(tmpdir(), "suduo-codex-home-"));
    temporaryPaths.push(home);
    const prepared = prepareCodexHome(undefined, { homeDir: home, platform: "linux" });
    expect(prepared).toEqual({ path: join(home, ".codex"), isDefault: true, exists: true });
    expect(existsSync(join(home, ".codex"))).toBe(true);

    const typo = join(home, "codex-typo");
    expect(prepareCodexHome(typo, { homeDir: home })).toEqual({ path: typo, isDefault: false, exists: false });
    expect(existsSync(typo)).toBe(false);
    // 空字符串按未设置处理。
    expect(prepareCodexHome("", { homeDir: home, platform: "linux" }).isDefault).toBe(true);
  });

  it("uses Application Support on macOS and XDG directories on Linux", () => {
    expect(defaultSuDuoDataDir({ platform: "darwin", env: {}, homeDir: "/Users/pm" })).toBe(
      "/Users/pm/Library/Application Support/SuDuo",
    );
    expect(defaultSuDuoConfigDir({ platform: "darwin", env: {}, homeDir: "/Users/pm" })).toBe(
      "/Users/pm/Library/Application Support/SuDuo",
    );
    expect(defaultSuDuoDataDir({ platform: "linux", env: {}, homeDir: "/home/pm" })).toBe("/home/pm/.local/share/suduo");
    expect(
      defaultSuDuoDataDir({ platform: "linux", env: { XDG_DATA_HOME: "/data/xdg" }, homeDir: "/home/pm" }),
    ).toBe("/data/xdg/suduo");
  });

  it("uses taskkill for a Windows process tree", () => {
    expect(processTreeTerminationCommand(42, "graceful", "win32")).toEqual({
      command: "taskkill.exe",
      args: ["/PID", "42", "/T"],
    });
    expect(processTreeTerminationCommand(42, "force", "win32")).toEqual({
      command: "taskkill.exe",
      args: ["/PID", "42", "/T", "/F"],
    });
    expect(processTreeTerminationCommand(42, "force", "linux")).toBeNull();
  });

  it("rejects Windows drive and UNC escapes independently of host OS", () => {
    expect(
      isContainedPath("C:\\project", "C:\\project\\src\\a.ts", win32),
    ).toBe(true);
    expect(isContainedPath("C:\\project", "D:\\other\\a.ts", win32)).toBe(
      false,
    );
    expect(isContainedPath("/project", "/project-other/a.ts", posix)).toBe(false);
    expect(() => validateRelativePath("C:\\Windows\\system.ini")).toThrow();
    expect(() => validateRelativePath("\\\\server\\share\\file.txt")).toThrow();
  });

  it("keeps raw bytes and both UTF-8/GBK views for Windows diagnostics", () => {
    expect(
      decodeWindowsCommandOutput(Buffer.from([0xb2, 0xe2, 0xca, 0xd4])),
    ).toMatchObject({
      bytes: 4,
      base64: "suLK1A==",
      gbk: "测试",
    });
  });

  it("loads only allowlisted relative runtime configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "suduo-runtime-config-"));
    temporaryPaths.push(directory);
    const configDirectory = join(directory, "config");
    const configPath = join(configDirectory, "runtime.json");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        environment: {
          SUDUO_HOST: "127.0.0.1",
          SUDUO_DB_PATH: "data/suduo.sqlite",
          SUDUO_CODEX_BIN: "runtime/codex/codex.exe",
        },
      }),
    );
    const environment: NodeJS.ProcessEnv = {};
    const applied = applyRuntimeConfigFromArgs(
      ["--runtime-config", configPath],
      environment,
      directory,
    );
    expect(applied?.installRoot).toBe(directory);
    expect(environment["SUDUO_HOST"]).toBe("127.0.0.1");
    expect(environment["SUDUO_DB_PATH"]).toBe(
      join(directory, "data", "suduo.sqlite"),
    );
  });

  it("prefers the workspace-pinned Codex binary and never returns a bare PATH command", () => {
    const directory = mkdtempSync(join(tmpdir(), "suduo-codex-bin-"));
    temporaryPaths.push(directory);
    const bin = join(
      directory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "codex.cmd" : "codex",
    );
    mkdirSync(join(directory, "node_modules", ".bin"), { recursive: true });
    writeFileSync(bin, "fixture");
    expect(
      resolvePinnedCodexBin({ workspaceRoot: directory, configuredBin: "codex" }),
    ).toBe(bin);
    expect(() =>
      resolvePinnedCodexBin({ workspaceRoot: join(directory, "no-package"), configuredBin: "codex" }),
    ).toThrow("SUDUO_CODEX_BIN");
  });
});

describe("Windows 上的 Codex 可执行文件", () => {
  it("优先用 vendor 里的 codex.exe，避开经 cmd 启动 codex.cmd 时路径带空格的问题", () => {
    const root = mkdtempSync(join(tmpdir(), "suduo codex win "));
    temporaryPaths.push(root);
    const exe = join(
      root, "node_modules", ".pnpm", `@openai+codex@${CODEX_VERSION}-win32-x64`,
      "node_modules", "@openai", "codex", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe",
    );
    mkdirSync(join(exe, ".."), { recursive: true });
    writeFileSync(exe, "");
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".bin", "codex.cmd"), "");
    expect(resolvePinnedCodexBin({ workspaceRoot: root, platform: "win32" })).toBe(exe);
    // 其他平台照旧用 node_modules/.bin 下的启动脚本。
    writeFileSync(join(root, "node_modules", ".bin", "codex"), "");
    expect(resolvePinnedCodexBin({ workspaceRoot: root, platform: "darwin" })).toBe(join(root, "node_modules", ".bin", "codex"));
  });

  it("找不到 vendor 里的 codex.exe 时退回 codex.cmd", () => {
    const root = mkdtempSync(join(tmpdir(), "suduo-codex-win-"));
    temporaryPaths.push(root);
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".bin", "codex.cmd"), "");
    expect(resolvePinnedCodexBin({ workspaceRoot: root, platform: "win32" })).toBe(join(root, "node_modules", ".bin", "codex.cmd"));
  });
});

describe("Codex 子进程的 PATH", () => {
  it("把本机服务所用 node 的目录放到 PATH 最前面，继承来的其余目录原样保留", () => {
    const env = { PATH: "/snap/bin:/usr/local/bin:/usr/bin", HOME: "/home/u" };
    expect(withNodeOnPath(env, "/home/u/.local/share/mise/installs/node/24.10.0/bin/node", "linux")).toEqual({
      PATH: "/home/u/.local/share/mise/installs/node/24.10.0/bin:/snap/bin:/usr/local/bin:/usr/bin",
      HOME: "/home/u",
    });
  });

  it("node 目录已在 PATH 里就不动（不改变原有顺序）", () => {
    const env = { PATH: "/usr/local/bin:/usr/bin" };
    expect(withNodeOnPath(env, "/usr/bin/node", "linux")).toBe(env);
  });

  it("没有 PATH 时只放 node 目录", () => {
    expect(withNodeOnPath({}, "/opt/node/bin/node", "linux")).toEqual({ PATH: "/opt/node/bin" });
  });

  it("Windows：沿用已有的 Path 键名，分号分隔，比较不分大小写", () => {
    const env = { Path: "C:\\Windows\\system32;C:\\Windows" };
    expect(withNodeOnPath(env, "C:\\SuDuo\\node\\node.exe", "win32")).toEqual({
      Path: "C:\\SuDuo\\node;C:\\Windows\\system32;C:\\Windows",
    });
    const already = { Path: "c:\\suduo\\NODE;C:\\Windows" };
    expect(withNodeOnPath(already, "C:\\SuDuo\\node\\node.exe", "win32")).toBe(already);
  });
});
