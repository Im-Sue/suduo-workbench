import { BellOffIcon, InfoIcon } from "lucide-react";
import { useState } from "react";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useT } from "../../../i18n/provider.js";
import { showMessage } from "../../../ui/message.js";
import { rowDescId, rowLabelId, SaveStatus, SettingsRow, SettingsSection, useSaveIndicator } from "../components/kit.js";
import { refreshNotifyState, useNotifyState, writeNotifyPreference } from "../notify-preference.js";

/**
 * 通知：会话在后台完成、失败或等你确认时，标签页标题总会加提醒前缀；
 * 这里决定要不要再发一条系统通知。打开时向浏览器申请授权，被拒绝时说明怎么重新允许。
 */
export function NotificationsSection() {
  const text = useT().settingsAgent.notifications;
  const notify = useNotifyState();
  const [saved, track] = useSaveIndicator();
  const [requesting, setRequesting] = useState(false);
  const blocked = notify.permission === "denied";
  const unsupported = notify.permission === "unsupported";
  const working = notify.enabled && notify.permission === "granted";

  // 开关就是偏好。还没问过浏览器：先申请，你在弹窗里点了允许才记为开启，点了拒绝就不记、只说明怎么改；
  // 浏览器早已阻止：记下「想要」并说明怎么允许（导航上会有提示点），随时可以关掉。
  const [justDenied, setJustDenied] = useState(false);
  const enable = async () => {
    setJustDenied(false);
    if (notify.permission !== "default") {
      track(() => writeNotifyPreference(true));
      return;
    }
    setRequesting(true);
    try {
      const result = await window.Notification.requestPermission();
      if (result === "granted") track(() => writeNotifyPreference(true));
      else setJustDenied(true);
    } catch {
      setJustDenied(true);
    } finally {
      setRequesting(false);
      refreshNotifyState();
    }
  };

  const statusText = requesting
    ? text.status.requesting
    : !notify.enabled
      ? text.status.off
      : working
        ? text.status.on
        : blocked
          ? text.status.blocked
          : text.status.notGranted;

  return (
    <SettingsSection id="notifications" description={text.description}>
      <SettingsRow
        anchor="system-notify"
        title={text.system.title}
        description={text.system.description}
        status={<SaveStatus state={saved} />}
      >
        <div className="flex items-center gap-3">
          <Switch
            aria-labelledby={rowLabelId("system-notify")}
            aria-describedby={rowDescId("system-notify")}
            checked={notify.enabled && !unsupported}
            disabled={unsupported || requesting}
            onCheckedChange={(checked) => {
              if (checked) void enable();
              else track(() => writeNotifyPreference(false));
            }}
            data-testid="settings-system-notify"
          />
          <span className="text-small text-muted-foreground" aria-live="polite">
            {statusText}
          </span>
          {working ? (
            <Button
              size="sm"
              variant="ghost"
              type="button"
              className="ml-auto"
              onClick={() => {
                try {
                  new window.Notification(text.sample.title, { body: text.sample.body, tag: "suduo-test" });
                } catch {
                  showMessage(text.sample.failed, "warning");
                }
              }}
            >
              {text.sample.button}
            </Button>
          ) : null}
        </div>
        {unsupported ? (
          <p className="m-0 flex items-start gap-1.5 text-small text-muted-foreground">
            <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            {text.unsupported}
          </p>
        ) : null}
        {blocked && (notify.enabled || justDenied) ? (
          <Banner tone="warning" icon={<BellOffIcon />} title={text.blocked.title} data-testid="settings-notify-blocked">
            {text.blocked.body}
          </Banner>
        ) : null}
        {notify.enabled && notify.permission === "default" && !requesting ? (
          <Button size="sm" type="button" className="self-start" onClick={() => void enable()}>
            {text.requestPermission}
          </Button>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
