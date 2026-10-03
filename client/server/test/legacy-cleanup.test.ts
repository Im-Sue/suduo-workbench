import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { retireLegacySessionContext } from "../src/application/session-tools/legacy-cleanup.js";

// 旧版种子进 CODEX_HOME 的 skill 的实际目录名（品牌更名前，ADR-0010）。
const PUBLISH_SKILL = "zjwork-publish-artifact-version"; // eslint-disable-line no-restricted-syntax -- 旧版实际目录名
const FETCH_SKILL = "zjwork-fetch-artifact-version"; // eslint-disable-line no-restricted-syntax -- 旧版实际目录名

/**
 * 旧版需求会话机制的一次性清理（技术设计三、旧数据清理 / 旧 skill）：
 * SuDuo 自己生成的副本直接删；CODEX_HOME 里的旧 skill 只移动（ADR-0004：删 skill 目录是红线）。
 */

const temporaryPaths: string[] = [];
afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function base(): string {
  const directory = mkdtempSync(join(tmpdir(), "suduo-legacy-"));
  temporaryPaths.push(directory);
  return directory;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function layout() {
  const root = base();
  const dataDir = join(root, "data", "v2");
  const project = join(root, "project");
  const bareProject = join(root, "bare-project");
  const codexHome = join(root, "codex-home");
  const retired = join(root, "data", "retired-skills");
  write(join(dataDir, "materials", "p1", "r1", "v3-1", "manifest.json"), "{}");
  // 数据目录可配到任意位置：materials 下 SuDuo 没登记过的东西不删（审查第 12 条）。
  write(join(dataDir, "materials", "not-ours", "x.txt"), "keep");
  write(join(dataDir, "observations", "s1", "current.md"), "现状");
  write(join(dataDir, "keep", "x.txt"), "keep");
  write(join(project, ".suduo", "observations", "REQ-1.md"), "现状");
  write(join(project, ".suduo", "observed", "att-1.png"), "png");
  write(join(project, ".suduo", "requirements", "REQ-1-t", "notes.md"), "笔记");
  write(join(project, ".suduo", ".gitignore"), "*\n");
  write(join(project, "src", "a.ts"), "export {};");
  mkdirSync(bareProject, { recursive: true });
  write(join(codexHome, "skills", PUBLISH_SKILL, "SKILL.md"), "publish skill");
  write(join(codexHome, "skills", PUBLISH_SKILL, "scripts", "publish.mjs"), "// publish");
  write(join(codexHome, "skills", FETCH_SKILL, "SKILL.md"), "fetch skill");
  write(join(codexHome, "skill-support", "artifact-bff.mjs"), "// bff");
  write(join(codexHome, "skills", "my-own-skill", "SKILL.md"), "user skill");
  write(join(codexHome, "config.toml"), "model = 'x'");
  return { root, dataDir, project, bareProject, codexHome, retired };
}

describe("retireLegacySessionContext", () => {
  it("删数据目录 materials / observations 与项目内 .suduo/observations、.suduo/observed，其余不动", async () => {
    const { dataDir, project, bareProject, codexHome, retired } = layout();
    const logs: Array<Record<string, unknown>> = [];
    await retireLegacySessionContext({
      v2DataDirectory: dataDir,
      legacyMaterialPaths: [join(dataDir, "materials", "p1", "r1", "v3-1")],
      sessionIds: ["s1"],
      projectRoots: [project, bareProject, join(project, "missing")],
      codexHome,
      retiredSkillsRoot: retired,
      log: (line) => logs.push(line),
    });
    expect(existsSync(join(dataDir, "materials", "p1"))).toBe(false);
    expect(readFileSync(join(dataDir, "materials", "not-ours", "x.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(dataDir, "observations"))).toBe(false);
    expect(readFileSync(join(dataDir, "keep", "x.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(project, ".suduo", "observations"))).toBe(false);
    expect(existsSync(join(project, ".suduo", "observed"))).toBe(false);
    expect(readFileSync(join(project, ".suduo", "requirements", "REQ-1-t", "notes.md"), "utf8")).toBe("笔记");
    expect(readFileSync(join(project, ".suduo", ".gitignore"), "utf8")).toBe("*\n");
    expect(readFileSync(join(project, "src", "a.ts"), "utf8")).toBe("export {};");
    expect(readdirSync(bareProject)).toEqual([]);
    expect(logs.filter((line) => line["event"] === "suduo.legacy_context.removed")).toHaveLength(4);
  });

  it("CODEX_HOME 里的两个旧 skill 与 skill-support 被移动到 retiredSkillsRoot（内容还在），其他 skill 不动", async () => {
    const { dataDir, project, codexHome, retired } = layout();
    const logs: Array<Record<string, unknown>> = [];
    await retireLegacySessionContext({
      v2DataDirectory: dataDir,
      legacyMaterialPaths: [join(dataDir, "materials", "p1", "r1", "v3-1")],
      sessionIds: ["s1"],
      projectRoots: [project],
      codexHome,
      retiredSkillsRoot: retired,
      log: (line) => logs.push(line),
    });
    expect(existsSync(join(codexHome, "skills", PUBLISH_SKILL))).toBe(false);
    expect(existsSync(join(codexHome, "skills", FETCH_SKILL))).toBe(false);
    expect(existsSync(join(codexHome, "skill-support"))).toBe(false);
    expect(readFileSync(join(codexHome, "skills", "my-own-skill", "SKILL.md"), "utf8")).toBe("user skill");
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe("model = 'x'");

    // 一次运行放进同一个时间戳目录，结构与 CODEX_HOME 里一致，字节都在。
    const stamps = readdirSync(retired);
    expect(stamps).toHaveLength(1);
    const moved = join(retired, stamps[0]!);
    expect(readFileSync(join(moved, "skills", PUBLISH_SKILL, "SKILL.md"), "utf8")).toBe("publish skill");
    expect(readFileSync(join(moved, "skills", PUBLISH_SKILL, "scripts", "publish.mjs"), "utf8")).toBe("// publish");
    expect(readFileSync(join(moved, "skills", FETCH_SKILL, "SKILL.md"), "utf8")).toBe("fetch skill");
    expect(readFileSync(join(moved, "skill-support", "artifact-bff.mjs"), "utf8")).toBe("// bff");
    expect(existsSync(join(moved, "skills", "my-own-skill"))).toBe(false);
    expect(logs.filter((line) => line["event"] === "suduo.legacy_skill.retired")).toHaveLength(3);
  });

  it("目录都不存在 / 没有 CODEX_HOME 时不报错、不留痕；重复运行无事可做", async () => {
    const root = base();
    const logs: Array<Record<string, unknown>> = [];
    await expect(
      retireLegacySessionContext({
        v2DataDirectory: join(root, "no-data"),
        legacyMaterialPaths: [],
        sessionIds: [],
        projectRoots: [join(root, "no-project")],
        codexHome: join(root, "no-codex-home"),
        retiredSkillsRoot: join(root, "retired"),
        log: (line) => logs.push(line),
      }),
    ).resolves.toBeUndefined();
    await expect(
      retireLegacySessionContext({
        v2DataDirectory: join(root, "no-data"),
        legacyMaterialPaths: [],
        sessionIds: [],
        projectRoots: [],
        codexHome: undefined,
        retiredSkillsRoot: join(root, "retired"),
        log: (line) => logs.push(line),
      }),
    ).resolves.toBeUndefined();
    expect(logs).toEqual([]);
    expect(readdirSync(root)).toEqual([]);

    const { dataDir, project, codexHome, retired } = layout();
    const input = { v2DataDirectory: dataDir,
      legacyMaterialPaths: [join(dataDir, "materials", "p1", "r1", "v3-1")],
      sessionIds: ["s1"], projectRoots: [project], codexHome, retiredSkillsRoot: retired, log: () => undefined };
    await retireLegacySessionContext(input);
    const second: Array<Record<string, unknown>> = [];
    await retireLegacySessionContext({ ...input, log: (line) => second.push(line) });
    expect(second).toEqual([]);
    expect(readdirSync(retired)).toHaveLength(1);
  });

  it("移动失败时只记日志，源 skill 原地保留（不丢字节）", async () => {
    const { dataDir, project, codexHome, root } = layout();
    // retiredSkillsRoot 是个普通文件：复制必然失败。
    const blocker = join(root, "retired-is-a-file");
    writeFileSync(blocker, "not a directory");
    const logs: Array<Record<string, unknown>> = [];
    await retireLegacySessionContext({
      v2DataDirectory: dataDir,
      legacyMaterialPaths: [join(dataDir, "materials", "p1", "r1", "v3-1")],
      sessionIds: ["s1"],
      projectRoots: [project],
      codexHome,
      retiredSkillsRoot: blocker,
      log: (line) => logs.push(line),
    });
    expect(logs.filter((line) => line["event"] === "suduo.legacy_skill.retire_failed")).toHaveLength(3);
    expect(readFileSync(join(codexHome, "skills", PUBLISH_SKILL, "SKILL.md"), "utf8")).toBe("publish skill");
    expect(readFileSync(join(codexHome, "skill-support", "artifact-bff.mjs"), "utf8")).toBe("// bff");
  });
});
