import type { QueryClient } from "@tanstack/react-query";
import { workbenchQuery } from "../features/my-work/queries.js";
import { requirementKeys } from "../features/requirements/keys.js";
import { settingsKeys } from "../features/settings/queries.js";
import { queryKeys } from "./queries.js";

/**
 * 「项目 ↔ 本机代码目录」的关联改了（新建 / 更换 / 解除），读它的几处一起刷新：
 * 需求详情与项目设置（requirementKeys.mappings）、设置 › 代码目录与导航提示点（settingsKeys.workspace）、
 * 首启清单用的关联数（settings）、我的工作的「代码目录失效」（工作台）。
 * 不管在哪里改的，都走这一个出口，避免某处看到旧路径。
 */
export function invalidateMappingCaches(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: requirementKeys.mappings }),
    queryClient.invalidateQueries({ queryKey: settingsKeys.workspace }),
    queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
    queryClient.invalidateQueries({ queryKey: workbenchQuery.queryKey }),
  ]);
}
