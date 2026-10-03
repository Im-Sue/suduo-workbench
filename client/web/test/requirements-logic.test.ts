import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import type {
  ListRequirementItemsResponse,
  RequirementListItemDto,
} from "@suduo/client-contracts";
import type { RequirementActivityEntryDto } from "@suduo/cloud-contracts";
import { describe, expect, it } from "vitest";
import { presentActivity } from "../src/features/requirements/activity.js";
import {
  formatBytes,
  inlineUrl,
  previewKind,
  requirementCode,
  summaryPreview,
} from "../src/features/requirements/format.js";
import { requirementKeys } from "../src/features/requirements/keys.js";
import { findCachedItem, placeInColumns } from "../src/features/requirements/queries.js";
import { formatRelativeTime } from "../src/ui/format.js";

const alice = { id: "u1", displayName: "陈思远" };
const bob = { id: "u2", displayName: "林雨" };

function item(overrides: Partial<RequirementListItemDto> = {}): RequirementListItemDto {
  return {
    id: "r1",
    projectId: "p1",
    number: 1,
    title: "需求",
    summary: "",
    status: "draft",
    assignee: null,
    commentCount: 0,
    attachmentCount: 0,
    localSessionCount: 0,
    createdBy: alice,
    updatedBy: alice,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

function entry(overrides: Partial<RequirementActivityEntryDto>): RequirementActivityEntryDto {
  return {
    id: "a1",
    requirementId: "r1",
    actor: alice,
    action: "requirement.created",
    resourceType: "requirement",
    resourceId: "r1",
    before: null,
    after: null,
    createdAt: "2026-09-29T00:00:00.000Z",
    changes: [],
    comment: null,
    attachment: null,
    artifactVersion: null,
    ...overrides,
  } as RequirementActivityEntryDto;
}

describe("需求展示格式", () => {
  it("编号显示为 REQ-n，缺号时不出现 undefined", () => {
    expect(requirementCode(128)).toBe("REQ-128");
    expect(requirementCode(undefined)).toBe("REQ-—");
  });

  it("时间：1 小时内相对，今天时分，昨天带前缀，今年月日，更早带年份", () => {
    const now = new Date(2026, 8, 29, 15, 0);
    expect(formatRelativeTime(new Date(2026, 8, 29, 14, 59, 40), now)).toBe("刚刚");
    expect(formatRelativeTime(new Date(2026, 8, 29, 14, 30), now)).toBe("30 分钟前");
    expect(formatRelativeTime(new Date(2026, 8, 29, 9, 5), now)).toBe("09:05");
    expect(formatRelativeTime(new Date(2026, 8, 28, 16, 20), now)).toBe("昨天 16:20");
    expect(formatRelativeTime(new Date(2026, 1, 3, 10, 0), now)).toBe("2月3日");
    expect(formatRelativeTime(new Date(2025, 8, 27, 10, 0), now)).toBe("2025年9月27日");
  });

  it("大小用 B / KB / MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(86 * 1024)).toBe("86 KB");
    expect(formatBytes(1.2 * 1024 * 1024)).toBe("1.2 MB");
  });

  it("描述预览去掉 Markdown 标记，只留一行文字", () => {
    expect(summaryPreview("# 背景\n\n- 单次上限 **50 万行**\n- `文件` 保留 [7 天](http://x)")).toBe(
      "背景 单次上限 50 万行 文件 保留 7 天",
    );
    expect(summaryPreview("```\ncode\n```\n正文")).toBe("正文");
  });

  it("只有白名单类型可在线预览，SVG / HTML 一律下载", () => {
    expect(previewKind("截图.PNG")).toBe("image");
    expect(previewKind("需求说明.pdf")).toBe("document");
    expect(previewKind("notes.txt")).toBe("document");
    expect(previewKind("logo.svg")).toBeNull();
    expect(previewKind("page.html")).toBeNull();
    expect(previewKind("README.md")).toBeNull();
    expect(previewKind("no-extension")).toBeNull();
    expect(inlineUrl("/api/v2/attachments/a1/content")).toBe("/api/v2/attachments/a1/content?disposition=inline");
  });
});

describe("活动时间线文案", () => {
  it("状态变化写成整句并带前后状态", () => {
    const view = presentActivity(
      entry({ action: "requirement.status_changed", changes: [{ field: "status", from: "ready_for_development", to: "in_development" }] }),
    );
    expect(view.text).toBe("把状态从「待开发」改为「开发中」");
    expect(view.status).toEqual({ from: "ready_for_development", to: "in_development" });
  });

  it("负责人：认领、指派他人、取消", () => {
    const change = (to: typeof bob | null) =>
      presentActivity(entry({ action: "requirement.assignee_changed", changes: [{ field: "assignee", from: null, to }] })).text;
    expect(change(alice)).toBe("认领了这条需求");
    expect(change(bob)).toBe("把负责人改为 林雨");
    expect(change(null)).toBe("取消了负责人");
  });

  it("编辑、评论、材料、确认版", () => {
    expect(
      presentActivity(entry({ action: "requirement.updated", changes: [{ field: "summary", from: "", to: "新描述" }] })).text,
    ).toBe("补充了描述");
    expect(presentActivity(entry({ action: "comment.created", comment: { id: "c1", body: "好的" } })).body).toBe("好的");
    expect(presentActivity(entry({ action: "attachment.deleted", attachment: { id: "f1", fileName: "a.pdf" } })).text).toBe(
      "删除了「a.pdf」",
    );
    expect(
      presentActivity(
        entry({ action: "artifact_version.published", artifactVersion: { id: "v1", versionNumber: 2, fileCount: 3, note: "补充上限" } }),
      ),
    ).toMatchObject({ text: "发布了确认版 · 第 2 版（3 个文件）", body: "补充上限" });
  });

  it("不认识的动作也保留一条，不丢信息", () => {
    expect(presentActivity(entry({ action: "requirement.archived" as never })).text).toBe("更新了需求");
  });
});

describe("看板缓存的乐观改写", () => {
  function seed(client: QueryClient, status: RequirementListItemDto["status"], items: RequirementListItemDto[]) {
    const data: InfiniteData<ListRequirementItemsResponse, string | undefined> = {
      pages: [{ items, nextCursor: null }],
      pageParams: [undefined],
    };
    client.setQueryData(requirementKeys.column("p1", status, {}), data);
  }
  const column = (client: QueryClient, status: RequirementListItemDto["status"]) =>
    client
      .getQueryData<InfiniteData<ListRequirementItemsResponse>>(requirementKeys.column("p1", status, {}))
      ?.pages.flatMap((page) => page.items.map((entry) => entry.id));

  it("改状态：从原列移除，放到目标列最前", () => {
    const client = new QueryClient();
    seed(client, "draft", [item({ id: "r1" }), item({ id: "r2" })]);
    seed(client, "in_development", [item({ id: "r3", status: "in_development" })]);
    placeInColumns(client, item({ id: "r1", status: "in_development" }));
    expect(column(client, "draft")).toEqual(["r2"]);
    expect(column(client, "in_development")).toEqual(["r1", "r3"]);
  });

  it("新建的需求进入所属状态列（列头新建不会落到草稿）", () => {
    const client = new QueryClient();
    seed(client, "draft", []);
    seed(client, "ready_for_development", [item({ id: "r3", status: "ready_for_development" })]);
    placeInColumns(client, item({ id: "r9", status: "ready_for_development" }));
    expect(column(client, "draft")).toEqual([]);
    expect(column(client, "ready_for_development")).toEqual(["r9", "r3"]);
  });

  it("按编号在缓存中找到需求", () => {
    const client = new QueryClient();
    seed(client, "draft", [item({ id: "r1", number: 7 })]);
    client.setQueryData(requirementKeys.byNumber("p1", 7), "r1");
    expect(findCachedItem(client, (entry) => entry.number === 7)?.id).toBe("r1");
    expect(findCachedItem(client, "missing")).toBeUndefined();
  });
});
