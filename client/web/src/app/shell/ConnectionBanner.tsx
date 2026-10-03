import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getConnectivity, subscribeConnectivity } from "../../api/connectivity.js";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { useT } from "../../i18n/provider.js";

/**
 * 断线横幅：本机服务连不上时出现在内容区顶部并自动重试；恢复后显示 2 秒「已恢复」再消失。
 * 它是持续可见的状态，不用会自动消失的 toast。
 */
export function ConnectionBanner() {
  const connectivity = useSyncExternalStore(subscribeConnectivity, getConnectivity, getConnectivity);
  const queryClient = useQueryClient();
  const t = useT();
  const [recovered, setRecovered] = useState(false);
  const wasOffline = useRef(false);

  useEffect(() => {
    if (connectivity === "offline") {
      wasOffline.current = true;
      setRecovered(false);
      const timer = window.setInterval(() => {
        void queryClient.refetchQueries({ type: "active" });
      }, 5_000);
      return () => window.clearInterval(timer);
    }
    if (wasOffline.current) {
      wasOffline.current = false;
      setRecovered(true);
      void queryClient.invalidateQueries();
    }
    return undefined;
  }, [connectivity, queryClient]);

  // 「已恢复」单独计时：不受连通性 effect 重跑影响，保证 2 秒后一定消失。
  useEffect(() => {
    if (!recovered) return undefined;
    const timer = window.setTimeout(() => setRecovered(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [recovered]);

  if (connectivity === "offline") {
    return (
      <Banner
        tone="pending"
        className="mx-3 mt-3 shrink-0"
        data-testid="connection-banner"
        actions={
          <Button size="sm" variant="ghost" onClick={() => void queryClient.refetchQueries({ type: "active" })}>
            {t.shell.connection.retry}
          </Button>
        }
      >
        {t.shell.connection.offline}
      </Banner>
    );
  }
  if (recovered) {
    return (
      <Banner tone="success" className="mx-3 mt-3 shrink-0" data-testid="connection-banner">
        {t.shell.connection.recovered}
      </Banner>
    );
  }
  return null;
}
