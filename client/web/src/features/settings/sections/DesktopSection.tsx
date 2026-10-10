import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DesktopPreferencesDto, DesktopUpdateState } from "@suduo/client-contracts";
import { ExternalLinkIcon, FolderOpenIcon, InfoIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { desktopBridge } from "../../../desktop/bridge.js";
import { useDesktopUpdate } from "../../../desktop/update.js";
import { reportFailure } from "../../../feedback/report.js";
import { useT } from "../../../i18n/provider.js";
import { rowDescId, rowLabelId, SaveStatus, SettingsRow, SettingsSection, useSaveIndicator } from "../components/kit.js";

const DESKTOP_KEYS = { info: ["desktop", "info"] as const, preferences: ["desktop", "preferences"] as const };

/**
 * 设置 → 桌面应用（桌面应用 D2）：开机自启（默认关）、本机地址、数据与日志目录、版本。只在安装版里出现
 * （分组导航按桥是否存在决定）；更新相关的设置随 D3 加。
 */
export function DesktopSection() {
  const t = useT();
  const text = t.settingsAgent.desktop;
  const bridge = desktopBridge();
  const queryClient = useQueryClient();
  const [saved, track] = useSaveIndicator();
  const [updateSaved, trackUpdate] = useSaveIndicator();
  const update = useDesktopUpdate();
  const info = useQuery({ queryKey: DESKTOP_KEYS.info, queryFn: () => bridge!.info(), enabled: bridge !== null, staleTime: Infinity });
  const preferences = useQuery({ queryKey: DESKTOP_KEYS.preferences, queryFn: () => bridge!.getPreferences(), enabled: bridge !== null });

  if (bridge === null) {
    return (
      <SettingsSection id="desktop" description={text.description}>
        <p className="m-0 flex items-start gap-1.5 text-small text-muted-foreground">
          <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {text.onlyInApp}
        </p>
      </SettingsSection>
    );
  }

  const setOpenAtLogin = (openAtLogin: boolean) =>
    track(() =>
      bridge
        .setPreferences({ openAtLogin })
        .then((next) => queryClient.setQueryData<DesktopPreferencesDto>(DESKTOP_KEYS.preferences, next))
        .catch((cause: unknown) => reportFailure(cause, { surface: "action" })),
    );
  const setAutoCheck = (autoCheckUpdates: boolean) =>
    trackUpdate(() =>
      bridge
        .setPreferences({ autoCheckUpdates })
        .then((next) => queryClient.setQueryData<DesktopPreferencesDto>(DESKTOP_KEYS.preferences, next))
        .catch((cause: unknown) => reportFailure(cause, { surface: "action" })),
    );
  const status = preferences.data?.openAtLoginStatus;

  return (
    <SettingsSection id="desktop" description={text.description}>
      <SettingsRow anchor="desktop-open-at-login" title={text.openAtLogin.title} description={text.openAtLogin.description} status={<SaveStatus state={saved} />}>
        <div className="flex flex-col gap-1.5">
          <Switch
            aria-labelledby={rowLabelId("desktop-open-at-login")}
            aria-describedby={rowDescId("desktop-open-at-login")}
            checked={preferences.data?.openAtLogin ?? false}
            disabled={preferences.data === undefined}
            onCheckedChange={(checked) => setOpenAtLogin(checked)}
            data-testid="desktop-open-at-login"
          />
          {status === "requiresApproval" ? (
            <span className="text-caption text-warning" data-testid="desktop-open-at-login-note">
              {text.openAtLogin.requiresApproval}
            </span>
          ) : status === "unavailable" ? (
            <span className="text-caption text-muted-foreground" data-testid="desktop-open-at-login-note">
              {text.openAtLogin.unavailable}
            </span>
          ) : null}
        </div>
      </SettingsRow>

      <SettingsRow anchor="desktop-updates" title={text.updates.title} description={text.updates.description} status={<SaveStatus state={updateSaved} />}>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <Switch
              aria-labelledby={rowLabelId("desktop-updates")}
              aria-describedby={rowDescId("desktop-updates")}
              checked={preferences.data?.autoCheckUpdates ?? true}
              disabled={preferences.data === undefined}
              onCheckedChange={(checked) => setAutoCheck(checked)}
              data-testid="desktop-auto-update"
            />
            <span className="text-small text-muted-foreground">{text.updates.auto}</span>
            <Button size="sm" variant="secondary" loading={update?.kind === "checking"} onClick={() => void bridge.checkForUpdates()} data-testid="desktop-check-update">
              {text.updates.check}
            </Button>
          </div>
          {update === null ? null : <UpdateStatus state={update} />}
        </div>
      </SettingsRow>

      <SettingsRow anchor="desktop-address" title={text.address.title} description={text.address.description}>
        {info.data === undefined ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-small" data-testid="desktop-address">
              {info.data.baseUrl}
            </code>
            <Button size="sm" variant="ghost" asChild>
              <a href={info.data.baseUrl} target="_blank" rel="noreferrer noopener">
                {text.address.open}
                <ExternalLinkIcon />
              </a>
            </Button>
          </div>
        )}
      </SettingsRow>

      <SettingsRow anchor="desktop-folders" title={text.folders.title} description={text.folders.description}>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => void bridge.openDirectory("data")} data-testid="desktop-open-data">
            <FolderOpenIcon />
            {text.folders.data}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void bridge.openDirectory("logs")} data-testid="desktop-open-logs">
            <FolderOpenIcon />
            {text.folders.logs}
          </Button>
        </div>
      </SettingsRow>

      <SettingsRow anchor="desktop-version" title={text.version.title}>
        {info.data === undefined ? null : (
          <span className="text-small text-muted-foreground" data-testid="desktop-version">
            {text.version.value(info.data.version, info.data.platform, info.data.arch)}
          </span>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}

/** 手动检查的结果（有新版本时给「更新」/「去下载」）。 */
function UpdateStatus({ state }: { state: DesktopUpdateState }) {
  const text = useT().settingsAgent.desktop.updates;
  const bridge = desktopBridge();
  switch (state.kind) {
    case "idle":
    case "checking":
      return null;
    case "upToDate":
      return <span className="text-caption text-muted-foreground" data-testid="desktop-update-status">{text.upToDate}</span>;
    case "downloading":
      return <span className="text-caption text-muted-foreground" data-testid="desktop-update-status">{text.downloading(state.percent)}</span>;
    case "failed":
      return <span className="text-caption text-warning" data-testid="desktop-update-status">{state.message}</span>;
    case "available":
      return (
        <span className="flex flex-wrap items-center gap-2 text-caption text-foreground" data-testid="desktop-update-status">
          {text.available(state.version)}
          <Button size="sm" variant="primary" onClick={() => void bridge?.installUpdate()}>
            {state.canInstall ? text.install : text.download}
          </Button>
        </span>
      );
  }
}
