import type { DesktopUpdateState } from "@suduo/client-contracts";
import { useEffect, useState } from "react";
import { desktopBridge } from "./bridge.js";

/**
 * 桌面应用的更新状态（D3）：先取一次现在的，再跟着外壳推来的变化。浏览器里（没有桥）为 null。
 */
export function useDesktopUpdate(): DesktopUpdateState | null {
  const bridge = desktopBridge();
  const [state, setState] = useState<DesktopUpdateState | null>(bridge === null ? null : { kind: "idle" });
  useEffect(() => {
    if (bridge === null) return;
    let alive = true;
    const unsubscribe = bridge.onUpdateState((next) => {
      if (alive) setState(next);
    });
    void bridge
      .getUpdateState()
      .then((current) => {
        if (alive) setState(current);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [bridge]);
  return state;
}
