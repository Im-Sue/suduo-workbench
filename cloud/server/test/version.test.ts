import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveServiceVersion, VERSION_FILE_NAME } from "../src/version.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 模拟 cloud/ 工作区：<workspace>/package.json 与 <workspace>/server/。 */
function workspace(packageJson?: unknown): { serverRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "suduo-version-"));
  roots.push(root);
  const serverRoot = join(root, "server");
  mkdirSync(serverRoot);
  if (packageJson !== undefined) {
    writeFileSync(join(root, "package.json"), JSON.stringify(packageJson));
  }
  return { serverRoot };
}

describe("resolveServiceVersion", () => {
  it("环境变量 SUDUO_VERSION 优先", () => {
    const { serverRoot } = workspace({ name: "suduo-cloud", version: "0.6.5" });
    writeFileSync(join(serverRoot, VERSION_FILE_NAME), "0.7.0\n");
    expect(resolveServiceVersion({ SUDUO_VERSION: " 0.8.0 " }, serverRoot)).toBe("0.8.0");
  });

  it("镜像里没有环境变量时读服务目录下的版本文件", () => {
    const { serverRoot } = workspace();
    writeFileSync(join(serverRoot, VERSION_FILE_NAME), "0.7.0\n");
    expect(resolveServiceVersion({}, serverRoot)).toBe("0.7.0");
  });

  it("源码运行时读 cloud/package.json", () => {
    const { serverRoot } = workspace({ name: "suduo-cloud", version: "0.6.5" });
    expect(resolveServiceVersion({}, serverRoot)).toBe("0.6.5");
  });

  it("上一级不是 SuDuo 云端工作区、或什么都没有时为 dev", () => {
    expect(resolveServiceVersion({}, workspace({ name: "other", version: "9.9.9" }).serverRoot)).toBe("dev");
    expect(resolveServiceVersion({}, workspace().serverRoot)).toBe("dev");
  });

  it("在本仓库里直接运行时得到 cloud/package.json 的版本", () => {
    expect(resolveServiceVersion({})).toMatch(/^\d+\.\d+\.\d+/);
  });
});
