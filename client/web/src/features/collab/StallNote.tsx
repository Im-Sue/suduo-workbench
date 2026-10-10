import type { StallDto } from "@suduo/client-contracts";
import { HourglassIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../../i18n/provider.js";

/**
 * 委派、评审的卡住提醒（多 Agent S12）：等你确认超过 10 分钟，或回合在跑却 15 分钟没有动静。只提醒，停不停由人决定。
 * 卡住与否随委派 / 评审事件刷新（本机服务每分钟检查一次）；分钟数在这里每分钟重算。
 */
export function StallNote({ stall }: { stall: StallDto | null | undefined }) {
  const text = useT().collab.stall;
  const [now, setNow] = useState(() => Date.now());
  const active = stall !== null && stall !== undefined;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [active]);
  // S12 之前记下的卡片事件没有这个字段。
  if (stall === null || stall === undefined) return null;
  const minutes = Math.max(1, Math.floor((now - stall.since) / 60_000));
  return (
    <span className="inline-flex items-center gap-1 text-warning" data-testid="stall-note" data-reason={stall.reason}>
      <HourglassIcon className="size-3" aria-hidden="true" />
      {stall.reason === "approval" ? text.approval(minutes) : text.silent(minutes)}
    </span>
  );
}
