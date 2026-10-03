import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readNotes,
  requirementDirName,
  resolveRequirementDir,
  saveNotes,
  sha256,
} from "../src/application/session-tools/requirement-dir.js";

/** 需求在项目里的本机目录 `.suduo/requirements/REQ-n-标题/`（技术设计 4.5）。 */

const temporaryPaths: string[] = [];
afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "suduo-reqdir-"));
  temporaryPaths.push(root);
  return root;
}

describe("requirementDirName", () => {
  it("去掉路径不安全字符、空白换成连字符、合并连字符", () => {
    expect(requirementDirName(1, "商家端-订单详情优化")).toBe("REQ-1-商家端-订单详情优化");
    expect(requirementDirName(2, 'a/b\\c:d*e?f"g<h>i|j')).toBe("REQ-2-a-b-c-d-e-f-g-h-i-j");
    expect(requirementDirName(3, "  订单  详情\t弹窗 \n")).toBe("REQ-3-订单-详情-弹窗");
    expect(requirementDirName(4, "a\u0000b\u001fc")).toBe("REQ-4-a-b-c");
    // 首尾的连字符和点去掉（Windows 不允许目录名以点结尾）。
    expect(requirementDirName(5, "..隐藏.")).toBe("REQ-5-隐藏");
    expect(requirementDirName(6, "/../../etc")).toBe("REQ-6-etc");
  });

  it("标题为空或全是非法字符时只用编号", () => {
    expect(requirementDirName(7, "")).toBe("REQ-7");
    expect(requirementDirName(8, "///")).toBe("REQ-8");
    expect(requirementDirName(9, " ")).toBe("REQ-9");
  });

  it("标题按字（码点）截 40 个", () => {
    const title = "需".repeat(50);
    expect(requirementDirName(10, title)).toBe("REQ-10-" + "需".repeat(40));
    // emoji 等代理对不会被截成半个字符。
    const emoji = "😀".repeat(45);
    const name = requirementDirName(11, emoji);
    expect(Array.from(name.slice("REQ-11-".length))).toHaveLength(40);
    expect(name.endsWith("😀")).toBe(true);
  });

  it("截断后不以连字符或点结尾", () => {
    expect(requirementDirName(12, "a".repeat(39) + ".后缀说明")).toBe("REQ-12-" + "a".repeat(39));
    expect(requirementDirName(13, "b".repeat(39) + " 第二段")).toBe("REQ-13-" + "b".repeat(39));
  });
});

describe("resolveRequirementDir", () => {
  it("第一次创建时建好目录与 .suduo/.gitignore", async () => {
    const root = projectRoot();
    const dir = await resolveRequirementDir(root, { number: 1, title: "商家端-订单详情优化" });
    expect(dir.relativePath).toBe(join(".suduo", "requirements", "REQ-1-商家端-订单详情优化"));
    expect(dir.absolutePath).toBe(join(root, dir.relativePath));
    expect(existsSync(dir.absolutePath)).toBe(true);
    const gitignore = readFileSync(join(root, ".suduo", ".gitignore"), "utf8");
    expect(gitignore.split("\n")).toContain("*");
  });

  it("create:false 时不建任何目录", async () => {
    const root = projectRoot();
    const dir = await resolveRequirementDir(root, { number: 1, title: "标题" }, { create: false });
    expect(dir.relativePath).toBe(join(".suduo", "requirements", "REQ-1-标题"));
    expect(existsSync(join(root, ".suduo"))).toBe(false);
  });

  it("改标题后按编号找到旧目录继续用；REQ-12 不会被当成 REQ-1", async () => {
    const root = projectRoot();
    const parent = join(root, ".suduo", "requirements");
    mkdirSync(join(parent, "REQ-12-别的需求"), { recursive: true });
    mkdirSync(join(parent, "REQ-1-旧标题"), { recursive: true });
    writeFileSync(join(parent, "REQ-1-旧标题", "notes.md"), "旧笔记");

    const dir = await resolveRequirementDir(root, { number: 1, title: "新标题" });
    expect(dir.relativePath).toBe(join(".suduo", "requirements", "REQ-1-旧标题"));
    expect(readdirSync(parent).sort()).toEqual(["REQ-1-旧标题", "REQ-12-别的需求"]);
    expect((await readNotes(dir)).content).toBe("旧笔记");

    const twelve = await resolveRequirementDir(root, { number: 12, title: "改过的" });
    expect(twelve.relativePath).toBe(join(".suduo", "requirements", "REQ-12-别的需求"));
    // 只有编号的旧目录也认。
    mkdirSync(join(parent, "REQ-3"));
    expect((await resolveRequirementDir(root, { number: 3, title: "x" })).relativePath).toBe(
      join(".suduo", "requirements", "REQ-3"),
    );
  });
});

