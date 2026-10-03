import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";
import { WorkspaceService } from "../src/application/workspace-service.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { BaselineStore } from "../src/infrastructure/workspace/baseline-store.js";

/**
 * 记录每一次 readFile 的路径，用来断言「增量刷新只重读变化的文件」。
 * 只包一层计数，行为与真实 readFile 完全一致。
 */
const readLog = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    readFile: async (path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      readLog.paths.push(String(path));
      return actual.readFile(path, ...(rest as []));
    },
  };
});

const temporaryPaths: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("BaselineStore", () => {
  it("按内容去重：同内容只存一份 blob，已存在不重写；文件 0600、目录 0700", async () => {
    const root = temporaryDirectory("suduo-baseline-root-");
    const store = new BaselineStore(root);
    const same = sha256("same\n");
    await store.save("s1", {
      capturedAt: 1,
      files: {
        "a.txt": { size: 5, mtimeMs: 10, sha256: same, text: true },
        "b.txt": { size: 5, mtimeMs: 11, sha256: same, text: true },
      },
      texts: new Map([[same, "same\n"]]),
    });
    const blobPath = resolve(root, "blobs", same);
    const firstWrite = statSync(blobPath).mtimeMs;
    await store.save("s2", {
      capturedAt: 2,
      files: { "a.txt": { size: 5, mtimeMs: 10, sha256: same, text: true } },
      texts: new Map([[same, "same\n"]]),
    });
    expect(readdirSync(resolve(root, "blobs"))).toEqual([same]);
    expect(statSync(blobPath).mtimeMs).toBe(firstWrite);
    expect(await store.readText(same)).toBe("same\n");
    expect((await store.load("s1"))?.files["b.txt"]).toEqual({
      size: 5,
      mtimeMs: 11,
      sha256: same,
      text: true,
    });
    expect(await store.load("missing")).toBeNull();
    expect(await store.readText("0".repeat(64))).toBeNull();
    expect(await store.readText("../escape")).toBeNull();
    if (process.platform !== "win32") {
      expect(statSync(blobPath).mode & 0o777).toBe(0o600);
      expect(statSync(resolve(root, "sessions", "s1.json")).mode & 0o777).toBe(0o600);
      expect(statSync(resolve(root, "blobs")).mode & 0o777).toBe(0o700);
      expect(statSync(resolve(root, "sessions")).mode & 0o777).toBe(0o700);
    }
  });

  it("text 条目没给全文且 blob 不存在时降级为无副本", async () => {
    const store = new BaselineStore(temporaryDirectory("suduo-baseline-root-"));
    const hash = sha256("lost\n");
    const manifest = await store.save("s1", {
      capturedAt: 1,
      files: { "lost.txt": { size: 5, mtimeMs: 1, sha256: hash, text: true } },
      texts: new Map(),
    });
    expect(manifest.files["lost.txt"]?.text).toBe(false);
  });

  it("collectGarbage 只删无人引用的 blob，并等进行中的 save 写完清单", async () => {
    const root = temporaryDirectory("suduo-baseline-root-");
    const store = new BaselineStore(root);
    const kept = sha256("kept\n");
    const dropped = sha256("dropped\n");
    await store.save("keep", {
      capturedAt: 1,
      files: { "k.txt": { size: 5, mtimeMs: 1, sha256: kept, text: true } },
      texts: new Map([[kept, "kept\n"]]),
    });
    await store.save("drop", {
      capturedAt: 1,
      files: { "d.txt": { size: 8, mtimeMs: 1, sha256: dropped, text: true } },
      texts: new Map([[dropped, "dropped\n"]]),
    });
    await store.remove("drop");
    // 崩溃遗留的临时文件一并清掉。
    writeFileSync(resolve(root, "blobs", kept + ".1.x.tmp"), "partial");

    const racing = sha256("racing\n");
    const pendingSave = store.save("racing", {
      capturedAt: 1,
      files: { "r.txt": { size: 7, mtimeMs: 1, sha256: racing, text: true } },
      texts: new Map([[racing, "racing\n"]]),
    });
    const removed = await store.collectGarbage();
    await pendingSave;

    expect(removed).toBe(1);
    expect(readdirSync(resolve(root, "blobs")).sort()).toEqual([kept, racing].sort());
    expect(await store.readText(racing)).toBe("racing\n");
    expect((await store.sessionIds()).sort()).toEqual(["keep", "racing"]);
  });
});

