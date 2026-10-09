import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_AGENT_ID } from "@suduo/client-contracts";

interface AgentSettingsFile {
  schemaVersion: 1;
  defaultAgentId: string;
  agents: Record<string, { enabled?: boolean; binOverride?: string | null; concurrency?: number }>;
  /** 合计并发上限（多 Agent 协作 S8）；没设为默认。 */
  globalConcurrency?: number;
}

const EMPTY: AgentSettingsFile = { schemaVersion: 1, defaultAgentId: DEFAULT_AGENT_ID, agents: {} };

/** 与 settings.json 同目录的 agent-settings.json（多 Agent S1）；不碰现有设置文件。 */
export function agentSettingsPathFor(settingsFilePath: string): string {
  return join(dirname(settingsFilePath), "agent-settings.json");
}

export interface AgentSettingEntry {
  enabled: boolean;
  binOverride: string | null;
  /** 用户设的并发上限；没设为 null（用配置表的默认值）。 */
  concurrency: number | null;
}

export class AgentSettingsStore {
  private state: AgentSettingsFile;

  constructor(private readonly filePath: string) {
    this.state = this.load();
  }

  defaultAgentId(): string {
    return this.state.defaultAgentId;
  }

  entry(agentId: string): AgentSettingEntry {
    const raw = this.state.agents[agentId] ?? {};
    return {
      enabled: raw.enabled ?? true,
      binOverride: typeof raw.binOverride === "string" && raw.binOverride.trim() !== "" ? raw.binOverride : null,
      concurrency: typeof raw.concurrency === "number" && Number.isSafeInteger(raw.concurrency) ? raw.concurrency : null,
    };
  }

  /** 用户设的合计并发上限；没设为 null。 */
  globalConcurrency(): number | null {
    const value = this.state.globalConcurrency;
    return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
  }

  update(input: {
    defaultAgentId?: string;
    agents?: Array<{ id: string; enabled?: boolean; binOverride?: string | null; concurrency?: number }>;
    globalConcurrency?: number;
  }): void {
    const next: AgentSettingsFile = {
      ...this.state,
      agents: { ...this.state.agents },
    };
    if (input.defaultAgentId !== undefined) {
      next.defaultAgentId = input.defaultAgentId;
    }
    if (input.globalConcurrency !== undefined) {
      next.globalConcurrency = input.globalConcurrency;
    }
    for (const change of input.agents ?? []) {
      const current = next.agents[change.id] ?? {};
      next.agents[change.id] = {
        ...current,
        ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
        ...(change.binOverride === undefined ? {} : { binOverride: change.binOverride }),
        ...(change.concurrency === undefined ? {} : { concurrency: change.concurrency }),
      };
    }
    this.write(next);
    this.state = next;
  }

  private load(): AgentSettingsFile {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<AgentSettingsFile>;
      return {
        schemaVersion: 1,
        defaultAgentId: typeof parsed.defaultAgentId === "string" && parsed.defaultAgentId !== "" ? parsed.defaultAgentId : DEFAULT_AGENT_ID,
        agents: parsed.agents !== null && typeof parsed.agents === "object" ? parsed.agents : {},
        ...(typeof parsed.globalConcurrency === "number" ? { globalConcurrency: parsed.globalConcurrency } : {}),
      };
    } catch {
      return { ...EMPTY, agents: {} };
    }
  }

  private write(state: AgentSettingsFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}
