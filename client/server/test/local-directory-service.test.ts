import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_DIRECTORY_ENTRY_LIMIT } from "@suduo/client-contracts";
import { ApiError } from "../src/application/api-error.js";
import {
  LocalDirectoryService,
  mappedWorkspaceRoots,
} from "../src/application/local-directory-service.js";

const temporaryPaths: string[] = [];
const restorePermissions: string[] = [];
const fifos: string[] = [];
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

afterEach(() => {
  // 若有读者卡在 FIFO 上（回归时），以非阻塞方式打开写端再关闭，让它读到 EOF 释放线程。
  for (const path of fifos.splice(0)) {
    try {
      closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {
      // 没有读者时打开写端会报 ENXIO，忽略。
    }
  }
  for (const path of restorePermissions.splice(0)) {
    chmodSync(path, 0o755);
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("本机目录浏览", () => {
  it("只列目录、默认隐藏点目录、按名称排序，并标出 Git 仓库与读写权限", async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "b-repo", ".git"), { recursive: true });
    writeFileSync(join(root, "b-repo", ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(root, "A-plain"));
    mkdirSync(join(root, "dir10"));
    mkdirSync(join(root, "dir2"));
    mkdirSync(join(root, ".cache"));
    writeFileSync(join(root, "readme.md"), "file");
    symlinkSync(join(root, "A-plain"), join(root, "linked-dir"));
    symlinkSync(join(root, "readme.md"), join(root, "linked-file"));
    symlinkSync(join(root, "missing-target"), join(root, "broken-link"));
    const service = new LocalDirectoryService({ recentRoots: () => ["/r1", "/r2", "/r1"] });

    const listing = await service.list({ path: root, hidden: false });
    const realRoot = realpathSync(root);
    expect(listing.path).toBe(realRoot);
    expect(listing.parent).toBe(realpathSync(join(root, "..")));
    expect(listing.truncated).toBe(false);
    expect(listing.recent).toEqual(["/r1", "/r2"]);
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      "A-plain",
      "b-repo",
      "dir2",
      "dir10",
      "linked-dir",
    ]);
    expect(listing.entries.find((entry) => entry.name === "b-repo")).toEqual({
      name: "b-repo",
      path: join(realRoot, "b-repo"),
      isGitRepo: true,
      readable: true,
      writable: true,
    });
    expect(listing.entries.find((entry) => entry.name === "A-plain")?.isGitRepo).toBe(false);

    const withHidden = await service.list({ path: root, hidden: true });
    expect(withHidden.entries.map((entry) => entry.name)).toContain(".cache");
  });

  it("缺省列用户主目录；根目录的 parent 为 null", async () => {
    const home = temporaryRoot();
    mkdirSync(join(home, "projects"));
    const service = new LocalDirectoryService({
      recentRoots: () => [],
      homeDirectory: () => home,
    });
    const listing = await service.list({ hidden: false });
    expect(listing.path).toBe(realpathSync(home));
    expect(listing.home).toBe(realpathSync(home));
    expect(listing.entries.map((entry) => entry.name)).toEqual(["projects"]);

    const rootListing = await service.list({ path: "/", hidden: false });
    expect(rootListing.path).toBe("/");
    expect(rootListing.parent).toBeNull();
  });

  it(`超过 ${String(LOCAL_DIRECTORY_ENTRY_LIMIT)} 个子目录时截断并标记`, async () => {
    const root = temporaryRoot();
    for (let index = 0; index <= LOCAL_DIRECTORY_ENTRY_LIMIT; index += 1) {
      mkdirSync(join(root, `d${String(index).padStart(4, "0")}`));
    }
    const listing = await new LocalDirectoryService({ recentRoots: () => [] })
      .list({ path: root, hidden: false });
    expect(listing.entries).toHaveLength(LOCAL_DIRECTORY_ENTRY_LIMIT);
    expect(listing.truncated).toBe(true);
    expect(listing.entries.at(-1)?.name).toBe("d0499");
  });

  it("非绝对路径、不存在、不是目录分别给出明确错误码", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "file.txt"), "x");
    const service = new LocalDirectoryService({ recentRoots: () => [] });
    await expect(service.list({ path: "relative/dir", hidden: false }))
      .rejects.toMatchObject({ statusCode: 400, code: "LOCAL_PATH_INVALID" });
    await expect(service.list({ path: "", hidden: false }))
      .rejects.toMatchObject({ statusCode: 400, code: "LOCAL_PATH_INVALID" });
    await expect(service.list({ path: join(root, "missing"), hidden: false }))
      .rejects.toMatchObject({ statusCode: 404, code: "LOCAL_PATH_NOT_FOUND" });
    await expect(service.list({ path: join(root, "file.txt", "child"), hidden: false }))
      .rejects.toMatchObject({ statusCode: 404, code: "LOCAL_PATH_NOT_FOUND" });
    await expect(service.list({ path: join(root, "file.txt"), hidden: false }))
      .rejects.toMatchObject({ statusCode: 400, code: "LOCAL_PATH_NOT_DIRECTORY" });
  });

  it.skipIf(runningAsRoot)("无权限目录：列表标记不可读写，进入与探查返回 PERMISSION_DENIED", async () => {
    const root = temporaryRoot();
    const locked = join(root, "locked");
    mkdirSync(join(locked, "inner"), { recursive: true });
    chmodSync(locked, 0o000);
    restorePermissions.push(locked);
    const service = new LocalDirectoryService({ recentRoots: () => [] });

    const listing = await service.list({ path: root, hidden: false });
    expect(listing.entries).toEqual([
      expect.objectContaining({ name: "locked", readable: false, writable: false, isGitRepo: false }),
    ]);
    const denied = await service.list({ path: locked, hidden: false }).catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(ApiError);
    expect(denied).toMatchObject({ statusCode: 403, code: "LOCAL_PATH_PERMISSION_DENIED" });
    await expect(service.inspect({ path: join(locked, "inner") }))
      .rejects.toMatchObject({ statusCode: 403, code: "LOCAL_PATH_PERMISSION_DENIED" });
    await expect(service.inspect({ path: locked })).resolves.toMatchObject({
      exists: true,
      isDirectory: true,
      readable: false,
      writable: false,
      isGitRepo: false,
      branch: null,
    });
  });
});

