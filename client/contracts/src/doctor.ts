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
  /** 只有 Codex CLI 一项有：官方诊断报的 Codex 版本，没报为 null。 */
  version?: string | null;
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