describe("saveNotes", () => {
  it("第一次写不存档；再写时旧内容存进 notes.history/；内容相同不存档", async () => {
    const root = projectRoot();
    const dir = await resolveRequirementDir(root, { number: 1, title: "t" });
    const first = await saveNotes(dir, "# 结论 v1", undefined);
    expect(first).toEqual({
      path: join(dir.relativePath, "notes.md"),
      backupPath: null,
      changedSinceRead: false,
      sha256: sha256("# 结论 v1"),
    });

    const second = await saveNotes(dir, "# 结论 v2", first.sha256);
    expect(second.backupPath).toMatch(/notes\.history[\\/].+\.md$/u);
    expect(second.changedSinceRead).toBe(false);
    expect(readFileSync(join(root, second.backupPath!), "utf8")).toBe("# 结论 v1");
    expect(readFileSync(join(dir.absolutePath, "notes.md"), "utf8")).toBe("# 结论 v2");

    const same = await saveNotes(dir, "# 结论 v2", second.sha256);
    expect(same.backupPath).toBeNull();
    expect(readdirSync(join(dir.absolutePath, "notes.history"))).toHaveLength(1);
    // 没有残留临时文件。
    expect(readdirSync(dir.absolutePath).sort()).toEqual(["notes.history", "notes.md"]);
  });

  it("读后被外部改过时 changedSinceRead=true（只告知，照样写入）；读时还没有笔记、之后有人建了也算", async () => {
    const root = projectRoot();
    const dir = await resolveRequirementDir(root, { number: 1, title: "t" });
    await saveNotes(dir, "模型写的", undefined);
    const read = await readNotes(dir);
    writeFileSync(join(dir.absolutePath, "notes.md"), "用户改过的");
    const result = await saveNotes(dir, "模型再写", read.sha256);
    expect(result.changedSinceRead).toBe(true);
    expect(readFileSync(join(root, result.backupPath!), "utf8")).toBe("用户改过的");
    expect(readFileSync(join(dir.absolutePath, "notes.md"), "utf8")).toBe("模型再写");

    const other = await resolveRequirementDir(root, { number: 2, title: "u" });
    const empty = await readNotes(other);
    expect(empty).toEqual({ path: join(other.relativePath, "notes.md"), content: null, sha256: null });
    writeFileSync(join(other.absolutePath, "notes.md"), "用户先建的");
    expect((await saveNotes(other, "模型写", empty.sha256)).changedSinceRead).toBe(true);
    // 模型从没读过（undefined）时不提示。
    expect((await saveNotes(other, "模型又写", undefined)).changedSinceRead).toBe(false);
  });
});

describe("落盘越界检查（审查第 3 条）", () => {
  it(".suduo 是指向项目外的符号链接时拒绝写入，不顺着链接写到项目外", async () => {
    const root = projectRoot();
    const outside = mkdtempSync(join(tmpdir(), "suduo-outside-"));
    temporaryPaths.push(outside);
    symlinkSync(outside, join(root, ".suduo"));
    await expect(resolveRequirementDir(root, { number: 1, title: "越界" })).rejects.toThrow(/项目目录之外/u);
    expect(readdirSync(outside).filter((name) => name !== ".gitignore")).toEqual([]);
  });
});
