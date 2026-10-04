import type { ServerMessages } from "../zh-CN/index.js";

export const common = {
  internalError: "Something went wrong on the local service",
  requirementStatus: {
    draft: "Draft",
    in_refinement: "Refining",
    ready_for_development: "Ready",
    in_development: "In development",
    in_testing: "In testing",
    completed: "Done",
    on_hold: "On hold",
  },
} satisfies ServerMessages["common"];