describe("WorkspaceService 基线（数据目录 + 增量刷新）", () => {
  it("两个会话同内容只存一份 blob，且不往项目目录写基线", async () => {
    const context = createContext();
    writeFileSync(resolve(context.root, "a.txt"), "same\n");
    writeFileSync(resolve(context.root, "b.md"), "same\n");
    writeFileSync(resolve(context.root, "c.md"), "other\n");
    const second = context.newSession();

    await context.service.captureBaseline(context.sessionId);
    await context.service.captureBaseline(second);

    expect(readdirSync(resolve(context.baselineRoot, "blobs")).sort()).toEqual(
      [sha256("same\n"), sha256("other\n")].sort(),
    );
    expect(readdirSync(resolve(context.baselineRoot, "sessions")).sort()).toEqual(
      [context.sessionId + ".json", second + ".json"].sort(),
    );
    expect(existsSync(resolve(context.root, ".suduo"))).toBe(false);
  });

  it("增量刷新只重读大小或 mtime 变了的文件；diff 只读目标文件", async () => {
    const context = createContext();
    const past = new Date(Date.now() - 60_000);
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      writeFileSync(resolve(context.root, name), name + " line\n");
      utimesSync(resolve(context.root, name), past, past);
    }
    await context.service.captureBaseline(context.sessionId);

    writeFileSync(resolve(context.root, "b.txt"), "b.txt line\nadded\n");
    const later = new Date(Date.now() - 30_000);
    utimesSync(resolve(context.root, "b.txt"), later, later);

    readLog.paths.length = 0;
    const first = await context.service.listChanges(context.sessionId);
    expect(first.items).toEqual([
      expect.objectContaining({
        path: "b.txt",
        kind: "modified",
        additions: 1,
        deletions: 0,
      }),
    ]);
    expect(projectReads(context.root)).toEqual(["b.txt"]);

    // 没有任何变化：不读任何项目文件（哈希沿用缓存，行级增删沿用记忆）。
    readLog.paths.length = 0;
    const second = await context.service.listChanges(context.sessionId);
    expect(second).toEqual(first);
    expect(projectReads(context.root)).toEqual([]);

    readLog.paths.length = 0;
    expect(await context.service.diff(context.sessionId, "b.txt")).toMatchObject({
      kind: "modified",
      before: "b.txt line\n",
      after: "b.txt line\nadded\n",
      truncated: false,
    });
    expect(projectReads(context.root)).toEqual(["b.txt"]);
  });

  it("mtime 离检查时刻太近的文件不信任缓存，照样重读", async () => {
    const context = createContext();
    writeFileSync(resolve(context.root, "fresh.txt"), "one\n");
    await context.service.captureBaseline(context.sessionId);
    readLog.paths.length = 0;
    await context.service.listChanges(context.sessionId);
    expect(projectReads(context.root)).toEqual(["fresh.txt"]);
  });

  it("建会话后的后台拍摄未完成时 /changes 等它，不重复拍", async () => {
    const context = createContext();
    const past = new Date(Date.now() - 60_000);
    writeFileSync(resolve(context.root, "only.txt"), "only\n");
    utimesSync(resolve(context.root, "only.txt"), past, past);

    readLog.paths.length = 0;
    const background = context.service.captureBaselineInBackground(context.sessionId);
    const changes = await context.service.listChanges(context.sessionId);
    await background;

    expect(changes.items).toEqual([]);
    expect(projectReads(context.root)).toEqual(["only.txt"]);
  });

  it("后台拍摄失败不抛错，只记一行日志", async () => {
    const context = createContext();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      context.service.captureBaselineInBackground("no-such-session"),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      event: "workspace.baseline_capture_failed",
      sessionId: "no-such-session",
    });
  });

  it("旧位置 .suduo/baselines/<会话>.json 首次访问时导入新存储并删除", async () => {
    const context = createContext();
    writeFileSync(resolve(context.root, "keep.txt"), "keep\n");
    writeFileSync(resolve(context.root, "doc.md"), "new\n");
    const legacyDirectory = resolve(context.root, ".suduo", "baselines");
    mkdirSync(legacyDirectory, { recursive: true });
    const legacyPath = resolve(legacyDirectory, context.sessionId + ".json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        sessionId: context.sessionId,
        createdAt: 123,
        files: {
          "keep.txt": { hash: sha256("keep\n"), size: 5, text: "keep\n" },
          "doc.md": { hash: sha256("old\n"), size: 4, text: "old\n" },
          // 忽略清单扩容前的存量条目：导入时剔除，不报成「已删除」。
          ".ccb/state.json": { hash: sha256("{}"), size: 2, text: "{}" },
        },
      }),
    );

    const changes = await context.service.listChanges(context.sessionId);
    expect(changes.items).toEqual([
      expect.objectContaining({
        path: "doc.md",
        kind: "modified",
        additions: 1,
        deletions: 1,
      }),
    ]);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(legacyDirectory)).toBe(false);
    const manifest = JSON.parse(
      readFileSync(
        resolve(context.baselineRoot, "sessions", context.sessionId + ".json"),
        "utf8",
      ),
    ) as { capturedAt: number; files: Record<string, { mtimeMs: number }> };
    expect(manifest.capturedAt).toBe(123);
    expect(Object.keys(manifest.files).sort()).toEqual(["doc.md", "keep.txt"]);
    expect(manifest.files["doc.md"]?.mtimeMs).toBe(-1);
    expect(await context.service.diff(context.sessionId, "doc.md")).toMatchObject({
      before: "old\n",
      after: "new\n",
    });
  });

  it("旧基线损坏时按缺失补拍；旧目录里还有别的会话时保留目录", async () => {
    const context = createContext();
    writeFileSync(resolve(context.root, "a.txt"), "a\n");
    const legacyDirectory = resolve(context.root, ".suduo", "baselines");
    mkdirSync(legacyDirectory, { recursive: true });
    const legacyPath = resolve(legacyDirectory, context.sessionId + ".json");
    writeFileSync(legacyPath, "{ not json");
    writeFileSync(resolve(legacyDirectory, "other-session.json"), "{}");

    const changes = await context.service.listChanges(context.sessionId);
    expect(changes.items).toEqual([]);
    expect(existsSync(legacyPath)).toBe(false);
    expect(readdirSync(legacyDirectory)).toEqual(["other-session.json"]);
    expect(
      existsSync(resolve(context.baselineRoot, "sessions", context.sessionId + ".json")),
    ).toBe(true);
  });

  it("forgetSessionBaseline 删清单；collectBaselineGarbage 回收无人引用的 blob 与孤儿清单", async () => {
    const context = createContext();
    writeFileSync(resolve(context.root, "shared.txt"), "shared\n");
    writeFileSync(resolve(context.root, "a.txt"), "v1\n");
    await context.service.captureBaseline(context.sessionId);
    writeFileSync(resolve(context.root, "a.txt"), "v2\n");
    const second = context.newSession();
    await context.service.captureBaseline(second);
    const blobs = () => readdirSync(resolve(context.baselineRoot, "blobs")).sort();
    expect(blobs()).toEqual(
      [sha256("shared\n"), sha256("v1\n"), sha256("v2\n")].sort(),
    );

    await context.service.forgetSessionBaseline(context.sessionId);
    expect(
      existsSync(resolve(context.baselineRoot, "sessions", context.sessionId + ".json")),
    ).toBe(false);
    expect(await context.service.collectBaselineGarbage()).toBe(1);
    expect(blobs()).toEqual([sha256("shared\n"), sha256("v2\n")].sort());
    // 留下的会话照常可用。
    expect((await context.service.listChanges(second)).items).toEqual([]);

    // 数据库里已不存在的会话、已删除的会话：清单与只被它们引用的 blob 都回收。
    const store = new BaselineStore(context.baselineRoot);
    const ghost = sha256("ghost\n");
    await store.save("ghost-session", {
      capturedAt: 1,
      files: { "g.txt": { size: 6, mtimeMs: 1, sha256: ghost, text: true } },
      texts: new Map([[ghost, "ghost\n"]]),
    });
    const record = context.sessions.getById(second);
    expect(record).not.toBeNull();
    context.sessions.updateState(second, record?.version ?? 0, "deleted");
    expect(await context.service.collectBaselineGarbage()).toBe(3);
    expect(blobs()).toEqual([]);
    expect(readdirSync(resolve(context.baselineRoot, "sessions"))).toEqual([]);
  });
});

function createContext() {
  const root = temporaryDirectory("suduo-baseline-project-");
  const baselineRoot = temporaryDirectory("suduo-baseline-data-");
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const project = projects.create({
    name: "baseline",
    rootPath: root,
    rootPathKey: root,
  });
  const newSession = () =>
    sessions.create({ projectId: project.id, title: "baseline", state: "active" }).id;
  return {
    root,
    baselineRoot,
    sessions,
    sessionId: newSession(),
    newSession,
    service: new WorkspaceService(
      projects,
      sessions,
      { roots: () => [] },
      undefined,
      { baselineRoot },
    ),
  };
}

/** 本轮读过的项目内文件（按文件名）；基线 blob 在数据目录，不计入。 */
function projectReads(root: string): string[] {
  const marker = basename(root);
  return readLog.paths
    .filter((path) => path.includes(marker))
    .map((path) => basename(path))
    .sort();
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}
