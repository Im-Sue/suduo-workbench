import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { api } from "../../api/client.js";
import { clearPageFeedback } from "../../feedback/page-store.js";
import { reportFailure } from "../../feedback/report.js";
import { queryKeys } from "../queries.js";

/** 退出登录：清掉页面级失败与缓存的服务端状态，回到登录页。 */
export function useLogout(): () => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useCallback(async () => {
    try {
      await api.logoutRequirements();
    } catch (cause) {
      reportFailure(cause, { surface: "action" });
      return;
    }
    clearPageFeedback();
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.settings[0] });
    await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    await navigate({ to: "/login" });
  }, [navigate, queryClient]);
}
