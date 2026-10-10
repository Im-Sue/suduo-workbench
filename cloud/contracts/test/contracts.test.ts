import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AUDIT_ACTIONS,
  RECORDED_AUDIT_ACTIONS,
  ROOM_AUDIT_ACTIONS,
  REQUIREMENT_ACTIVITY_ACTIONS,
  REQUIREMENTS_V2_SCHEMAS,
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_COMMENT_MAX_FILES,
  AI_COLLAB_AUDIT_ACTIONS,
  CLOUD_FEATURES,
  formatRequirementNumber,
  parseRequirementNumberQuery,
  parseRequirementPriorityFilter,
  requirementPriorityFromRank,
  requirementPriorityRank,
} from "../src/index.js";
import type {
  CommentDto,
  CommentFileDto,
  CreateCommentRequest,
  CreateRequirementRequest,
  RequirementActivityEntryDto,
  RequirementDto,
  RequirementPriority,
  UpdateProjectRequest,
  UpdateRequirementRequest,
  UserSummaryDto,
} from "../src/index.js";

describe("需求编号", () => {
  it("展示为 REQ-<编号>", () => {
    expect(formatRequirementNumber(128)).toBe("REQ-128");
  });

  it("识别纯数字、REQ- 前缀（不分大小写）、空格与 # 形式", () => {
    for (const input of ["128", "REQ-128", "req-128", "Req128", "REQ 128", "#128", " 128 ", "0128"]) {
      expect(parseRequirementNumberQuery(input), input).toBe(128);
    }
  });

  it("非编号形态与越界值返回 null", () => {
    for (const input of ["", "0", "REQ-", "REQ-12a", "登录 128", "1234567890", "-1", "12.5"]) {
      expect(parseRequirementNumberQuery(input), input).toBeNull();
    }
  });
});

describe("需求 DTO 与请求", () => {
  it("需求 DTO 带编号、负责人与计数；评论与附件计数", () => {
    expectTypeOf<RequirementDto["number"]>().toEqualTypeOf<number>();
    expectTypeOf<RequirementDto["assignee"]>().toEqualTypeOf<UserSummaryDto | null>();
    expectTypeOf<RequirementDto["commentCount"]>().toEqualTypeOf<number>();
    expectTypeOf<RequirementDto["attachmentCount"]>().toEqualTypeOf<number>();
  });

  it("创建时描述可省略，创建与更新都可设置或清空负责人", () => {
    expectTypeOf<{ title: string }>().toMatchTypeOf<CreateRequirementRequest>();
    expectTypeOf<{ assigneeId: null }>().toMatchTypeOf<UpdateRequirementRequest>();
    expect(REQUIREMENTS_V2_SCHEMAS.createRequirement.required).toEqual(["title"]);
    expect(REQUIREMENTS_V2_SCHEMAS.createRequirement.properties.summary.minLength).toBe(0);
    expect(REQUIREMENTS_V2_SCHEMAS.updateRequirement.anyOf).toContainEqual({
      required: ["assigneeId"],
    });
  });

  it("项目改名 / 归档不带 expectedVersion，至少提供一个字段", () => {
    expectTypeOf<UpdateProjectRequest>().toEqualTypeOf<{ name?: string; isArchived?: boolean }>();
    expect(REQUIREMENTS_V2_SCHEMAS.updateProject).not.toHaveProperty("required");
    expect(Object.keys(REQUIREMENTS_V2_SCHEMAS.updateProject.properties)).toEqual([
      "name",
      "isArchived",
    ]);
    expect(REQUIREMENTS_V2_SCHEMAS.updateProject.anyOf).toEqual([
      { required: ["name"] },
      { required: ["isArchived"] },
    ]);
  });

  it("优先级可设置、可清空；更新至少一个字段时可以只改优先级", () => {
    expectTypeOf<RequirementDto["priority"]>().toEqualTypeOf<RequirementPriority | null | undefined>();
    expectTypeOf<{ priority: null }>().toMatchTypeOf<UpdateRequirementRequest>();
    expectTypeOf<{ title: string; priority: "urgent" }>().toMatchTypeOf<CreateRequirementRequest>();
    expect(REQUIREMENTS_V2_SCHEMAS.updateRequirement.anyOf).toContainEqual({ required: ["priority"] });
    expect(REQUIREMENTS_V2_SCHEMAS.createRequirement.properties.priority.enum).toEqual([
      "urgent",
      "high",
      "medium",
      "low",
      null,
    ]);
  });

  it("优先级筛选接受逗号分隔的档位与 none，排序只有 updated / priority", () => {
    const pattern = new RegExp(REQUIREMENTS_V2_SCHEMAS.listRequirements.properties.priority.pattern, "u");
    for (const value of ["urgent", "none", "urgent,high,none", "low,low"]) {
      expect(pattern.test(value), value).toBe(true);
    }
    for (const value of ["", "urgent,", ",high", "critical", "urgent high", "URGENT"]) {
      expect(pattern.test(value), value).toBe(false);
    }
    expect(REQUIREMENTS_V2_SCHEMAS.listRequirements.properties.sort.enum).toEqual(["updated", "priority"]);
    expect(parseRequirementPriorityFilter("urgent,none,urgent")).toEqual(["urgent", "none"]);
    expect(parseRequirementPriorityFilter("urgent,critical")).toBeNull();
  });

  it("优先级排序权重：越急越大，无为 0，可还原", () => {
    expect(REQUIREMENT_PRIORITIES.map(requirementPriorityRank)).toEqual([4, 3, 2, 1]);
    expect(requirementPriorityRank(null)).toBe(0);
    expect(requirementPriorityRank(undefined)).toBe(0);
    for (const priority of REQUIREMENT_PRIORITIES) {
      expect(requirementPriorityFromRank(requirementPriorityRank(priority))).toBe(priority);
    }
    expect(requirementPriorityFromRank(0)).toBeNull();
    expect(requirementPriorityFromRank(9)).toBeNull();
  });

  it("负责人筛选只接受 me、none 或用户 id", () => {
    const pattern = new RegExp(REQUIREMENTS_V2_SCHEMAS.listRequirements.properties.assignee.pattern, "u");
    expect(pattern.test("me")).toBe(true);
    expect(pattern.test("none")).toBe(true);
    expect(pattern.test("7f1c2d3e-0a1b-4c2d-8e3f-123456789abc")).toBe(true);
    expect(pattern.test("someone")).toBe(false);
    expect(pattern.test("me,none")).toBe(false);
  });
});

