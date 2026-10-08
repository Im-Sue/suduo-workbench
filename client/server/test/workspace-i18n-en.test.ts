import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@suduo/client-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { GitService } from "../src/application/git-service.js";
import { LocalDirectoryService } from "../src/application/local-directory-service.js";
import { RequirementsV2Service } from "../src/application/requirements-v2-service.js";
import { verifyWorkspaceMappingPath } from "../src/application/workspace-mapping-verifier.js";
import { messagesFor } from "../src/i18n/messages/index.js";
import type { SessionService } from "../src/application/session-service.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { RequirementSessionRefRepository } from "../src/infrastructure/db/repositories/requirement-session-ref-repository.js";
import { WorkspaceMappingRepository } from "../src/infrastructure/db/repositories/workspace-mapping-repository.js";
import { RequirementsCredentialStore } from "../src/infrastructure/requirements-v2/credential-store.js";
import { RequirementsRemoteClient } from "../src/infrastructure/requirements-v2/remote-client.js";
import { RequirementsSettingsStore } from "../src/infrastructure/requirements-v2/settings-store.js";
import { createMinimalHttpContext } from "./helpers/minimal-http-context.js";

/**
 * 项目、目录映射、路径、附件、本机目录与版本管理的说明按请求语言生成：带 `x-suduo-locale: en` 出英文；
 * 不带头时用夹具记下的界面语言（zh-CN），与迁移前逐字相同。带头的请求会把语言记下来，所以先发不带头的。
 */
