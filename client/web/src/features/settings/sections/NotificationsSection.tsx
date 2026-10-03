import { BellOffIcon, InfoIcon } from "lucide-react";
import { useState } from "react";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { showMessage } from "../../../ui/message.js";
import { rowDescId, rowLabelId, SaveStatus, SettingsRow, SettingsSection, useSaveIndicator } from "../components/kit.js";
import { refreshNotifyState, useNotifyState, writeNotifyPreference } from "../notify-preference.js";

/**
 * 通知：会话在后台完成、失败或等你确认时，标签页标题总会加提醒前缀；
 * 这里决定要不要再发一条系统通知。打开时向浏览器申请授权，被拒绝时说明怎么重新允许。
 */
export function NotificationsSection() {
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
    ? "正在等你在浏览器里允许…"
    : !notify.enabled
      ? "已关闭"
      : working
        ? "已开启"
        : blocked
          ? "已开启，但浏览器阻止了通知"
          : "已开启，还没得到浏览器授权";

  return (
    <SettingsSection id="notifications" description="只影响这台电脑上的这个浏览器。">
      <SettingsRow
        anchor="system-notify"
        title="系统通知"
        description="会话在后台完成、失败或等你确认时，用系统通知提醒你。标签页标题上的提醒始终开启。"
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
                  new window.Notification("SuDuo 通知已开启", { body: "会话需要你时，会像这样提醒你。", tag: "suduo-test" });
                } catch {
                  showMessage("这个浏览器不允许页面直接发通知，标签页标题的提醒仍然有效。", "warning");
                }
              }}
            >
              发一条试试
            </Button>
          ) : null}
        </div>
        {unsupported ? (
          <p className="m-0 flex items-start gap-1.5 text-small text-muted-foreground">
            <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            这个浏览器不支持系统通知，标签页标题上的提醒仍然有效。
          </p>
        ) : null}
        {blocked && (notify.enabled || justDenied) ? (
          <Banner tone="warning" icon={<BellOffIcon />} title="浏览器阻止了 SuDuo 的通知" data-testid="settings-notify-blocked">
            点地址栏左侧的站点图标，把「通知」改为「允许」，回到这里就会生效。不想要系统通知的话，关掉上面的开关即可。
          </Banner>
        ) : null}
        {notify.enabled && notify.permission === "default" && !requesting ? (
          <Button size="sm" type="button" className="self-start" onClick={() => void enable()}>
            向浏览器申请通知权限
          </Button>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
