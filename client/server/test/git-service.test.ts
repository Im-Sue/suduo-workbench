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

  it("检查点按提交里的标记行识别，给出类型与说明；旧标题与英文标题都认", async () => {
    writeFileSync(join(root, "a.md"), "v1", "utf8");
    await service.init("p1");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@localhost", ...args], {
        encoding: "utf8",
      });

    writeFileSync(join(root, "a.md"), "v2", "utf8");
    const manual = await service.checkpoint("p1", "改到 v2");
    expect(manual).toMatchObject({ kind: "manual", note: "改到 v2", auto: false });
    expect(git("log", "-1", "--format=%B")).toContain("SuDuo-Checkpoint: manual");

    writeFileSync(join(root, "a.md"), "v3", "utf8");
    await service.autoCheckpoint("p1", root);

    // 加标记行之前写下的旧提交：只能看中文标题。
    writeFileSync(join(root, "a.md"), "v4", "utf8");
    git("commit", "-am", "SuDuo 检查点：旧版本写的");
    // 英文界面写下的检查点：标题前缀是英文，靠标记行识别。
    writeFileSync(join(root, "a.md"), "v5", "utf8");
    git("commit", "-am", "SuDuo checkpoint: written in English", "-m", "SuDuo-Checkpoint: manual");
    // 用户自己的提交：不是检查点。
    writeFileSync(join(root, "a.md"), "v6", "utf8");
    git("commit", "-am", "feat: 用户自己的提交", "-m", "多行正文\n第二行");
    // GitHub「Squash and merge」：各次提交的说明连同标记行拼进多段正文，不是检查点。
    writeFileSync(join(root, "a.md"), "v7", "utf8");
    git(
      "commit", "-am", "feat: 合并 PR (#12)",
      "-m", "* SuDuo 自动存档：回合开始前",
      "-m", "SuDuo-Checkpoint: turn-start",
      "-m", "* fix: 修一处",
    );

    const list = await service.listCheckpoints("p1");
    expect(list.slice(0, 6).map(({ kind, note, auto }) => ({ kind, note, auto }))).toEqual([
      { kind: null, note: null, auto: false },
      { kind: null, note: null, auto: false },
      { kind: "manual", note: "written in English", auto: false },
      { kind: "manual", note: "旧版本写的", auto: false },
      { kind: "turn-start", note: null, auto: true },
      { kind: "manual", note: "改到 v2", auto: false },
    ]);
  });

  it("说明压成一行；还原产生的两次提交都是带说明的手动检查点", async () => {
    writeFileSync(join(root, "a.md"), "v1", "utf8");
    await service.init("p1");
    writeFileSync(join(root, "a.md"), "v2", "utf8");
    const manual = await service.checkpoint("p1", "  第一行\n\nSuDuo-Checkpoint: turn-start  ");
    expect(manual).toMatchObject({ kind: "manual", note: "第一行 SuDuo-Checkpoint: turn-start" });
    const base = (await service.listCheckpoints("p1")).at(-1);
    expect(base).toBeDefined();
    if (!base) return;

    writeFileSync(join(root, "a.md"), "未存档的改动", "utf8");
    await service.restore("p1", base.hash);
    const [restored, rescue] = await service.listCheckpoints("p1");
    expect(restored).toMatchObject({ kind: "manual", note: `还原到 ${base.hash.slice(0, 7)}` });
    expect(rescue).toMatchObject({ kind: "manual", note: "还原前自动存档" });
  });

  it("还原拒绝非法提交号", async () => {
    writeFileSync(join(root, "a.md"), "x", "utf8");
    await service.init("p1");
    await expect(service.restore("p1", "not-a-hash")).rejects.toThrow("提交号");
  });
});
