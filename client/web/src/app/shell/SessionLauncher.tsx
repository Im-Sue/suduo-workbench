import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionDto } from "@suduo/client-contracts";
import { StartSessionDialog, type LaunchRequest } from "../../features/requirements/components/StartSessionDialog.js";
import { requirementKeys } from "../../features/requirements/keys.js";
import { invalidateProjectLists } from "../../features/requirements/queries.js";
import { showMessage } from "../../ui/message.js";
import { useProjects } from "../project-context.js";
import { queryKeys } from "../queries.js";

/**
 * 发起本机会话（外壳级能力）：打开分步的「开始会话」对话框，就绪后进入会话。
 * 对话框开着时再次发起会被忽略，连点不会建出多个会话。
 * 同一需求 / 项目的会话还在后台准备时再点：不拦着，告诉用户它还在准备，并给「仍要新开」（ADR-0004：检测 + 告知 + 选项）。
 */
export type { LaunchRequest };

interface SessionLauncherValue {
  launch(request: LaunchRequest & { subject?: string }): void;
  launching: boolean;
}

const SessionLauncherContext = createContext<SessionLauncherValue | null>(null);

export function useSessionLauncher(): SessionLauncherValue {
  const value = useContext(SessionLauncherContext);
  if (value === null) throw new Error("useSessionLauncher 必须在 SessionLauncherProvider 内使用");
  return value;
}

export function SessionLauncherProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projects = useProjects().data ?? [];
  const [active, setActive] = useState<{ request: LaunchRequest; subject: string; key: number } | null>(null);
  const inBackground = useRef(new Set<string>());

  const open = useCallback(
    (request: LaunchRequest & { subject?: string }) => {
      setActive((current) => {
        if (current !== null) return current;
        const { subject, ...rest } = request;
        const project = projects.find((item) => item.id === request.remoteProjectId);
        return {
          request: rest as LaunchRequest,
          subject: subject ?? project?.name ?? "",
          key: Date.now(),
        };
      });
    },
    [projects],
  );

  const launch = useCallback(
    (request: LaunchRequest & { subject?: string }) => {
      const key = backgroundKey(request);
      if (inBackground.current.has(key)) {
        showMessage("这个会话还在后台准备，好了会提示你", "info", {
          id: `launch-${key}`,
          action: { label: "仍要新开", onClick: () => open(request) },
        });
        return;
      }
      open(request);
    },
    [open],
  );

  const onReady = useCallback(
    (request: LaunchRequest, session: SessionDto, detached: boolean) => {
      inBackground.current.delete(backgroundKey(request));
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      void queryClient.invalidateQueries({ queryKey: requirementKeys.sessions(request.remoteProjectId) });
      // 卡片与详情上的「本机会话数」随之变化。
      void invalidateProjectLists(queryClient, request.remoteProjectId);
      if (request.kind === "requirement") {
        void queryClient.invalidateQueries({ queryKey: requirementKeys.detail(request.requirementId) });
      }
      const enter = () => void navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } });
      if (detached) {
        showMessage(`会话「${session.title || "未命名会话"}」已就绪`, "success", {
          action: { label: "进入", onClick: enter },
        });
        return;
      }
      setActive(null);
      enter();
    },
    [navigate, queryClient],
  );

  const value = useMemo(() => ({ launch, launching: active !== null }), [active, launch]);

  return (
    <SessionLauncherContext.Provider value={value}>
      {children}
      {active === null ? null : (
        <StartSessionDialog
          key={active.key}
          request={active.request}
          subject={active.subject}
          onClose={(background) => {
            if (background) inBackground.current.add(backgroundKey(active.request));
            setActive(null);
          }}
          onReady={(session, detached) => onReady(active.request, session, detached)}
          onBackgroundFailed={() => inBackground.current.delete(backgroundKey(active.request))}
        />
      )}
    </SessionLauncherContext.Provider>
  );
}

function backgroundKey(request: LaunchRequest): string {
  return request.kind === "requirement" ? `requirement:${request.requirementId}` : `project:${request.remoteProjectId}`;
}
