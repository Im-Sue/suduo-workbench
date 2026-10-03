export const REQUIREMENT_STATUSES = [
  "draft",
  "in_refinement",
  "ready_for_development",
  "in_development",
  "in_testing",
  "completed",
  "on_hold",
] as const;

export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const REQUIREMENT_STATUS_LABELS: Readonly<
  Record<RequirementStatus, string>
> = {
  draft: "草稿",
  in_refinement: "梳理中",
  ready_for_development: "待开发",
  in_development: "开发中",
  in_testing: "测试中",
  completed: "已完成",
  on_hold: "暂缓",
};
