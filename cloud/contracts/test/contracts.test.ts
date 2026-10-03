import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AUDIT_ACTIONS,
  RECORDED_AUDIT_ACTIONS,
  ROOM_AUDIT_ACTIONS,
  REQUIREMENT_ACTIVITY_ACTIONS,
  REQUIREMENTS_V2_SCHEMAS,
  formatRequirementNumber,
  parseRequirementNumberQuery,
} from "../src/index.js";
import type {
  CreateRequirementRequest,
  RequirementActivityEntryDto,
  RequirementDto,
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

  it("负责人筛选只接受 me、none 或用户 id", () => {
    const pattern = new RegExp(REQUIREMENTS_V2_SCHEMAS.listRequirements.properties.assignee.pattern, "u");
    expect(pattern.test("me")).toBe(true);
    expect(pattern.test("none")).toBe(true);
    expect(pattern.test("7f1c2d3e-0a1b-4c2d-8e3f-123456789abc")).toBe(true);
    expect(pattern.test("someone")).toBe(false);
    expect(pattern.test("me,none")).toBe(false);
  });
});

describe("活动时间线", () => {
  it("收录的动作都是服务端记录的审计动作，且不含下载", () => {
    expect(RECORDED_AUDIT_ACTIONS).toEqual([
      ...AUDIT_ACTIONS,
      "requirement.assignee_changed",
      ...ROOM_AUDIT_ACTIONS,
    ]);
    // 过渡期：负责人变更不进 /v2/audit 的契约动作表，避免旧界面穷举文案表编译失败。
    expect(AUDIT_ACTIONS).not.toContain("requirement.assignee_changed");
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
