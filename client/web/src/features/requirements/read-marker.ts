import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { api } from "../../api/client.js";
import { requirementKeys } from "./keys.js";

/**
 * 已读位置（我的工作里的「有新评论」靠它）：只把界面上真的显示出来的最新一条评论记为已读，
 * 而且只在这个标签页在前台时记——详情页开在后台、评论被筛掉或还没加载出来，都不算看过；回到前台时补记。
 * 记不下（网络等）不打扰，下次再记。
 */
export function useReadMarker(requirementId: string, projectId: string): (latestCommentAt: string | null) => void {
  const queryClient = useQueryClient();
  const shown = useRef<string | null>(null);
  const marked = useRef<string | null>(null);
  const mark = useCallback(() => {
    const upTo = shown.current;
    if (upTo === null || document.visibilityState !== "visible") return;
    if (marked.current !== null && Date.parse(marked.current) >= Date.parse(upTo)) return;
    marked.current = upTo;
    api
      .markRequirementRead(requirementId, { upTo })
      .then(() => queryClient.invalidateQueries({ queryKey: [...requirementKeys.project(projectId), "assigned-to-me"] }))
      .catch(() => {
        marked.current = null;
      });
  }, [projectId, queryClient, requirementId]);
  useEffect(() => {
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [mark]);
  return useCallback(
    (latestCommentAt: string | null) => {
      shown.current = latestCommentAt;
      mark();
    },
    [mark],
  );
}
