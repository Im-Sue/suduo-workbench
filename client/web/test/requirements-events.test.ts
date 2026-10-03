import { describe, expect, it } from "vitest";
import { parseRequirementsEvent } from "../src/components/requirements-v2/requirements-events.js";

describe("需求 SSE 事件第一道关卡", () => {
  it("artifact.published 通过类型白名单，未知类型仍被拒绝", () => {
    const artifactPublished = JSON.stringify({
      id: "e1",
      type: "artifact.published",
      projectId: "p1",
      requirementId: "r1",
      requirementVersion: 8,
      occurredAt: "2026-08-23T00:00:00.000Z",
    });

    expect(parseRequirementsEvent(artifactPublished)).toMatchObject({
      type: "artifact.published",
      requirementId: "r1",
    });
    expect(parseRequirementsEvent(JSON.stringify({
      id: "e2",
      type: "artifact.archived",
      projectId: "p1",
      occurredAt: "2026-08-23T00:00:00.000Z",
    }))).toBeNull();
  });
});
