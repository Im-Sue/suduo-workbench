import { describe, expect, it } from "vitest";
import { summarizeDoctor } from "../src/app/pages/doctor-summary.js";
import { pickProject } from "../src/app/project-context.js";
import { projectSectionOf } from "../src/app/shell/ProjectSwitcher.js";
import { sectionOf } from "../src/app/shell/Sidebar.js";

const project = (id: string, isArchived = false) => ({
  id,
  name: id,
  isArchived,
  createdBy: { id: "u", displayName: "U" },
  updatedBy: { id: "u", displayName: "U" },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  version: 1,
});

describe("pickProject", () => {
  const projects = [project("archived", true), project("a"), project("b")];

  it("优先路由指定的项目，其次上次使用，最后第一个未归档项目", () => {
    expect(pickProject(projects, "b", "a")?.id).toBe("b");
    expect(pickProject(projects, "missing", "a")?.id).toBe("a");
    expect(pickProject(projects, null, null)?.id).toBe("a");
    expect(pickProject([], null, null)).toBeNull();
  });
});

describe("路径分区", () => {
  it("识别导航分区与项目分区", () => {
    expect(sectionOf("/my")).toBe("my");
    expect(sectionOf("/p/x/requirements/r1")).toBe("requirements");
    expect(sectionOf("/p/x/overview")).toBe("overview");
    expect(sectionOf("/sessions/s1")).toBe("sessions");
    expect(sectionOf("/settings")).toBe("settings");
    expect(projectSectionOf("/p/x/requirements/r1")).toBe("requirements");
    expect(projectSectionOf("/p/x/rooms")).toBe("rooms");
    expect(projectSectionOf("/p/x/rooms/room-1")).toBe("rooms");
    expect(projectSectionOf("/sessions")).toBeNull();
  });
});

describe("summarizeDoctor", () => {
  it("把技术检查汇总成四条用户能读懂的结论", () => {
    const summary = summarizeDoctor([
      { name: "Codex CLI", status: "pass", message: "codex-cli 0.159.2（workspace 锁定版本）" },
      { name: "Codex · auth · auth.credentials", status: "fail", message: "no Codex credentials were found" },
      { name: "Codex · reachability · network.provider_reachability", status: "pass", message: "ok" },
      { name: "Codex · websocket · network.websocket_reachability", status: "fail", message: "failed" },
      { name: "Node.js", status: "fail", message: "需要 24.10.0，当前为 24.21.0" },
    ]);
    expect(summary.map((item) => [item.key, item.status])).toEqual([
      ["codex", "ok"],
      ["model", "warn"],
      ["network", "ok"],
      ["runtime", "warn"],
    ]);
    expect(summary[0]?.detail).toBe("已安装，版本 0.159.2");
    expect(summary[1]?.settingsSection).toBe("model");
  });

  it("新版官方诊断在可达性一项里报的 warning（桌面端更新 CDN 不可达）不算连不上模型服务", () => {
    const summary = summarizeDoctor([
      { name: "Codex · reachability · network.provider_reachability", status: "warn", message: "desktop update and runtime CDN is unreachable" },
    ]);
    expect(summary.find((item) => item.key === "network")).toMatchObject({ status: "ok" });
  });

  it("Linux 上沙箱起不来时单列一条「命令沙箱」；没有这项检查（非 Linux）时不出现", () => {
    const failing = summarizeDoctor([
      { name: "Codex 沙箱（Linux）", status: "warn", message: "Codex 的沙箱在这台机器上起不来" },
    ]);
    expect(failing.find((item) => item.key === "sandbox")).toMatchObject({ status: "warn", detail: "Codex 的沙箱在这台机器上起不来" });
    expect(summarizeDoctor([]).some((item) => item.key === "sandbox")).toBe(false);
  });

  it("模型服务不可达时网络判为失败并指向代理设置", () => {
    const summary = summarizeDoctor([
      { name: "Codex · reachability · network.provider_reachability", status: "fail", message: "timeout" },
    ]);
    expect(summary.find((item) => item.key === "network")).toMatchObject({ status: "fail", settingsSection: "proxy" });
  });
});
