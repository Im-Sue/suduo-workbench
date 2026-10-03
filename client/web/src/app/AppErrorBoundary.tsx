import { Component, type ReactNode } from "react";
import { currentLocale } from "../i18n/locale.js";
import { messagesFor } from "../i18n/messages/index.js";

/**
 * 顶层错误边界：任何未捕获的渲染异常都落到这张可恢复卡片，而不是整窗白屏
 * （2026-07-23 白屏事故的兜底层）。「清缓存重载」只清本机回放缓存——
 * 事件账本在服务端，不丢任何会话数据。
 */
export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  private readonly reload = () => {
    window.location.reload();
  };

  private readonly clearCacheAndReload = () => {
    try {
      const stale: string[] = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (
          key !== null &&
          (key.startsWith("suduo.events.") || key.startsWith("suduo.cursor."))
        ) {
          stale.push(key);
        }
      }
      for (const key of stale) {
        localStorage.removeItem(key);
      }
    } catch {
      // 清理失败不阻断重载。
    }
    window.location.reload();
  };

  override render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }
    // 边界在语言边界之外，不随切换重建；出错时按当时的界面语言取文字。
    const text = messagesFor(currentLocale()).setup.crash;
    return (
      <div className="grid h-full w-full place-items-center bg-background p-6 text-foreground" role="alert">
        <div className="w-[480px] max-w-full rounded-lg border border-border bg-card p-8 shadow-overlay">
          <h1 className="m-0 mb-2 text-page font-semibold">{text.title}</h1>
          <p className="m-0 mb-3.5 text-body text-muted-foreground">{text.body}</p>
          <pre className="m-0 mb-4.5 max-h-30 overflow-auto rounded-md border border-border bg-muted px-3 py-2.5 font-mono text-caption break-all whitespace-pre-wrap text-subtle-foreground">
            {this.state.error.message}
          </pre>
          {/* 兜底页不依赖任何共享组件：出错的可能正是它们。 */}
          <div className="flex gap-2.5">
            <button
              type="button"
              className="h-8 rounded-md bg-primary px-3 text-small font-medium text-primary-foreground hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              onClick={this.reload}
            >
              {text.reload}
            </button>
            <button
              type="button"
              className="h-8 rounded-md border border-border-strong bg-card px-3 text-small font-medium text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              onClick={this.clearCacheAndReload}
            >
              {text.clearCacheAndReload}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