const HOST = "127.0.0.1:8787";
const ORIGIN = "http://" + HOST;

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function setup() {
  const dataDirectory = temporaryDirectory("suduo-workspace-i18n-data-");
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const projects = new ProjectRepository(database);
  const mappings = new WorkspaceMappingRepository(database);
  const settings = new RequirementsSettingsStore(dataDirectory);
  const credentials = new RequirementsCredentialStore(dataDirectory);
  const requirementsV2 = new RequirementsV2Service(
    settings,
    credentials,
    new RequirementsRemoteClient(settings, credentials, (async () => {
      throw new Error("remote is not used here");
    }) as typeof fetch),
    mappings,
    projects,
    {} as SessionService,
    new RequirementSessionRefRepository(database),
    database,
  );
  const context = createMinimalHttpContext({ runtimeId: "unused" } as unknown as AgentRuntime, {
    requirementsV2,
    localDirectories: new LocalDirectoryService({ recentRoots: () => [] }),
  });
  cleanups.push(async () => {
    await context.close();
    database.close();
  });
  let key = 0;
  const send = async (method: "GET" | "POST", url: string, locale: "en" | null, payload?: unknown) => {
    key += 1;
    return context.server.inject({
      method,
      url,
      headers: {
        host: HOST,
        ...(method === "POST" ? { origin: ORIGIN, "idempotency-key": `key-${String(key)}` } : {}),
        ...(locale === null ? {} : { "x-suduo-locale": locale }),
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  };
  /** 在映射用的库里挂一个远程项目 → 本机目录（只给 verify=1 复验用，不碰远程）。 */
  const link = (remoteProjectId: string, rootPath: string) => {
    const project = projects.create({ name: remoteProjectId, rootPath, rootPathKey: rootPath });
    // 关联属于当前服务器（迁移 018）：配上一个地址，不登录、不发请求。
    const serverOrigin = settings.getBaseUrl() ?? settings.setBaseUrl("https://requirements.example");
    mappings.save({ remoteProjectId, localProjectId: project.id, serverOrigin });
  };
  return { send, link };
}

describe("项目、路径与本机目录的报错按请求语言", () => {
  it("本机目录浏览", async () => {
    const { send } = setup();
    const missing = "/definitely/not/here/suduo-i18n";
    const zh = await send("GET", `/api/v2/local/dirs?path=${encodeURIComponent(missing)}`, null);
    expect(zh.statusCode).toBe(404);
    expect(zh.json().error).toMatchObject({ code: "LOCAL_PATH_NOT_FOUND", message: "这个位置不存在" });
    expect((await send("GET", "/api/v2/local/dirs?hidden=2", null)).json().error.message).toBe("hidden 仅支持 1 或 0");

    const en = await send("GET", `/api/v2/local/dirs?path=${encodeURIComponent(missing)}`, "en");
    expect(en.json().error).toMatchObject({ code: "LOCAL_PATH_NOT_FOUND", message: "This location doesn't exist" });
    expect((await send("GET", "/api/v2/local/dirs?hidden=2", "en")).json().error.message).toBe("hidden must be 1 or 0");
    expect((await send("GET", "/api/v2/local/dirs?extra=1", "en")).json().error.message)
      .toBe("Unsupported query parameter: extra");
    expect((await send("GET", "/api/v2/local/dirs/inspect?path=relative", "en")).json().error.message)
      .toBe("Enter a full path that starts from the root");
  });

  it("新建本机项目的路径校验与贴图附件", async () => {
    const { send } = setup();
    const missing = { rootPath: "/definitely/not/here/suduo-i18n" };
    expect((await send("POST", "/api/v1/projects", null, missing)).json().error.message)
      .toBe("rootPath 必须是存在且可读的本机目录");
    const root = temporaryDirectory("suduo-workspace-i18n-project-");
    const project = await send("POST", "/api/v1/projects", null, { rootPath: root });
    const projectId = String(project.json().id);
    const attachment = { mediaType: "text/plain", dataBase64: "aGk=" };
    expect((await send("POST", `/api/v1/projects/${projectId}/attachments`, null, attachment)).json().error.message)
      .toBe("附件仅支持 PNG/JPEG/GIF/WebP 图片");

    expect((await send("POST", "/api/v1/projects", "en", missing)).json().error.message)
      .toBe("rootPath must be an existing local folder you can read");
    expect((await send("POST", `/api/v1/projects/${projectId}/attachments`, "en", attachment)).json().error.message)
      .toBe("Attachments must be PNG, JPEG, GIF, or WebP images");
    expect((await send("GET", "/api/v1/projects/no-such-project", "en")).json().error.message).toBe("Project not found");
  });

  it("目录映射复验的结论（DTO 里的 message）", async () => {
    const { send, link } = setup();
    link("remote-ok", temporaryDirectory("suduo-workspace-i18n-mapped-"));
    link("remote-gone", "/definitely/not/here/suduo-i18n");
    const messages = async (locale: "en" | null) => {
      const response = await send("GET", "/api/v2/project-mappings?verify=1", locale);
      expect(response.statusCode).toBe(200);
      const items = response.json().items as Array<{ remoteProjectId: string; verification: { message: string } }>;
      return Object.fromEntries(items.map((item) => [item.remoteProjectId, item.verification.message]));
    };
    expect(await messages(null)).toEqual({ "remote-ok": "本机工作目录可用", "remote-gone": "本机工作目录不存在或无法访问" });
    expect(await messages("en")).toEqual({
      "remote-ok": "Local folder is available",
      "remote-gone": "The local folder doesn't exist or can't be accessed",
    });
    expect((await send("GET", "/api/v2/project-mappings?verify=2", "en")).json().error.message).toBe("verify only accepts 1");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("缺少的权限按语言列出", async () => {
    const root = temporaryDirectory("suduo-workspace-i18n-perm-");
    chmodSync(root, 0o500);
    cleanups.push(() => chmodSync(root, 0o700));
    expect((await verifyWorkspaceMappingPath(root, messagesFor("zh-CN"))).message).toBe("本机工作目录缺少写入权限");
    expect((await verifyWorkspaceMappingPath(root, messagesFor("en"))).message)
      .toBe("The local folder is missing write permission");
    chmodSync(root, 0o100);
    expect((await verifyWorkspaceMappingPath(root, messagesFor("zh-CN"))).message).toBe("本机工作目录缺少读取、写入权限");
    expect((await verifyWorkspaceMappingPath(root, messagesFor("en"))).message)
      .toBe("The local folder is missing read and write permissions");
  });
});

describe.skipIf(!gitAvailable)("版本管理按请求语言", () => {
  it("初始化与手动检查点的提交标题按请求语言写，报错按请求语言", async () => {
    const { send } = setup();
    const root = temporaryDirectory("suduo-workspace-i18n-git-");
    writeFileSync(join(root, "notes.md"), "v1", "utf8");
    const projectId = String((await send("POST", "/api/v1/projects", null, { rootPath: root })).json().id);
    expect((await send("POST", `/api/v1/projects/${projectId}/git/restore`, null, { hash: "not-a-hash" })).json().error.message)
      .toBe("提交号格式无效");

    expect((await send("POST", `/api/v1/projects/${projectId}/git/init`, "en", {})).statusCode).toBe(200);
    writeFileSync(join(root, "notes.md"), "v2", "utf8");
    const checkpoint = await send("POST", `/api/v1/projects/${projectId}/git/checkpoint`, "en", { message: "Draft done" });
    expect(checkpoint.json().checkpoint).toMatchObject({
      subject: "SuDuo checkpoint: Draft done",
      kind: "manual",
      note: "Draft done",
    });
    const items = (await send("GET", `/api/v1/projects/${projectId}/git/checkpoints`, "en")).json().items as Array<{
      subject: string;
      kind: string | null;
    }>;
    expect(items.map((item) => [item.subject, item.kind])).toEqual([
      ["SuDuo checkpoint: Draft done", "manual"],
      ["SuDuo: initialize version control", null],
    ]);
    expect((await send("POST", `/api/v1/projects/${projectId}/git/init`, "en", {})).json().error.message)
      .toBe("This project is already a Git repository");
    expect((await send("POST", `/api/v1/projects/${projectId}/git/restore`, "en", { hash: "not-a-hash" })).json().error.message)
      .toBe("The commit hash isn't valid");
  });

  it("回合前自动存档用记下的界面语言写标题；失败原因到返回状态时才按语言渲染", async () => {
    const root = temporaryDirectory("suduo-workspace-i18n-auto-");
    const projects = {
      getById: (id: string) =>
        id === "p1"
          ? { id: "p1", name: "p1", rootPath: root, state: "active" as const, createdAt: 0, updatedAt: 0, lastOpenedAt: null, version: 1 }
          : null,
    } as unknown as ProjectRepository;
    const service = new GitService(projects, () => true, () => "en");
    writeFileSync(join(root, "notes.md"), "v1", "utf8");
    await service.init("p1", "en");
    writeFileSync(join(root, "notes.md"), "v2", "utf8");
    await service.autoCheckpoint("p1", root);
    const [latest] = await service.listCheckpoints("p1");
    expect(latest).toMatchObject({ subject: "SuDuo auto-save: before turn", kind: "turn-start", auto: true });

    // 提交钩子拒绝：自动存档失败只记下原因，状态按请求语言给出。
    const hook = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(hook, 0o755);
    writeFileSync(join(root, "notes.md"), "v3", "utf8");
    await service.autoCheckpoint("p1", root);
    expect((await service.status("p1", "en")).lastError).toMatch(/^Git command failed/);
    expect((await service.status("p1", "zh-CN")).lastError).toMatch(/^git 操作失败/);
  });
});
