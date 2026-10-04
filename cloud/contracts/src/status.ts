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