describe("路径即时校验", () => {
  it("不存在、文件、目录、Git 仓库（含 worktree 指针与分离 HEAD）", async () => {
    const root = temporaryRoot();
    const realRoot = realpathSync(root);
    const service = new LocalDirectoryService({ recentRoots: () => [] });

    await expect(service.inspect({ path: join(root, "missing", "..", "nope") })).resolves.toEqual({
      path: join(root, "nope"),
      exists: false,
      isDirectory: false,
      readable: false,
      writable: false,
      isGitRepo: false,
      branch: null,
    });

    writeFileSync(join(root, "file.txt"), "x");
    await expect(service.inspect({ path: join(root, "file.txt") })).resolves.toMatchObject({
      path: join(realRoot, "file.txt"),
      exists: true,
      isDirectory: false,
      isGitRepo: false,
      branch: null,
    });

    mkdirSync(join(root, "plain"));
    await expect(service.inspect({ path: join(root, "plain") })).resolves.toEqual({
      path: join(realRoot, "plain"),
      exists: true,
      isDirectory: true,
      readable: true,
      writable: true,
      isGitRepo: false,
      branch: null,
    });

    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    writeFileSync(join(root, "repo", ".git", "HEAD"), "ref: refs/heads/feature/login\n");
    await expect(service.inspect({ path: join(root, "repo") })).resolves.toMatchObject({
      isGitRepo: true,
      branch: "feature/login",
    });

    mkdirSync(join(root, "worktree-meta"));
    writeFileSync(join(root, "worktree-meta", "HEAD"), "ref: refs/heads/wt-branch\n");
    mkdirSync(join(root, "worktree"));
    writeFileSync(join(root, "worktree", ".git"), "gitdir: ../worktree-meta\n");
    await expect(service.inspect({ path: join(root, "worktree") })).resolves.toMatchObject({
      isGitRepo: true,
      branch: "wt-branch",
    });

    mkdirSync(join(root, "detached", ".git"), { recursive: true });
    writeFileSync(join(root, "detached", ".git", "HEAD"), `${"a".repeat(40)}\n`);
    await expect(service.inspect({ path: join(root, "detached") })).resolves.toMatchObject({
      isGitRepo: true,
      branch: null,
    });

    await expect(service.inspect({ path: "relative" }))
      .rejects.toMatchObject({ statusCode: 400, code: "LOCAL_PATH_INVALID" });
  });
});

