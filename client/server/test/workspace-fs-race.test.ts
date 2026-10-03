import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";

/**
 * 目录遍历期间文件消失的竞态。
 *
 * 实测触发：服务运行期间重新构建前端，`dist/assets` 下的旧 chunk 在
 * `readdir` 列出之后、`readFile` 读取之前被删除，导致 `listChanges` 整个失败并返回 500
 * （日志：`ENOENT: open '.../dist/assets/liquid-Dy6ZLDiz.js' at snapshotProject`；
 * 现为增量遍历 `scanProject`，口径不变）。
 *
 * 这里用 mock 精确制造那一刻——真实竞态无法稳定复现，而它恰恰是必须被覆盖的路径。
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    readFile: async (path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      const text = String(path);
      if (text.endsWith("vanishing.txt")) {
        const error = new Error("ENOENT: file vanished") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      if (text.endsWith("exploding.txt")) {
        // 非文件系统错误：必须照常抛出，不能被一起吞掉。
        throw new Error("unexpected boom");
      }
      return actual.readFile(path, ...(rest as []));
    },
  };
});

const { WorkspaceService, isTransientFsError } = await import(
  "../src/application/workspace-service.js"
);
const { openBetterSqlite3Database } = await import(
  "../src/infrastructure/db/better-sqlite3-database.js"
);
const { runMigrations } = await import("../src/infrastructure/db/migration-runner.js");
const { ProjectRepository } = await import(
  "../src/infrastructure/db/repositories/project-repository.js"
);
const { SessionRepository } = await import(
  "../src/infrastructure/db/repositories/session-repository.js"
);

const temporaryPaths: string[] = [];
afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("遍历期间文件消失", () => {
  it("只跳过消失的文件，不让整个 listChanges 失败", async () => {
    const root = temporaryDirectory();
    mkdirSync(resolve(root, "dist"), { recursive: true });
    writeFileSync(resolve(root, "dist", "stable.txt"), "keep\n");
    writeFileSync(resolve(root, "dist", "vanishing.txt"), "gone\n");
    const context = createContext(root);

    await context.service.captureBaseline(context.sessionId);
    writeFileSync(resolve(root, "dist", "stable.txt"), "changed\n");

    const changes = await context.service.listChanges(context.sessionId);
    const paths = changes.items.map((item) => item.path);
    expect(paths).toContain("dist/stable.txt");
    expect(paths).not.toContain("dist/vanishing.txt");
  });

  it("非文件系统错误照常抛出——不能借修竞态吞掉编程错误", async () => {
    const root = temporaryDirectory();
    writeFileSync(resolve(root, "exploding.txt"), "boom\n");
    const context = createContext(root);
    await expect(context.service.captureBaseline(context.sessionId)).rejects.toThrow(
      "unexpected boom",
    );
  });
});

describe("瞬态文件系统错误判定", () => {
  it("认得需要跳过的错误码", () => {
    for (const code of ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM", "EBUSY"]) {
      const error = new Error(code) as NodeJS.ErrnoException;
      error.code = code;
      expect(isTransientFsError(error)).toBe(true);
    }
  });

  it("不把其他错误当成瞬态", () => {
    expect(isTransientFsError(new Error("plain"))).toBe(false);
    expect(isTransientFsError(null)).toBe(false);
    expect(isTransientFsError("ENOENT")).toBe(false);
    const wrongCode = new Error("x") as NodeJS.ErrnoException;
    wrongCode.code = "EMFILE";
    expect(isTransientFsError(wrongCode)).toBe(false);
  });
});

function createContext(root: string) {
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const project = projects.create({ name: "race", rootPath: root, rootPathKey: root });
  const session = sessions.create({
    projectId: project.id,
    title: "race",
    state: "active",
  });
  return {
    sessionId: session.id,
    service: new WorkspaceService(projects, sessions, { roots: () => [] }, undefined, {
      baselineRoot: temporaryDirectory(),
    }),
  };
}

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "suduo-fs-race-"));
  temporaryPaths.push(path);
  return path;
}
