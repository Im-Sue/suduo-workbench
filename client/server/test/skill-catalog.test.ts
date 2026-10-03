import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeSkill } from "@suduo/client-contracts";
import { WorkspaceService } from "../src/application/workspace-service.js";
import type { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import type { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";

/**
 * 回归：skills 列表必须以 runtime（codex）注册表为真相源。
 * 曾因自扫目录 → UI 能选但 codex 不认识 → 消息里的 skill 引用被静默忽略。
 */
describe("WorkspaceService.listSkills 真相源", () => {
  let root: string;
  let baselineRoot: string;
  let projects: ProjectRepository;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "suduo-skills-"));
    baselineRoot = mkdtempSync(join(tmpdir(), "suduo-skills-baselines-"));
    // 磁盘上存在一个 skill：仅当回落磁盘扫描时才会出现。
    mkdirSync(join(root, ".codex", "skills", "disk-only"), { recursive: true });
    writeFileSync(
      join(root, ".codex", "skills", "disk-only", "SKILL.md"),
      "---\nname: disk-only\ndescription: 只在磁盘上\n---\n",
      "utf8",
    );
    projects = {
      getById: (id: string) =>
        id === "p1"
          ? {
              id: "p1",
              name: "p",
              rootPath: root,
              state: "active" as const,
              createdAt: 0,
              updatedAt: 0,
              lastOpenedAt: null,
              version: 1,
            }
          : null,
    } as unknown as ProjectRepository;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(baselineRoot, { recursive: true, force: true });
  });

  const sessions = { getById: () => null } as unknown as SessionRepository;

  it("runtime 可用时以其注册表为准，并过滤 disabled", async () => {
    const catalog: RuntimeSkill[] = [
      {
        name: "demo-req",
        description: "需求包",
        path: "/home/u/.codex/skills/demo-req/SKILL.md",
        scope: "user",
        enabled: true,
      },
      {
        name: "off",
        description: "停用的",
        path: "/home/u/.codex/skills/off/SKILL.md",
        scope: "user",
        enabled: false,
      },
    ];
    const service = new WorkspaceService(
      projects,
      sessions,
      { roots: () => [] },
      async () => catalog,
      { baselineRoot },
    );
    const listed = await service.listSkills("p1");
    expect(listed.items.map((skill) => skill.name)).toEqual(["demo-req"]);
    // 磁盘上的 disk-only 不在 runtime 注册表里 → 不得出现（否则选了也不生效）。
    expect(listed.items.some((skill) => skill.name === "disk-only")).toBe(false);
  });

  it("runtime 不可用时回落磁盘扫描，不至于空列表", async () => {
    const service = new WorkspaceService(
      projects,
      sessions,
      { roots: () => [] },
      async () => null,
      { baselineRoot },
    );
    const listed = await service.listSkills("p1");
    expect(listed.items.map((skill) => skill.name)).toEqual(["disk-only"]);
  });
});
