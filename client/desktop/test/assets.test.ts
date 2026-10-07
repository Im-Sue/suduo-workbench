import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 安装包里捆绑的东西（scripts/assets.mjs）：Codex 必须与工作区锁定的版本一致，每个包都带发布方给的校验值。
 * 直接读文件文本：构建脚本是不带类型的 .mjs，测试只需要看清钉住的版本与校验值。
 */
const assets = readFileSync(new URL("../scripts/assets.mjs", import.meta.url), "utf8");
const pinned = (name: string) => new RegExp(`export const ${name} = "([^"]+)"`).exec(assets)?.[1];

describe("捆绑资产", () => {
  it("Codex 版本与 codex-protocol/VERSION 一致", () => {
    const workspace = readFileSync(new URL("../../codex-protocol/VERSION", import.meta.url), "utf8").trim();
    expect(pinned("CODEX_VERSION")).toBe(workspace);
  });

  it("better-sqlite3 与本机服务依赖的版本一致，预编译包按捆绑的 Node 24（ABI 137）取", () => {
    const server = JSON.parse(readFileSync(new URL("../../server/package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pinned("BETTER_SQLITE3_VERSION")).toBe(server.dependencies["better-sqlite3"]);
    expect(pinned("NODE_VERSION")).toMatch(/^24\./);
    expect(pinned("NODE_ABI")).toBe("137");
  });

  it("三个目标、每个目标三样东西，都有校验值", () => {
    for (const target of ["darwin-arm64", "darwin-x64", "win32-x64"]) {
      expect(assets).toContain(`"${target}": {`);
    }
    const integrities = assets.match(/integrity: (?:hexToSri\("sha256", "[0-9a-f]{64}"\)|"sha512-[A-Za-z0-9+/]+={0,2}")/g) ?? [];
    expect(integrities).toHaveLength(9);
  });
});
