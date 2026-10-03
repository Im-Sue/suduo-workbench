import {
  mkdirSync,
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
    ).toBe("C:\\Users\\pm\\AppData\\Local\\SuDuo\\data");
  });

  it("defaults CODEX_HOME to ~/.codex, where Codex itself keeps its configuration", () => {
    expect(defaultCodexHome({ platform: "darwin", homeDir: "/Users/pm" })).toBe("/Users/pm/.codex");
    expect(defaultCodexHome({ platform: "win32", homeDir: "C:\\Users\\pm" })).toBe("C:\\Users\\pm\\.codex");
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
