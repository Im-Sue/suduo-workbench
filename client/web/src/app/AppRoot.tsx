import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { createQueryClient } from "./queries.js";
import { createAppRouter } from "./router.js";

/** 应用根：服务端状态（TanStack Query）+ 路由（TanStack Router）。 */
export function AppRoot({ queryClient: providedClient }: { queryClient?: QueryClient } = {}) {
  const [queryClient] = useState(() => providedClient ?? createQueryClient());
  const [router] = useState(() => createAppRouter(queryClient));
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
