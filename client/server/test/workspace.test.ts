import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "../src/application/workspace-service.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { WorkspaceWatcher } from "../src/infrastructure/workspace/workspace-watcher.js";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("T9 Workspace", () => {
  it("目录、预览、附件、skill 与 session baseline diff 完整工作", async () => {
    const root = temporaryDirectory();
    mkdirSync(resolve(root, "docs"));
    writeFileSync(resolve(root, "docs", "readme.md"), "# before\n");
    mkdirSync(resolve(root, ".codex", "skills", "gate"), { recursive: true });
    writeFileSync(
      resolve(root, ".codex", "skills", "gate", "SKILL.md"),
      "---\nname: gate-skill\ndescription: Gate skill\n---\n\nDo work.\n",
    );
    const context = createContext(root);
    try {
      const listed = await context.service.listDirectory(context.projectId, "");
      expect(listed.entries.map((entry) => entry.name)).toContain("docs");
      const preview = await context.service.readContent(
        context.projectId,
        "docs/readme.md",
      );
      expect(preview).toMatchObject({
        type: "text",
        mediaType: "text/markdown",
      });
      expect((await context.service.listSkills(context.projectId)).items).toEqual([
        expect.objectContaining({ name: "gate-skill" }),
      ]);

      await context.service.captureBaseline(context.sessionId);
      writeFileSync(resolve(root, "docs", "readme.md"), "# after\n");
      writeFileSync(resolve(root, "CREATED.txt"), "created\n");
      const changes = await context.service.listChanges(context.sessionId);
      expect(changes.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "CREATED.txt",
            kind: "created",
            additions: 1,
            deletions: 0,
          }),
          expect.objectContaining({
            path: "docs/readme.md",
            kind: "modified",
            additions: 1,
            deletions: 1,
          }),
        ]),
      );
      // 环境信息卡的「变更 +N −M」聚合。
      expect(changes.additions).toBe(2);
      expect(changes.deletions).toBe(1);
      expect(
        await context.service.diff(context.sessionId, "docs/readme.md"),
      ).toMatchObject({ before: "# before\n", after: "# after\n" });

      const attachment = await context.service.saveAttachment(context.projectId, {
        mediaType: "image/png",
        dataBase64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      });
      expect(attachment.relativePath).toContain(".suduo/attachments/");
      // SuDuo 写进项目的 .suduo/ 自带忽略全部内容的 .gitignore。
      expect(readFileSync(resolve(root, ".suduo", ".gitignore"), "utf8")).toContain("*");
      // 基线不再写进项目目录。
      expect(existsSync(resolve(root, ".suduo", "baselines"))).toBe(false);
      await expect(
        context.service.readContent(context.projectId, "../outside.txt"),
      ).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      context.database.close();
    }
  });

  it("快照与存量 baseline 都跳过 .ccb 等机器运行时目录", async () => {
    const root = temporaryDirectory();
    mkdirSync(resolve(root, ".ccb", "agents"), { recursive: true });
    writeFileSync(resolve(root, ".ccb", "agents", "state.json"), "{}\n");
    writeFileSync(resolve(root, "kept.txt"), "kept\n");
    const context = createContext(root);
    try {
      await context.service.captureBaseline(context.sessionId);
      // 基线清单在数据目录 <baselineRoot>/sessions/<会话>.json，不在项目目录里。
      const baselinePath = resolve(
        context.baselineRoot,
        "sessions",
        context.sessionId + ".json",
      );
      expect(existsSync(resolve(root, ".suduo", "baselines"))).toBe(false);
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
        files: Record<string, unknown>;
      };
      expect(Object.keys(baseline.files)).toEqual(["kept.txt"]);

      // 忽略清单扩容前写下的存量 baseline 仍带着 .ccb 路径，不得被报成「已删除」。
      baseline.files[".ccb/agents/state.json"] = {
        size: 3,
        mtimeMs: 0,
        sha256: "0".repeat(64),
        text: false,
      };
      writeFileSync(baselinePath, JSON.stringify(baseline));

      writeFileSync(resolve(root, ".ccb", "agents", "new.json"), "{}\n");
      writeFileSync(resolve(root, "kept.txt"), "changed\n");

      const changes = await context.service.listChanges(context.sessionId);
      expect(changes.items.map((item) => item.path)).toEqual(["kept.txt"]);
    } finally {
      context.database.close();
    }
  });

  it("watch 以 300ms debounce 聚合文件变化", async () => {
    const root = temporaryDirectory();
    const watcher = new WorkspaceWatcher();
    try {
      const notice = new Promise<{ paths: string[] }>((resolveNotice, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("timeout waiting for workspace notice")),
          5_000,
        );
        const unsubscribe = watcher.subscribe("project", root, (value) => {
          clearTimeout(timeout);
          unsubscribe();
          resolveNotice(value);
        });
      });
      writeFileSync(resolve(root, "watch.txt"), "one");
      writeFileSync(resolve(root, "watch.txt"), "two");
      expect((await notice).paths).toContain("watch.txt");
    } finally {
      watcher.close();
    }
  });

  it("watch 可强制使用轮询降级并保持 debounce", async () => {
    const root = temporaryDirectory();
    const watcher = new WorkspaceWatcher({
      forcePolling: true,
      pollIntervalMs: 50,
      debounceMs: 20,
    });
    try {
      const notice = new Promise<{ paths: string[]; mode: string }>(
        (resolveNotice, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("timeout waiting for polling notice")),
            2_000,
          );
          const unsubscribe = watcher.subscribe("poll-project", root, (value) => {
            clearTimeout(timeout);
            unsubscribe();
            resolveNotice(value);
          });
        },
      );
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
      writeFileSync(resolve(root, "polled.txt"), "changed");
      await expect(notice).resolves.toMatchObject({
        paths: ["polled.txt"],
        mode: "poll",
      });
    } finally {
      watcher.close();
    }
  });
});

function createContext(root: string) {
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const project = projects.create({
    name: "workspace",
    rootPath: root,
    rootPathKey: root,
  });
  const session = sessions.create({
    projectId: project.id,
    title: "workspace",
    state: "active",
  });
  const baselineRoot = temporaryDirectory();
  return {
    database,
    projectId: project.id,
    sessionId: session.id,
    baselineRoot,
    service: new WorkspaceService(
      projects,
      sessions,
      { roots: () => [] },
      undefined,
      { baselineRoot },
    ),
  };
}

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "suduo-workspace-"));
  temporaryPaths.push(path);
  return path;
}