describe("读取 HEAD 不被特殊文件拖住", () => {
  it.skipIf(process.platform === "win32")(
    "HEAD 为 FIFO、超大文件、指向设备的链接时快速返回 branch: null，线程池不被占满",
    async () => {
      const root = temporaryRoot();
      const fifoRepo = join(root, "fifo-repo");
      mkdirSync(join(fifoRepo, ".git"), { recursive: true });
      const fifo = join(fifoRepo, ".git", "HEAD");
      execFileSync("mkfifo", [fifo]);
      fifos.push(fifo);
      const bigRepo = join(root, "big-repo");
      mkdirSync(join(bigRepo, ".git"), { recursive: true });
      writeFileSync(
        join(bigRepo, ".git", "HEAD"),
        `ref: refs/heads/main\n${"x".repeat(8 * 1024)}`,
      );
      const deviceRepo = join(root, "device-repo");
      mkdirSync(join(deviceRepo, ".git"), { recursive: true });
      symlinkSync("/dev/zero", join(deviceRepo, ".git", "HEAD"));
      const worktreeRepo = join(root, "worktree-to-fifo");
      mkdirSync(worktreeRepo);
      writeFileSync(join(worktreeRepo, ".git"), `gitdir: ${join(fifoRepo, ".git")}\n`);
      const service = new LocalDirectoryService({ recentRoots: () => [] });

      // 线程池默认 4 个线程；阻塞式读取 FIFO 时 8 次并发足以把它占满。
      const results = await withinTimeout(Promise.all([
        ...Array.from({ length: 8 }, () => service.inspect({ path: fifoRepo })),
        service.inspect({ path: worktreeRepo }),
        service.inspect({ path: bigRepo }),
        service.inspect({ path: deviceRepo }),
      ]));
      for (const result of results) {
        expect(result).toMatchObject({ exists: true, isGitRepo: true, branch: null });
      }

      const normal = join(root, "normal-repo");
      mkdirSync(join(normal, ".git"), { recursive: true });
      writeFileSync(join(normal, ".git", "HEAD"), "ref: refs/heads/main\n");
      await expect(withinTimeout(service.inspect({ path: normal })))
        .resolves.toMatchObject({ isGitRepo: true, branch: "main" });
    },
  );
});

describe("macOS 主目录受保护目录", () => {
  it("只在 darwin 且列主目录第一层时跳过探测，并以 probed: false 标记", async () => {
    const home = temporaryRoot();
    for (const name of ["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures"]) {
      mkdirSync(join(home, name, ".git"), { recursive: true });
    }
    mkdirSync(join(home, "projects", ".git"), { recursive: true });
    mkdirSync(join(home, "projects", "Documents", ".git"), { recursive: true });
    const realHome = realpathSync(home);
    const service = (platform: NodeJS.Platform) =>
      new LocalDirectoryService({ recentRoots: () => [], homeDirectory: () => home, platform });

    const darwinHome = await service("darwin").list({ hidden: false });
    const documents = darwinHome.entries.find((entry) => entry.name === "Documents");
    expect(documents).toEqual({
      name: "Documents",
      path: join(realHome, "Documents"),
      isGitRepo: false,
      readable: true,
      writable: true,
      probed: false,
    });
    expect(darwinHome.entries.filter((entry) => entry.probed === false)).toHaveLength(7);
    expect(darwinHome.entries.find((entry) => entry.name === "projects")).toEqual({
      name: "projects",
      path: join(realHome, "projects"),
      isGitRepo: true,
      readable: true,
      writable: true,
    });

    const explicitHome = await service("darwin").list({ path: home, hidden: false });
    expect(explicitHome.entries.find((entry) => entry.name === "Library")?.probed).toBe(false);

    const nested = await service("darwin").list({ path: join(home, "projects"), hidden: false });
    expect(nested.entries).toEqual([
      expect.objectContaining({ name: "Documents", isGitRepo: true }),
    ]);
    expect(nested.entries[0]).not.toHaveProperty("probed");

    const linuxHome = await service("linux").list({ hidden: false });
    expect(linuxHome.entries.find((entry) => entry.name === "Documents")).toEqual(
      expect.objectContaining({ isGitRepo: true }),
    );
    expect(linuxHome.entries.some((entry) => "probed" in entry)).toBe(false);
  });
});

describe("最近使用目录", () => {
  it("只取仍在用的本机项目根目录，保持映射表顺序", () => {
    const projects = new Map([
      ["p1", { rootPath: "/work/one", state: "active" }],
      ["p2", { rootPath: "/work/two", state: "removed" }],
      ["p3", { rootPath: "/work/three", state: "active" }],
    ]);
    expect(mappedWorkspaceRoots(
      { list: () => [{ localProjectId: "p3" }, { localProjectId: "p2" }, { localProjectId: "p1" }, { localProjectId: "gone" }] },
      { getById: (id) => projects.get(id) ?? null },
    )).toEqual(["/work/three", "/work/one"]);
  });
});

async function withinTimeout<T>(promise: Promise<T>, milliseconds = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("操作超时，疑似阻塞在特殊文件上")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "suduo-local-dirs-"));
  temporaryPaths.push(root);
  return root;
}
