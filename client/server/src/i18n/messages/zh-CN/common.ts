import type { RequirementStatus } from "@suduo/cloud-contracts";

/** 本机服务通用：兜底报错等多个分区共用的文字。 */
export const common = {
  /** 未预料的服务端异常（统一错误处理的兜底）。 */
  internalError: "服务端处理请求失败",
  /** 需求状态名（给 Codex 的需求卡与工具回包；与前端 `common.requirementStatus` 一致）。 */
  requirementStatus: {
    draft: "草稿",
    in_refinement: "梳理中",
    ready_for_development: "待开发",
    in_development: "开发中",
    in_testing: "测试中",
    completed: "已完成",
    on_hold: "暂缓",
  } satisfies Record<RequirementStatus, string>,
};
