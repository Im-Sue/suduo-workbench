/**
 * 需求优先级，从急到缓。「无优先级」用 null 表示，不在这个列表里（需求附件评论文件与优先级 4.3）。
 */
export const REQUIREMENT_PRIORITIES = ["urgent", "high", "medium", "low"] as const;

export type RequirementPriority = (typeof REQUIREMENT_PRIORITIES)[number];

/** 优先级筛选里表示「无优先级」的保留值。 */
export const REQUIREMENT_PRIORITY_FILTER_NONE = "none";

/** 优先级筛选的单个取值：某一档或「无」。查询参数里用逗号分隔多选，如 `urgent,high,none`。 */
export type RequirementPriorityFilterValue =
  | RequirementPriority
  | typeof REQUIREMENT_PRIORITY_FILTER_NONE;

/** 需求列表的排序方式：`updated` 最近更新在前（缺省）；`priority` 先按优先级从急到缓，同一档再按最近更新。 */
export const REQUIREMENT_SORTS = ["updated", "priority"] as const;

export type RequirementSort = (typeof REQUIREMENT_SORTS)[number];

const PRIORITY_RANK: Readonly<Record<RequirementPriority, number>> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** 排序权重：越急越大，无优先级为 0。按优先级排序时按它从大到小排。 */
export function requirementPriorityRank(
  priority: RequirementPriority | null | undefined,
): number {
  return priority === null || priority === undefined ? 0 : PRIORITY_RANK[priority];
}

/** 排序权重还原为优先级；0 或不认识的值为 null。 */
export function requirementPriorityFromRank(rank: number): RequirementPriority | null {
  return REQUIREMENT_PRIORITIES.find((priority) => PRIORITY_RANK[priority] === rank) ?? null;
}

/** 解析逗号分隔的优先级筛选；有不认识的取值时返回 null。重复的取值只算一次。 */
export function parseRequirementPriorityFilter(
  value: string,
): RequirementPriorityFilterValue[] | null {
  const parts = value.split(",");
  const known: readonly string[] = [...REQUIREMENT_PRIORITIES, REQUIREMENT_PRIORITY_FILTER_NONE];
  if (parts.some((part) => !known.includes(part))) {
    return null;
  }
  return [...new Set(parts)] as RequirementPriorityFilterValue[];
}