describe("评论文件", () => {
  it("发评论：正文与文件至少一样，文件至多 10 个；云端声明支持评论文件", () => {
    const schema = REQUIREMENTS_V2_SCHEMAS.createComment;
    expect(schema).not.toHaveProperty("required");
    expect(schema.anyOf).toEqual([{ required: ["body"] }, { required: ["fileIds"] }]);
    expect(schema.properties.body.minLength).toBe(0);
    expect(schema.properties.fileIds.maxItems).toBe(REQUIREMENT_COMMENT_MAX_FILES);
    expect(REQUIREMENT_COMMENT_MAX_FILES).toBe(10);
    expect(CLOUD_FEATURES).toEqual(["requirement_priority", "comment_files", "agent_kinds_v2", "ai_collab_v1"]);
    expectTypeOf<{ fileIds: string[] }>().toMatchTypeOf<CreateCommentRequest>();
    expectTypeOf<CommentDto["files"]>().toEqualTypeOf<CommentFileDto[] | undefined>();
  });
});

describe("活动时间线", () => {
  it("收录的动作都是服务端记录的审计动作，且不含下载", () => {
    expect(RECORDED_AUDIT_ACTIONS).toEqual([
      ...AUDIT_ACTIONS,
      "requirement.assignee_changed",
      "requirement.priority_changed",
      ...ROOM_AUDIT_ACTIONS,
      ...AI_COLLAB_AUDIT_ACTIONS,
    ]);
    // 多 Agent 协作的动作同房间，不进 /v2/audit 的契约动作表，也不进需求活动时间线（在「AI 协作」区看）。
    for (const action of AI_COLLAB_AUDIT_ACTIONS) {
      expect(AUDIT_ACTIONS).not.toContain(action);
      expect(REQUIREMENT_ACTIVITY_ACTIONS).not.toContain(action);
    }
    // 过渡期：负责人变更不进 /v2/audit 的契约动作表，避免旧界面穷举文案表编译失败。
    expect(AUDIT_ACTIONS).not.toContain("requirement.assignee_changed");
    expect(AUDIT_ACTIONS).not.toContain("requirement.priority_changed");
    for (const action of REQUIREMENT_ACTIVITY_ACTIONS) {
      expect(RECORDED_AUDIT_ACTIONS).toContain(action);
    }
    expect(REQUIREMENT_ACTIVITY_ACTIONS).not.toContain("attachment.downloaded");
    expect(REQUIREMENT_ACTIVITY_ACTIONS.some((action) => action.startsWith("project."))).toBe(false);
  });

  it("条目不带审计原始前后值", () => {
    expectTypeOf<RequirementActivityEntryDto>().not.toHaveProperty("before");
    expectTypeOf<RequirementActivityEntryDto>().not.toHaveProperty("after");
  });
});
