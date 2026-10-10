import type { JsonValue } from "./events.js";

/**
 * SuDuo 自己的自检项的稳定 id（前端按它分组、取版本，不看按语言生成的名称）。
 * Codex 官方检查项用官方的 check id（如 auth.credentials、network.provider_reachability），
 * 它们没有 suduo. 前缀，不会冲突。
 */
export const SUDUO_DOCTOR_CHECK_IDS = {
  node: "suduo.node",
  pnpm: "suduo.pnpm",
  /** Codex 官方诊断的汇总项（含 codex doctor --json 跑不起来、解析失败）。 */
  codexDoctor: "suduo.codex-doctor",
  /** codex doctor --json 一项也没返回。 */
  codexDoctorEmpty: "suduo.codex-doctor-empty",
  codexCli: "suduo.codex-cli",
  linuxSandbox: "suduo.linux-sandbox",
  sqlite: "suduo.sqlite",
  port: "suduo.port",
  /** 一家 Agent（多 Agent S12）：可执行文件、版本（在不在验证过的范围）、登录状态；按 agentId 分组。 */
  agent: "suduo.agent",
  /** SuDuo 本机工具服务（ADR-0015）：Codex 以外的 Agent 经它用需求、会话、委派等工具。 */
  toolServer: "suduo.tool-server",
  /** Git（桌面应用 D2）：检查点等功能要用；没装只提醒，不拦启动。 */
  git: "suduo.git",
} as const;

export type SuDuoDoctorCheckId = (typeof SUDUO_DOCTOR_CHECK_IDS)[keyof typeof SUDUO_DOCTOR_CHECK_IDS];

/** 本机自检的一项（GET /api/v1/doctor）。name、message、remediation 按请求语言生成。 */
export interface DoctorCheckDto {
  /** SuDuo 自己的项见 SUDUO_DOCTOR_CHECK_IDS；Codex 官方项是官方的 check id。 */
  id: string;
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  category?: string;
  /** 官方已脱敏详情，供诊断页按需展示。 */
  details?: JsonValue;
  remediation?: string | null;
  /** 保留官方状态（ok / warning / fail），不把 warning 伪装为 pass。 */
  officialStatus?: string;
  /** Codex CLI 与各家 Agent 的项有：读到的版本，没读到为 null。 */
  version?: string | null;
  /** 属于哪家 Agent（Codex 的各项是 codex）；SuDuo 自己的环境项没有。诊断页与命令行按它分组。 */
  agentId?: string;
}

export interface DoctorResultDto {
  status: "PASS" | "FAIL";
  codexHome: string;
  platform: string;
  mode: "installed" | "source";
  configDir: string;
  dataDir: string;
  port: number;
  checkedAt: string;
  checks: DoctorCheckDto[];
}
