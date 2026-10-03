import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "../src/application/workspace-service.js";
import type { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import type { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";

describe("WorkspaceService.readContent 二进制识别（回归：.doc 乱码曾卡死渲染）", () => {
  let root: string;
  let baselineRoot: string;
  let service: WorkspaceService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "suduo-preview-"));
    baselineRoot = mkdtempSync(join(tmpdir(), "suduo-preview-baselines-"));
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
    service = new WorkspaceService(
      projects,
      { getById: () => null } as unknown as SessionRepository,
      { roots: () => [] },
      undefined,
      { baselineRoot },
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(baselineRoot, { recursive: true, force: true });
  });

  it("已知二进制扩展名（.docx）直接返回 binary，不读内容", async () => {
    writeFileSync(join(root, "需求.docx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
    const result = await service.readContent("p1", "需求.docx");
    expect(result.type).toBe("binary");
  });

  it("未知扩展名但含空字节 → binary", async () => {
    writeFileSync(join(root, "mystery.xyz"), Buffer.from([0x41, 0x00, 0x42, 0x43]));
    const result = await service.readContent("p1", "mystery.xyz");
    expect(result.type).toBe("binary");
  });

  it("正常 markdown 仍返回全文文本", async () => {
    writeFileSync(join(root, "说明.md"), "# 标题\n\n正文", "utf8");
    const result = await service.readContent("p1", "说明.md");
    expect(result.type).toBe("text");
    if (result.type === "text") {
      expect(result.text).toContain("正文");
      expect(result.truncated).not.toBe(true);
      expect(result.mediaType).toBe("text/markdown");
    }
  });
});
