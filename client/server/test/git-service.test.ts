import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitService, parseStatusHeader } from "../src/application/git-service.js";
import type { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("parseStatusHeader（status --porcelain --branch 首行解析）", () => {
  it("带上游分支", () => {
    expect(parseStatusHeader("main...origin/main [ahead 1]")).toEqual({
      branch: "main",
      hasUpstream: true,
    });
  });
  it("本地分支无上游", () => {
    expect(parseStatusHeader("master")).toEqual({
      branch: "master",
      hasUpstream: false,
    });
  });
  it("空仓库尚无提交", () => {
    expect(parseStatusHeader("No commits yet on main")).toEqual({
      branch: "main",
      hasUpstream: false,
    });
  });
  it("分离 HEAD", () => {
    expect(parseStatusHeader("HEAD (no branch)")).toEqual({
      branch: "HEAD",
      hasUpstream: false,
    });
  });
});

describe.skipIf(!gitAvailable)("GitService（真实 git 往返）", () => {
  let root: string;
  let service: GitService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "suduo-git-"));
    const projects = {
      getById: (id: string) =>
        id === "p1"
          ? {
              id: "p1",
              name: "测试项目",
              rootPath: root,
              state: "active" as const,
              createdAt: 0,
              updatedAt: 0,
              lastOpenedAt: null,
              version: 1,
            }
          : null,
    } as unknown as ProjectRepository;
    service = new GitService(projects);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("非仓库 → 初始化 → 检查点 → 还原 全链路", async () => {
    const initial = await service.status("p1");
    expect(initial.available).toBe(true);
    expect(initial.repo).toBe(false);

    writeFileSync(join(root, "需求.md"), "v1", "utf8");
    const inited = await service.init("p1");
    expect(inited.repo).toBe(true);
    expect(inited.managed).toBe(true);
    expect(inited.autoCheckpoint).toBe(true);
    expect(existsSync(join(root, ".gitignore"))).toBe(true);

    // 修改文件 → 手动检查点
    writeFileSync(join(root, "需求.md"), "v2", "utf8");
    const checkpoint = await service.checkpoint("p1", "改到 v2");
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.subject).toContain("改到 v2");

    // 无改动时不产生空提交
    expect(await service.checkpoint("p1", undefined)).toBeNull();

    // 再改 → 自动存档路径
    writeFileSync(join(root, "需求.md"), "v3", "utf8");
    await service.autoCheckpoint("p1", root);
    const list = await service.listCheckpoints("p1");
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list[0]?.auto).toBe(true);

    // 还原到 v2 检查点
    const target = list.find((item) => item.subject.includes("改到 v2"));
    expect(target).toBeDefined();
    if (!target) {
      return;
    }
    const restored = await service.restore("p1", target.hash);
    expect(restored.repo).toBe(true);
    expect(readFileSync(join(root, "需求.md"), "utf8")).toBe("v2");
  });

  it("还原前先自动存档：未提交改动可被找回（还原可反悔）", async () => {
    writeFileSync(join(root, "需求.md"), "v1", "utf8");
    await service.init("p1");
    const base = await service.listCheckpoints("p1");
    const target = base[0];
    expect(target).toBeDefined();
    if (!target) {
      return;
    }

    // 未提交的改动：直接 reset --hard 会永久丢失。
    writeFileSync(join(root, "需求.md"), "还没存档就要还原的内容", "utf8");
    await service.restore("p1", target.hash);
    expect(readFileSync(join(root, "需求.md"), "utf8")).toBe("v1");

    // 还原前的状态被存进了检查点，可以再还原回去。
    const after = await service.listCheckpoints("p1");
    const rescue = after.find((item) => item.subject.includes("还原前自动存档"));
    expect(rescue).toBeDefined();
    if (!rescue) {
      return;
    }
    await service.restore("p1", rescue.hash);
    expect(readFileSync(join(root, "需求.md"), "utf8")).toBe(
      "还没存档就要还原的内容",
    );
  });

  it("autoCheckpoint 在开关关闭或非仓库时静默跳过", async () => {
    await service.autoCheckpoint("p1", root);
    const status = await service.status("p1");
    expect(status.repo).toBe(false);
    expect(status.lastError).toBeNull();
  });

  it("还原拒绝非法提交号", async () => {
    writeFileSync(join(root, "a.md"), "x", "utf8");
    await service.init("p1");
    await expect(service.restore("p1", "not-a-hash")).rejects.toThrow("提交号");
  });
});
