import type { UserSummaryDto } from "./auth.js";
import type { RequirementStatus } from "./status.js";

export const PROJECT_STATS_WINDOWS = ["7d", "30d"] as const;

export type ProjectStatsWindow = (typeof PROJECT_STATS_WINDOWS)[number];

export interface ProjectStatsQuery {
  window: ProjectStatsWindow;
  tz: string;
}

/**
 * 各状态「多久没变化算停滞」（天）：按流程节奏定，不用统一的天数。
 * notice = 该推进了；warning = 停滞较久；null = 这一档不提醒。已完成不算停滞；
 * 暂缓超过 30 天没动会列在概览的停滞里，但没有「停滞较久」一档、不进「需要你处理」（是恢复还是关掉，由人来定）。
 * 服务端筛选、概览的停滞列表、我的工作里的提醒都用这一张表。
 */
export const STALE_RHYTHM: Readonly<Record<RequirementStatus, { notice: number; warning: number | null } | null>> = {
  draft: { notice: 14, warning: 30 },
  in_refinement: { notice: 7, warning: 14 },
  ready_for_development: { notice: 7, warning: 14 },
  in_development: { notice: 3, warning: 7 },
  in_testing: { notice: 3, warning: 7 },
  completed: null,
  on_hold: { notice: 30, warning: null },
};

export const STALE_REQUIREMENT_LEVELS = [
  "normal",
  "notice",
  "warning",
] as const;

export type StaleRequirementLevel =
  (typeof STALE_REQUIREMENT_LEVELS)[number];

/** 按 STALE_RHYTHM 判断停滞程度。 */
export function staleLevel(status: RequirementStatus, staleDays: number): StaleRequirementLevel {
  const rhythm = STALE_RHYTHM[status];
  if (rhythm === null) return "normal";
  const days = Math.max(0, staleDays);
  if (rhythm.warning !== null && days >= rhythm.warning) return "warning";
  return days >= rhythm.notice ? "notice" : "normal";
}

export interface StaleRequirementDto {
  id: string;
  /** 项目内编号（REQ-12）。旧版需求服务不返回，前端需回退到 id。 */
  number?: number;
  title: string;
  status: RequirementStatus;
  staleDays: number;
  level: StaleRequirementLevel;
  lastUpdatedBy: UserSummaryDto;
  updatedAt: string;
}

export interface DailyRequirementTransitionDto {
  date: string;
  count: number;
  /** 当天进入各状态的次数（按变更后的状态计）；没有进入的状态不出现。旧版需求服务不返回。 */
  byStatus?: Partial<Record<RequirementStatus, number>>;
}

export interface ProjectStatsResponse {
  statusCounts: Record<RequirementStatus, number>;
  /** 按 STALE_RHYTHM 算出的停滞需求：停滞较久的在前，同档按没动的时间从长到短，最多 10 条。 */
  staleRequirements: StaleRequirementDto[];
  /** 符合停滞条件的总数（可能多于 staleRequirements 的条数）。旧版需求服务不返回。 */
  staleTotal?: number;
  transitions: DailyRequirementTransitionDto[];
}
