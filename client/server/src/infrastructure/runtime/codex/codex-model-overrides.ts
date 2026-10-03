import type { CodexModelOptionDto, JsonValue } from "@suduo/client-contracts";

/**
 * 会话级模型 / 推理强度的「粘性覆盖」追踪。
 *
 * Codex 的 turn/start `model` / `effort` 是「本回合及后续回合」生效的线程级覆盖（0.143 实测，0.159 相同），
 * 而且 `effort` 只能设成具体值、不能用 null 清掉。于是：
 * - 会话指定了值：线程当前值不同才下发；
 * - 会话改回「跟随默认」：只要本进程在这个线程上下发过显式值（或 resume 后无从得知），
 *   就显式下发全局默认把覆盖改回来；从没覆盖过则什么都不传，保持 Codex 原生行为。
 *
 * 全局默认的来源依次为：config/read 的 `model` / `model_reasoning_effort`（含项目层），
 * model/list 的默认模型与模型自身默认强度，最后是新建线程时 thread/start 回报的生效值。
 * 都拿不到时本回合不下发（沿用上次显式值）并返回告警，由调用方记日志。
 */

export interface CodexModelDefaults {
  /** 全局默认模型：config.model，未配置时取 model/list 的默认模型；都拿不到为 null。 */
  model: string | null;
  /** config.toml 的 model_reasoning_effort；null = 未配置（Codex 用模型自身默认）。 */
  configuredEffort: string | null;
  /** 模型自身的默认推理强度（model/list defaultReasoningEffort），不在目录里为 null。 */
  modelDefaultEffort(model: string): string | null;
}

export interface TurnModelOverrides {
  model?: string;
  effort?: string;
}

export interface TurnModelPlan {
  overrides: TurnModelOverrides;
  warnings: string[];
}

type Pinned = boolean | "unknown";

interface ThreadModelState {
  connectionId: string;
  /**
   * 线程当前生效值：thread/start|resume 回报、thread/settings/updated 通知或我方上次下发。
   * undefined = 未知（下发结果不确定、配置被改写后）；effort 的 null = 已知在用模型自身默认强度。
   */
  model: string | undefined;
  effort: string | null | undefined;
  /** 我方是否在该线程上下发过显式覆盖；resume 后无从得知时为 "unknown"。 */
  modelPinned: Pinned;
  effortPinned: Pinned;
  /** 新建线程时回报的生效值（即当时的全局默认），默认值解析失败时作回退；resume 线程为 null。 */
  baselineModel: string | null;
  baselineEffort: string | null;
}

export class CodexThreadModelTracker {
  private readonly threads = new Map<string, ThreadModelState>();

  recordThreadStart(input: {
    connectionId: string;
    threadId: string;
    mode: "create" | "resume";
    model: string | null;
    effort: string | null;
  }): void {
    const created = input.mode === "create";
    this.threads.set(input.threadId, {
      connectionId: input.connectionId,
      model: input.model ?? undefined,
      // 回报里的 reasoningEffort=null 是权威的「用模型自身默认」。
      effort: input.effort,
      modelPinned: created ? false : "unknown",
      effortPinned: created ? false : "unknown",
      baselineModel: created ? input.model : null,
      baselineEffort: created ? input.effort : null,
    });
  }

  /** thread/settings/updated 是线程当前设置的权威回报，只更新现值、不改「是否覆盖过」。 */
  recordSettings(input: {
    connectionId: string;
    threadId: string;
    model: JsonValue | undefined;
    effort: JsonValue | undefined;
  }): void {
    const state = this.stateFor(input.connectionId, input.threadId);
    if (!state) {
      return;
    }
    if (typeof input.model === "string" && input.model !== "") {
      state.model = input.model;
    }
    if (input.effort === null || (typeof input.effort === "string" && input.effort !== "")) {
      state.effort = input.effort;
    }
  }

  async plan(input: {
    connectionId: string;
    threadId: string;
    model: string | null | undefined;
    effort: string | null | undefined;
    loadDefaults(): Promise<CodexModelDefaults | null>;
  }): Promise<TurnModelPlan> {
    const overrides: TurnModelOverrides = {};
    const warnings: string[] = [];
    if (input.model === undefined && input.effort === undefined) {
      return { overrides, warnings };
    }
    const state = this.stateFor(input.connectionId, input.threadId);
    let defaults: Promise<CodexModelDefaults | null> | null = null;
    const loadDefaults = () => (defaults ??= input.loadDefaults());

    if (typeof input.model === "string") {
      if (state?.model !== input.model) {
        overrides.model = input.model;
      }
    } else if (input.model === null && state !== undefined && state.modelPinned !== false) {
      const resolved = await loadDefaults();
      const target = resolved?.model ?? state.baselineModel;
      if (target === null) {
        if (state.modelPinned === true || state.model === undefined) {
          warnings.push(
            "无法确定全局默认模型，本回合不下发模型，线程可能仍沿用此前的覆盖值 " +
              String(state.model ?? "（未知）"),
          );
        }
      } else if (state.model !== target) {
        overrides.model = target;
      } else if (state.modelPinned === "unknown") {
        state.modelPinned = false;
      }
    }

    if (typeof input.effort === "string") {
      if (state?.effort !== input.effort) {
        overrides.effort = input.effort;
      }
    } else if (input.effort === null && state !== undefined && state.effortPinned !== false) {
      const resolved = await loadDefaults();
      const configured = resolved?.configuredEffort ?? null;
      if (resolved !== null && configured === null && state.effort === null) {
        // 已知线程正按模型自身默认强度运行，已等于「跟随默认」（现值未知时不能走这条捷径）。
        if (state.effortPinned === "unknown") {
          state.effortPinned = false;
        }
      } else {
        const turnModel = overrides.model ?? state.model;
        const modelDefault =
          turnModel === undefined || resolved === null
            ? null
            : resolved.modelDefaultEffort(turnModel);
        const target = configured ?? modelDefault ?? state.baselineEffort;
        if (target === null) {
          if (state.effortPinned === true || state.effort === undefined) {
            warnings.push(
              "无法确定全局默认推理强度，本回合不下发强度，线程可能仍沿用此前的覆盖值 " +
                String(state.effort ?? "（未知）"),
            );
          }
        } else if (state.effort !== target) {
          overrides.effort = target;
        } else if (state.effortPinned === "unknown") {
          state.effortPinned = false;
        }
      }
    }
    return { overrides, warnings };
  }

