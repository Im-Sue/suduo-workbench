import type { LocalePreference } from "@suduo/client-contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "../feedback/components/index.js";
import { applyLocalePreference, deferredLocalePreference, resolveUiLocale, subscribeLocale } from "./locale.js";
import { useT } from "./provider.js";

/**
 * 别的标签页改了语言、这个标签页还有带不过去的东西（打开的对话框、没保存的编辑）时，先不跟（locale.ts），
 * 在这里给一条不打断的提示：处理完会自动切换；也可以点「现在切换」，确认后马上切（会丢掉那些东西）。
 */
export function DeferredLocaleNotice() {
  const t = useT();
  const text = t.settingsAgent.appearance.locale;
  const pending = useSyncExternalStore(subscribeLocale, deferredLocalePreference, deferredLocalePreference);
  /** 点「现在切换」时等的是哪一次：等的那次没了（已经切了、别的标签页又改回去）就不再弹。 */
  const [confirmingFor, setConfirmingFor] = useState<LocalePreference | null>(null);
  useEffect(() => {
    if (pending === null) setConfirmingFor(null);
  }, [pending]);
  if (pending === null) return null;
  return (
    <>
      <Banner
        tone="info"
        data-testid="locale-deferred-notice"
        className="fixed top-3 left-1/2 z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 shadow-md"
        actions={
          <Button size="sm" variant="ghost" data-testid="locale-deferred-switch" onClick={() => setConfirmingFor(pending)}>
            {text.otherTab.switchNow}
          </Button>
        }
      >
        {text.otherTab.message(t.common.localeOption[resolveUiLocale(pending)])}
      </Banner>
      <ConfirmDialog
        open={confirmingFor === pending}
        onOpenChange={(open) => setConfirmingFor(open ? pending : null)}
        title={text.confirm.title}
        description={text.confirm.body}
        confirmLabel={text.confirm.action}
        onConfirm={() => applyLocalePreference(pending)}
      />
    </>
  );
}
