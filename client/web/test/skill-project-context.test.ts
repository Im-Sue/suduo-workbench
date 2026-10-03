import { describe, expect, it } from "vitest";
import {
  defaultSkillProjectId,
  skillProjectOptions,
} from "../src/features/settings/skill-project-context.js";

describe("Skill 项目上下文", () => {
  it("唯一的本机项目自动选择", () => {
    const projects = skillProjectOptions([
      { localProjectId: "local-1", localProjectName: "工作台", remoteProjectId: "remote-1" },
    ]);
    expect(defaultSkillProjectId(projects)).toBe("local-1");
  });

  it("无映射或多个本机项目时不臆测上下文", () => {
    expect(defaultSkillProjectId([])).toBeNull();
    expect(defaultSkillProjectId(skillProjectOptions([
      { localProjectId: "local-1", localProjectName: "工作台", remoteProjectId: "remote-1" },
      { localProjectId: "local-2", localProjectName: "另一项目", remoteProjectId: "remote-2" },
    ]))).toBeNull();
  });

  it("同一本机项目的多条远程映射只形成一个选择项", () => {
    const projects = skillProjectOptions([
      { localProjectId: "local-1", localProjectName: "工作台", remoteProjectId: "remote-1" },
      { localProjectId: "local-1", localProjectName: "工作台", remoteProjectId: "remote-2" },
    ]);
    expect(projects).toHaveLength(1);
    expect(defaultSkillProjectId(projects)).toBe("local-1");
  });
});