  /** turn/start 成功：下发的值成为线程现值，且该维度此后视为「已显式覆盖」。 */
  recordSent(connectionId: string, threadId: string, overrides: TurnModelOverrides): void {
    if (overrides.model === undefined && overrides.effort === undefined) {
      return;
    }
    const state = this.ensureState(connectionId, threadId);
    if (overrides.model !== undefined) {
      state.model = overrides.model;
      state.modelPinned = true;
    }
    if (overrides.effort !== undefined) {
      state.effort = overrides.effort;
      state.effortPinned = true;
    }
  }

  /** turn/start 结果不确定：覆盖可能已生效也可能没有，现值记为未知，下回合重新判断并补发。 */
  markUncertain(connectionId: string, threadId: string, overrides: TurnModelOverrides): void {
    if (overrides.model === undefined && overrides.effort === undefined) {
      return;
    }
    const state = this.ensureState(connectionId, threadId);
    if (overrides.model !== undefined) {
      state.model = undefined;
      state.modelPinned = "unknown";
    }
    if (overrides.effort !== undefined) {
      state.effort = undefined;
      state.effortPinned = "unknown";
    }
  }

  /**
   * 全局模型配置被改写后（config/batchWrite 涉及 model / profile 相关键）：已加载线程是否跟着变
   * 取决于 Codex，无从得知。把该连接上所有线程的现值记为未知、基线作废，但保留「是否由我方覆盖过」：
   * - 显式指定的会话下回合会重新下发（现值未知必然不等于目标）；
   * - 我方覆盖过、现已跟随默认的会话会显式下发新默认；
   * - 从没覆盖过的会话仍不下发，完全交给 Codex 原生的配置生效方式。
   */
  markAllUnknown(connectionId: string): void {
    for (const state of this.threads.values()) {
      if (state.connectionId !== connectionId) {
        continue;
      }
      state.model = undefined;
      state.effort = undefined;
      state.baselineModel = null;
      state.baselineEffort = null;
    }
  }

  private stateFor(connectionId: string, threadId: string): ThreadModelState | undefined {
    const state = this.threads.get(threadId);
    return state !== undefined && state.connectionId === connectionId ? state : undefined;
  }

  private ensureState(connectionId: string, threadId: string): ThreadModelState {
    const existing = this.stateFor(connectionId, threadId);
    if (existing) {
      return existing;
    }
    const state: ThreadModelState = {
      connectionId,
      model: undefined,
      effort: undefined,
      modelPinned: "unknown",
      effortPinned: "unknown",
      baselineModel: null,
      baselineEffort: null,
    };
    this.threads.set(threadId, state);
    return state;
  }
}

export function createCodexModelDefaults(input: {
  configuredModel: string | null;
  configuredEffort: string | null;
  catalog: readonly CodexModelOptionDto[];
}): CodexModelDefaults {
  const catalogDefault = input.catalog.find((entry) => entry.isDefault);
  const efforts = new Map<string, string>();
  for (const entry of input.catalog) {
    if (entry.defaultReasoningEffort !== null) {
      efforts.set(entry.model, entry.defaultReasoningEffort);
      efforts.set(entry.id, entry.defaultReasoningEffort);
    }
  }
  return {
    model: input.configuredModel ?? catalogDefault?.model ?? null,
    configuredEffort: input.configuredEffort,
    modelDefaultEffort: (model) => efforts.get(model) ?? null,
  };
}

/** 解析 model/list 的 data 项（Codex `Model`）；形状不对的条目跳过。 */
export function parseCodexModelCatalog(data: readonly JsonValue[]): CodexModelOptionDto[] {
  const entries: CodexModelOptionDto[] = [];
  for (const item of data) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const id = item["id"];
    if (typeof id !== "string" || id === "") {
      continue;
    }
    const model = typeof item["model"] === "string" && item["model"] !== "" ? item["model"] : id;
    const supported = Array.isArray(item["supportedReasoningEfforts"])
      ? item["supportedReasoningEfforts"].flatMap((option) => {
          if (typeof option === "string") return [option];
          if (option !== null && typeof option === "object" && !Array.isArray(option)) {
            const effort = option["reasoningEffort"];
            return typeof effort === "string" && effort !== "" ? [effort] : [];
          }
          return [];
        })
      : [];
    const defaultEffort = item["defaultReasoningEffort"];
    entries.push({
      id,
      model,
      displayName:
        typeof item["displayName"] === "string" && item["displayName"] !== ""
          ? item["displayName"]
          : id,
      isDefault: item["isDefault"] === true,
      supportedReasoningEfforts: supported,
      defaultReasoningEffort:
        typeof defaultEffort === "string" && defaultEffort !== "" ? defaultEffort : null,
    });
  }
  return entries;
}
