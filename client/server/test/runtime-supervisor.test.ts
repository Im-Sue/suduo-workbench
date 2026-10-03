import { describe, expect, it, vi } from "vitest";
import type {
  RuntimeRegistry,
  StartThreadInput,
  StartThreadResult,
} from "@suduo/client-contracts";
import { RuntimeSupervisor } from "../src/application/runtime-supervisor.js";
import type { ProjectRecord } from "../src/infrastructure/db/repositories/project-repository.js";
import { sharedWorkspace } from "../src/application/workspace-context.js";
import type { SessionRecord } from "../src/infrastructure/db/repositories/session-repository.js";
import type { SessionThreadRecord } from "../src/infrastructure/db/repositories/session-thread-repository.js";

const REBUILT: StartThreadResult = {
  primaryThread: {
    threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "t-new" },
    role: "primary",
    metadata: null,
  },
  threads: [
    {
      threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "t-new" },
      role: "primary",
      metadata: null,
    },
  ],
};

function makeSupervisor(behavior: {
  resumeFails: boolean;
  createFails: boolean;
  calls: string[];
  seenInputs?: StartThreadInput[];
}): RuntimeSupervisor {
  const registry = {
    get: () => ({
      startThread: (input: StartThreadInput): Promise<StartThreadResult> => {
        behavior.calls.push(input.mode);
        behavior.seenInputs?.push(input);
        if (input.mode === "resume") {
          return behavior.resumeFails
            ? Promise.reject(new Error("rollout not found"))
            : Promise.resolve(REBUILT);
        }
        return behavior.createFails
          ? Promise.reject(new Error("runtime down"))
          : Promise.resolve(REBUILT);
      },
    }),
  } as unknown as RuntimeRegistry;
  return new RuntimeSupervisor(registry);
}

const input = {
  session: { id: "s1" } as SessionRecord,
  workspace: sharedWorkspace({ id: "p1", rootPath: "/tmp/p1" } as ProjectRecord, "s1"),
  binding: {
    id: "b1",
    sessionId: "s1",
    threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "t-old" },
    role: "primary",
    ordinal: 0,
    primary: true,
    state: "attached",
  } as SessionThreadRecord,
};

describe("RuntimeSupervisor.ensureReadyOrRebuild", () => {
  it("resume 成功 → 返回 null，不重建", async () => {
    const calls: string[] = [];
    const supervisor = makeSupervisor({ resumeFails: false, createFails: false, calls });
    expect(await supervisor.ensureReadyOrRebuild(input)).toBeNull();
    expect(calls).toEqual(["resume"]);
  });

  it("resume 失败 → 自动重建并返回新 thread；重建后线程即 ready", async () => {
    const calls: string[] = [];
    const supervisor = makeSupervisor({ resumeFails: true, createFails: false, calls });
    const result = await supervisor.ensureReadyOrRebuild(input);
    expect(result?.primaryThread.threadRef.threadId).toBe("t-new");
    expect(calls).toEqual(["resume", "create"]);
    // 新 thread 已标记 ready：换成新绑定后不再触发 resume。
    const next = await supervisor.ensureReadyOrRebuild({
      ...input,
      binding: {
        ...input.binding,
        threadRef: REBUILT.primaryThread.threadRef,
      },
    });
    expect(next).toBeNull();
    expect(calls).toEqual(["resume", "create"]);
  });

  it("resume 与重建都失败 → 抛出原始 resume 错误", async () => {
    const calls: string[] = [];
    const supervisor = makeSupervisor({ resumeFails: true, createFails: true, calls });
    await expect(supervisor.ensureReadyOrRebuild(input)).rejects.toThrow(
      "恢复 runtime thread 失败",
    );
    expect(calls).toEqual(["resume", "create"]);
  });

  it("需求卡与工具：create 与 rebuild 携带 developerInstructions / dynamicTools，resume 不带", async () => {
    const calls: string[] = [];
    const seenInputs: StartThreadInput[] = [];
    const supervisor = makeSupervisor({
      resumeFails: true,
      createFails: false,
      calls,
      seenInputs,
    });
    const rebuildSetup = vi.fn(async () => ({
      developerInstructions: "本会话关联需求「材价采集失败重试」",
      dynamicTools: [{ name: "suduo_requirement_get", description: "查需求", inputSchema: { type: "object" } }],
    }));
    await supervisor.ensureReadyOrRebuild({
      ...input,
      rebuildSetup,
    });
    const [resumeInput, createInput] = seenInputs;
    expect(resumeInput?.mode).toBe("resume");
    expect(resumeInput?.developerInstructions).toBeUndefined();
    expect(createInput?.mode).toBe("create");
    expect(createInput?.developerInstructions).toContain("材价采集失败重试");
    expect(createInput?.dynamicTools?.map((tool) => tool.name)).toEqual(["suduo_requirement_get"]);
    expect(rebuildSetup).toHaveBeenCalledTimes(1);

    seenInputs.length = 0;
    await supervisor.createPrimaryThread({
      runtimeId: "codex-local",
      session: input.session,
      workspace: input.workspace,
      developerInstructions: "简报内容",
    });
    expect(seenInputs[0]?.developerInstructions).toBe("简报内容");
  });
});
