import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { api } from "../../api/client.js";
import { applyViewer, markReadLocally, setReadingRoom } from "./cache.js";

/**
 * 房间已读（需求 4.3 未读）：房间在前台可见、而且滚到了底部，才记到最新序号；
 * 后台标签页、往上翻着看历史都不算看过，回到前台 / 滚回底部时补记。只前进，记不下不打扰，下次再记。
 * active：界面是否正摆在用户面前——悬浮窗口收起时为 false（不算正在看、不记已读），恢复时按最新状态补记。
 */
export function useRoomReadMarker(
  roomId: string,
  options: { lastReadSeq: number; enabled: boolean; active?: boolean },
): (state: { atBottom: boolean; maxSeq: number }) => void {
  const queryClient = useQueryClient();
  const latest = useRef({ atBottom: false, maxSeq: 0 });
  const marked = useRef(0);
  // 本处在「正在看」登记里的身份：同一房间同时开在讨论页和悬浮窗口里时互不覆盖。
  const viewer = useRef<object>({});
  const { lastReadSeq, enabled, active = true } = options;

  const mark = useCallback(() => {
    const visible = active && document.visibilityState === "visible";
    const { atBottom, maxSeq } = latest.current;
    setReadingRoom(roomId, visible && atBottom, viewer.current);
    if (!enabled || !visible || !atBottom || maxSeq <= 0) return;
    if (maxSeq <= Math.max(marked.current, lastReadSeq)) return;
    marked.current = maxSeq;
    markReadLocally(queryClient, roomId, maxSeq);
    api
      .markRoomRead(roomId, maxSeq)
      .then((viewerState) => {
        if (viewerState !== undefined && viewerState !== null && typeof viewerState.lastReadSeq === "number") {
          applyViewer(queryClient, roomId, viewerState);
        }
      })
      .catch(() => {
        marked.current = 0;
      });
  }, [active, enabled, lastReadSeq, queryClient, roomId]);

  useEffect(() => {
    const self = viewer.current;
    document.addEventListener("visibilitychange", mark);
    return () => {
      document.removeEventListener("visibilitychange", mark);
      setReadingRoom(roomId, false, self);
    };
  }, [mark, roomId]);

  // 条件变了（收起 / 恢复、记完已读后）按最新的滚动状态重登记一次：恢复窗口时停在底部就补记已读。
  useEffect(() => {
    mark();
  }, [mark]);

  return useCallback(
    (state: { atBottom: boolean; maxSeq: number }) => {
      latest.current = state;
      mark();
    },
    [mark],
  );
}
