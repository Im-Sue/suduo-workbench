import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { DeferredLocaleNotice } from "../i18n/DeferredLocaleNotice.js";
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
        {/* 别的标签页改了语言、这里还在等时的提示（i18n/locale.ts）。 */}
        <DeferredLocaleNotice />
      </LocaleBoundary>
    </QueryClientProvider>
  );
}
