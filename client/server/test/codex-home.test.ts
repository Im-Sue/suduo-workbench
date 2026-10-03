import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedCodexHome } from "../src/infrastructure/platform/codex-home.js";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Codex Home defaults", () => {
  it("只补缺失的配置文件，不覆盖既有用户内容，也不再种 skill", () => {
    const root = mkdtempSync(join(tmpdir(), "suduo-codex-home-"));
    temporaryPaths.push(root);
    const defaults = join(root, "defaults");
    const home = join(root, "home");
    for (const directory of [defaults, join(defaults, "skills", "official"), home]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(join(defaults, "config.toml"), "model = 'official'\n");
    writeFileSync(join(defaults, "auth.json"), "{}\n");
    writeFileSync(join(defaults, "skills", "official", "SKILL.md"), "official\n");
    writeFileSync(join(home, "config.toml"), "model = 'user'\n");

    const seeded = seedCodexHome(defaults, home);

    expect(seeded.seeded).toEqual(["auth.json"]);
    expect(seeded.kept).toEqual(["config.toml"]);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe("model = 'user'\n");
    expect(existsSync(join(home, "skills"))).toBe(false);
  });
});
