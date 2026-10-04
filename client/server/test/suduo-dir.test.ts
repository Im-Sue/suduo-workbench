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
import { GitService } from "../src/application/git-service.js";
import type { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { saveImageAttachment } from "../src/infrastructure/workspace/attachment-store.js";
import { ensureSuDuoDir } from "../src/infrastructure/workspace/suduo-dir.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const temporaryPaths: string[] = [];
afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("ensureSuDuoDir", () => {
  it("新建 .suduo/ 时写入忽略全部内容的 .gitignore", async () => {
    const root = temporaryDirectory();
    const directory = await ensureSuDuoDir(root);
    expect(directory).toBe(join(root, ".suduo"));
    const gitignore = readFileSync(resolve(root, ".suduo", ".gitignore"), "utf8");
    expect(gitignore.split("\n")).toContain("*");
    // 重复调用幂等。
    await expect(ensureSuDuoDir(root)).resolves.toBe(directory);
  });

  it("已有 .gitignore 时不覆盖（用户可能改过）", async () => {
    const root = temporaryDirectory();
    mkdirSync(resolve(root, ".suduo"));
    writeFileSync(resolve(root, ".suduo", ".gitignore"), "attachments/\n");
    await ensureSuDuoDir(root);
    expect(readFileSync(resolve(root, ".suduo", ".gitignore"), "utf8")).toBe(
      "attachments/\n",
    );
  });
});

describe("写进 .suduo/ 的入口都带 .gitignore", () => {
  it("聊天贴图附件", async () => {
    const root = temporaryDirectory();
    const attachment = await saveImageAttachment({
      projectId: "p1",
      projectRoot: root,
      mediaType: "image/png",
      dataBase64: PNG_1X1,
    });
    expect(existsSync(resolve(root, attachment.relativePath))).toBe(true);
    expect(existsSync(resolve(root, ".suduo", ".gitignore"))).toBe(true);
  });

  it("版本管理设置 git.json", async () => {
    const root = temporaryDirectory();
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
    // 非 git 目录（甚至本机没有 git）时 status 也只是降级返回，不影响写设置。
    await new GitService(projects).updateSettings("p1", { autoCheckpoint: true }, "zh-CN");
    expect(existsSync(resolve(root, ".suduo", "git.json"))).toBe(true);
    expect(existsSync(resolve(root, ".suduo", ".gitignore"))).toBe(true);
  });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "suduo-dir-"));
  temporaryPaths.push(path);
  return path;
}
