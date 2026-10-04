import { Suspense, lazy } from "react";
import type { MonacoSurfaceProps } from "./MonacoImpl.js";
import { Spinner } from "@/components/ui/spinner";
import { useT } from "../i18n/provider.js";

// Monaco 数 MB：首屏不加载，首次打开 diff/文本预览时才拉独立 chunk。
const MonacoSurface = lazy(() => import("./MonacoImpl.js"));

export function MonacoView(props: MonacoSurfaceProps) {
  const t = useT();
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 p-6 text-small text-subtle-foreground" role="status">
          <Spinner size="sm" />
          {t.workbench.viewer.loading}
        </div>
      }
    >
      <MonacoSurface {...props} />
    </Suspense>
  );
}
