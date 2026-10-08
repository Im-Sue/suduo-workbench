import { describe, expect, it } from "vitest";
import { otherLinkedProjects } from "../src/features/requirements/components/DirectoryPicker.js";
import { messagesFor } from "../src/i18n/messages/index.js";

const inspection = (linkedRemoteProjectIds: string[]) => ({
  path: "/code/shared",
  exists: true,
  isDirectory: true,
  readable: true,
  writable: true,
  isGitRepo: true,
  branch: "main",
  linkedRemoteProjectIds,
});

describe("选目录时告知目录已关联的其他项目（一个目录可以关联多个项目）", () => {
  it("正在选目录的项目自己不算；没有检查结果时为空", () => {
    expect(otherLinkedProjects(inspection(["p-web", "p-api"]), "p-web")).toEqual(["p-api"]);
    expect(otherLinkedProjects(inspection(["p-web"]), "p-web")).toEqual([]);
    expect(otherLinkedProjects(inspection(["p-web", "p-api"]), undefined)).toEqual(["p-web", "p-api"]);
    expect(otherLinkedProjects(undefined, "p-web")).toEqual([]);
  });

  it("中文：说出项目名；看不到名字的项目合并计数，不重复「另一个项目」", () => {
    const alsoLinked = messagesFor("zh-CN").requirements.directoryPicker.alsoLinked;
    expect(alsoLinked(["后端"])).toBe("这个目录也关联给了「后端」，两个项目的会话都会在这里运行");
    expect(alsoLinked([null])).toBe("这个目录也关联给了另一个项目，两个项目的会话都会在这里运行");
    expect(alsoLinked(["后端", null, null])).toBe("这个目录也关联给了「后端」、另外 2 个项目，这些项目的会话都会在这里运行");
  });

  it("英文", () => {
    const alsoLinked = messagesFor("en").requirements.directoryPicker.alsoLinked;
    expect(alsoLinked(["API"])).toBe("This folder is also linked to “API”. Sessions of both projects will run here.");
    expect(alsoLinked(["API", "Admin", null])).toBe(
      "This folder is also linked to “API”, “Admin”, and another project. Sessions of all these projects will run here.",
    );
    expect(alsoLinked([null, null])).toBe("This folder is also linked to 2 other projects. Sessions of all these projects will run here.");
  });
});
