import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { LocaleBoundary } from "../i18n/provider.js";
import { createQueryClient } from "./queries.js";
import { createAppRouter } from "./router.js";

/** 应用根：服务端状态（TanStack Query）+ 界面语言 + 路由（TanStack Router）。 */
export function AppRoot({ queryClient: providedClient }: { queryClient?: QueryClient } = {}) {
  const [queryClient] = useState(() => providedClient ?? createQueryClient());
  const [router] = useState(() => createAppRouter(queryClient));
  return (
    <QueryClientProvider client={queryClient}>
      <LocaleBoundary>
        <RouterProvider router={router} />
      </LocaleBoundary>
    </QueryClientProvider>
  );
}
