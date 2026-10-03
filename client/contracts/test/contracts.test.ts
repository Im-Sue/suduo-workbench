import { describe, expect, expectTypeOf, it } from "vitest";
import { CODEX_VERSION, M1_RUNTIME_SECURITY_POLICY, SUDUO_DEFAULTS } from "../src/index.js";
import type { AgentRuntime, ApproveInput, ApproveResult, CodexTransportFactory, RpcConnection, RuntimeEvent, RuntimeSubscribeOptions, StartThreadInput, StartThreadResult, StartTurnInput, StartTurnResult } from "../src/index.js";

describe("共享契约", () => {
  it("锁定 Codex 版本与 M1 安全默认值", () => {
    expect(CODEX_VERSION).toBe("0.159.2");
    expect(SUDUO_DEFAULTS.host).toBe("127.0.0.1");
    expect(M1_RUNTIME_SECURITY_POLICY.sandbox.mode).toBe("read-only");
  });
  it("保持 AgentRuntime 五方法签名", () => {
    expectTypeOf<AgentRuntime["startThread"]>().toEqualTypeOf<(input: StartThreadInput) => Promise<StartThreadResult>>();
    expectTypeOf<AgentRuntime["startTurn"]>().toEqualTypeOf<(input: StartTurnInput) => Promise<StartTurnResult>>();
    expectTypeOf<AgentRuntime["approve"]>().toEqualTypeOf<(input: ApproveInput) => Promise<ApproveResult>>();
    expectTypeOf<AgentRuntime["subscribe"]>().toEqualTypeOf<(options: RuntimeSubscribeOptions) => AsyncIterable<RuntimeEvent>>();
  });
  it("保持 transport 工厂连接契约", () => {
    expectTypeOf<CodexTransportFactory["connect"]>().returns.toEqualTypeOf<Promise<RpcConnection>>();
  });
});
