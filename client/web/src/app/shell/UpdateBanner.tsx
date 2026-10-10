import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { desktopBridge } from "../../desktop/bridge.js";
import { useDesktopUpdate } from "../../desktop/update.js";
import { useT } from "../../i18n/provider.js";

const DISMISSED_KEY = "suduo.update.dismissed";

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/**
 * 桌面应用有新版本时的横幅（D3，技术设计 §4.3）：「SuDuo x.y.z 可用 · 更新说明 · 更新」，只提示、不强制（R5）。
 * 「稍后」只把这个版本收起来，下个版本照常提示。Windows 下载时显示进度；下载失败说明原因。浏览器里不出现。
 */
export function UpdateBanner() {
  const t = useT();
  const text = t.shell.update;
  const state = useDesktopUpdate();
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed());
  const downloading = useRef(false);
  const [downloadFailed, setDownloadFailed] = useState<string | null>(null);

  useEffect(() => {
    if (state === null) return;
    if (state.kind === "downloading") {
      downloading.current = true;
      setDownloadFailed(null);
    } else if (state.kind === "failed" && downloading.current) {
      downloading.current = false;
      setDownloadFailed(state.message);
    } else if (state.kind !== "failed") {
      downloading.current = false;
      // 重新检查、又有新版本：上次下载失败的说明收起。
      if (state.kind === "available" || state.kind === "checking") setDownloadFailed(null);
    }
  }, [state]);

  if (state === null) return null;
  const bridge = desktopBridge();
  if (downloadFailed !== null) {
    return (
      <Banner
        tone="warning"
        className="mx-3 mt-3 shrink-0"
        data-testid="update-banner"
        actions={
          <Button size="sm" variant="ghost" onClick={() => setDownloadFailed(null)}>
            {text.close}
          </Button>
        }
      >
        {downloadFailed}
      </Banner>
    );
  }
  if (state.kind === "downloading") {
    return (
      <Banner tone="pending" className="mx-3 mt-3 shrink-0" data-testid="update-banner">
        {text.downloading(state.version, state.percent)}
      </Banner>
    );
  }
  if (state.kind !== "available" || dismissed === state.version) return null;
  const later = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, state.version);
    } catch {
      // 记不住就只是这次收起。
    }
    setDismissed(state.version);
  };
  return (
    <Banner
      tone="info"
      className="mx-3 mt-3 shrink-0"
      data-testid="update-banner"
      actions={
        <>
          <Button size="sm" variant="ghost" asChild>
            <a href={state.notesUrl} target="_blank" rel="noreferrer noopener">
              {text.notes}
            </a>
          </Button>
          <Button size="sm" variant="ghost" onClick={later} data-testid="update-later">
            {text.later}
          </Button>
          <Button size="sm" variant="primary" onClick={() => void bridge?.installUpdate()} data-testid="update-install">
            {state.canInstall ? text.install : text.download}
          </Button>
        </>
      }
    >
      {text.available(state.version)}
    </Banner>
  );
}
