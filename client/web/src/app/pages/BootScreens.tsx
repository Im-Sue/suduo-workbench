import { RotateCwIcon, ServerCrashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { classifyFailure } from "../../feedback/classify.js";
import { useT } from "../../i18n/provider.js";

/** 启动时读取本机设置：只显示品牌与一个安静的加载指示，避免闪一下空白外壳。 */
export function BootSplash() {
  const t = useT();
  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-background" role="status" aria-live="polite">
      <span className="flex size-10 items-center justify-center rounded-[10px] bg-foreground text-body font-semibold text-background">
        SD
      </span>
      <span className="inline-flex items-center gap-2 text-small text-subtle-foreground">
        <Spinner />
        {t.setup.boot.starting}
      </span>
    </div>
  );
}

/**
 * 启动失败（修复审计缺陷：旧版在这里永远停在"正在加载"）。
 * 最常见的原因是本机服务没在运行，给出原因与重试。
 */
export function BootFailure({ error, onRetry }: { error: unknown; onRetry(): void }) {
  const t = useT();
  const failure = classifyFailure(error);
  const networkDown = error instanceof TypeError;
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-background p-6">
      <section
        className="flex w-[min(440px,100%)] flex-col items-center gap-3 text-center"
        data-feedback-kind={failure.kind}
        data-feedback-result="page"
        data-testid="page-failure"
        role="alert"
      >
        <span className="flex size-11 items-center justify-center rounded-full bg-danger-soft text-danger">
          <ServerCrashIcon className="size-5" aria-hidden="true" />
        </span>
        <h1 className="m-0 text-section font-semibold text-foreground">
          {networkDown ? t.setup.boot.unreachableTitle : t.setup.boot.failedTitle}
        </h1>
        <p className="m-0 text-small text-muted-foreground">
          {networkDown ? t.setup.boot.unreachableDetail : failure.message}
        </p>
        <Button className="mt-1" variant="primary" onClick={onRetry}>
          <RotateCwIcon />
          {t.setup.boot.retry}
        </Button>
      </section>
    </div>
  );
}

/** 路由级加载：按内容区布局画骨架，不用通用转圈占满区域。 */
export function RouteLoading() {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-6" role="status" aria-label={t.setup.boot.routeLoading}>
      <Skeleton className="h-5 w-40" />
      <div className="grid grid-cols-3 gap-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}
