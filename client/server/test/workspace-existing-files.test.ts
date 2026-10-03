import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "../src/application/workspace-service.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { buildOpenCommand } from "../src/infrastructure/platform/system-open.js";

/**
 * 会话回答里的文件路径可点击：批量确认路径存在（只认项目目录内的普通文件），
 * ⌘ 点击用 VS Code 打开时跳到行。
 */

const temporaryPaths: string[] = [];
afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "suduo-existing-files-"));
  temporaryPaths.push(path);
  return path;
}

function setup() {
  const root = temporaryDirectory();
  mkdirSync(join(root, "Appreciation-admin/src/views"), { recursive: true });
  writeFileSync(join(root, "Appreciation-admin/src/views/Order.vue"), "<template />");
  writeFileSync(join(root, "订单说明.md"), "# 说明");
  const outside = temporaryDirectory();
  writeFileSync(join(outside, "secret.txt"), "x");
  symlinkSync(join(outside, "secret.txt"), join(root, "link-out.txt"));
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const projects = new ProjectRepository(database);
  const project = projects.create({ name: "p", rootPath: root, rootPathKey: root });
  const service = new WorkspaceService(projects, new SessionRepository(database), { roots: () => [] }, undefined, {
    baselineRoot: temporaryDirectory(),
  });
  return { service, project };
}

describe("existingFiles", () => {
  it("只返回项目目录内确实存在的普通文件；目录、不存在、越界、符号链接出项目的都不算，也不报错", async () => {
    const { service, project } = setup();
    const result = await service.existingFiles(project.id, [
      "Appreciation-admin/src/views/Order.vue",
      "订单说明.md",
      "Appreciation-admin/src/views",
      "receiverSnapshot",
      "../etc/passwd",
      "/etc/hosts",
      "link-out.txt",
      "Appreciation-admin/src/views/Order.vue",
    ]);
    expect(result.files).toEqual(["Appreciation-admin/src/views/Order.vue", "订单说明.md"]);
  });
});

describe("用 VS Code 打开时跳到行", () => {
  it("带行号时用 code -g 文件:行；不带行号照旧", () => {
    expect(buildOpenCommand({ platform: "darwin", wsl: false, mode: "vscode", path: "/p/a.vue", line: 401 })).toEqual({
      command: "code",
      args: ["-g", "/p/a.vue:401"],
    });
    expect(buildOpenCommand({ platform: "win32", wsl: false, mode: "vscode", path: "C:\\p\\a.vue", line: 3 })).toEqual({
      command: "cmd",
      args: ["/c", "code", "-g", "C:\\p\\a.vue:3"],
    });
    expect(buildOpenCommand({ platform: "darwin", wsl: false, mode: "vscode", path: "/p/a.vue" })).toEqual({
      command: "code",
      args: ["/p/a.vue"],
    });
  });
});
