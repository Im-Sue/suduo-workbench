import { Toaster as SonnerToaster } from "sonner";
import { useEffect, useState } from "react";
import { currentResolvedTheme, type ResolvedTheme } from "@/ui/theme";

/**
 * 全局提示宿主（sonner）。位置右下，最多同时 3 条；样式完全走语义令牌，跟随亮暗主题。
 * 调用方统一通过 ui/message.tsx 的 showMessage()，不直接依赖 sonner。
 */
function Toaster() {
  const [theme, setTheme] = useState<ResolvedTheme>(() => currentResolvedTheme());
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentResolvedTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return (
    <SonnerToaster
      theme={theme}
      position="bottom-right"
      visibleToasts={3}
      gap={8}
      offset={20}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "group flex w-[360px] items-start gap-2.5 rounded-md bg-popover px-3.5 py-3 text-small text-popover-foreground shadow-overlay",
          title: "font-medium text-foreground",
          description: "text-muted-foreground",
          icon: "mt-px flex shrink-0 items-center [&_svg]:size-4",
          success: "[&_[data-icon]]:text-success",
          error: "[&_[data-icon]]:text-danger",
          warning: "[&_[data-icon]]:text-warning",
          info: "[&_[data-icon]]:text-primary-text",
          actionButton:
            "ml-auto shrink-0 rounded-sm px-2 py-1 text-small font-medium text-primary-text hover:bg-popover-hover",
          cancelButton: "shrink-0 rounded-sm px-2 py-1 text-small text-muted-foreground hover:bg-popover-hover",
          closeButton: "text-subtle-foreground",
        },
      }}
    />
  );
}

export { Toaster };
