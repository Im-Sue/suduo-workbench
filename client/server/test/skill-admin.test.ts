import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillAdminService } from "../src/application/skill-admin-service.js";

const SKILL_MD = [
  "---",
  "name: demo-skill",
  "description: 演示技能",
  "version: 1.2.0",
  "---",
  "",
  "# demo",
].join("\n");

function zipBase64(files: Record<string, string>): string {
  const payload: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) {
    payload[path] = strToU8(text);
  }
  return Buffer.from(zipSync(payload)).toString("base64");
}

describe("SkillAdminService", () => {
  let root: string;
  let service: SkillAdminService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "suduo-skill-"));
    service = new SkillAdminService(join(root, "global-skills"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("zip（单一顶层目录）安装→列表带版本→卸载", async () => {
    const installed = await service.install({
      source: "zip",
      fileName: "demo.zip",
      dataBase64: zipBase64({
        "demo-skill/SKILL.md": SKILL_MD,
        "demo-skill/references/说明.md": "参考",
      }),
    });
    expect(installed.name).toBe("demo-skill");
    expect(installed.version).toBe("1.2.0");

    const listed = await service.list();
    expect(listed).toHaveLength(1);

    await service.remove(installed.path);
    expect(await service.list()).toHaveLength(0);
  });

  it("zip 根含 SKILL.md 时用 zip 文件名作目录名；重名需 overwrite", async () => {
    const data = zipBase64({ "SKILL.md": SKILL_MD });
    const first = await service.install({
      source: "zip",
      fileName: "req-需求包.zip",
      dataBase64: data,
    });
    expect(first.path).toContain("req-需求包");

    await expect(
      service.install({ source: "zip", fileName: "req-需求包.zip", dataBase64: data }),
    ).rejects.toThrow("覆盖更新");

    const updated = await service.install({
      source: "zip",
      fileName: "req-需求包.zip",
      dataBase64: data,
      overwrite: true,
    });
    expect(updated.version).toBe("1.2.0");
  });

  it("拒绝 zip-slip 路径", async () => {
    await expect(
      service.install({
        source: "zip",
        fileName: "evil.zip",
        dataBase64: zipBase64({ "../evil/SKILL.md": SKILL_MD }),
      }),
    ).rejects.toThrow("非法路径");
  });

  it("文件夹安装 + 卸载守卫（不允许删全局目录外的路径）", async () => {
    const sourceDir = join(root, "local-skill");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "SKILL.md"), SKILL_MD, "utf8");

    const installed = await service.install({ source: "folder", path: sourceDir });
    expect(installed.name).toBe("demo-skill");
    expect(existsSync(sourceDir)).toBe(true);

    await expect(service.remove(sourceDir)).rejects.toThrow("全局 skills 目录");
  });
});
