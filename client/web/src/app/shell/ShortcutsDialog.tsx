import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { keyLabel, SHORTCUT_GROUPS } from "../shortcuts.js";
import { setShortcutsOpen, useShortcutsOpen } from "./shell-actions.js";

/** 「?」快捷键一览：只读 app/shortcuts.ts 的清单。 */
export function ShortcutsDialog() {
  const open = useShortcutsOpen();
  return (
    <Dialog open={open} onOpenChange={setShortcutsOpen}>
      <DialogContent size="lg" data-testid="shortcuts-dialog">
        <DialogHeader>
          <DialogTitle>快捷键</DialogTitle>
          <DialogDescription>单键快捷键在输入框里不生效；输入框里能用的，写在「写需求」「会话输入框」两组或标了「输入框里也可用」。</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[66vh] grid-cols-1 gap-x-8 gap-y-5 overflow-y-auto md:grid-cols-2">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} aria-label={group.title} className="flex flex-col gap-1.5">
              <h3 className="m-0 flex items-baseline gap-2 text-small font-semibold text-foreground">
                {group.title}
                {group.scope === undefined ? null : <span className="text-caption font-normal text-subtle-foreground">{group.scope}</span>}
              </h3>
              <dl className="m-0 flex flex-col">
                {group.items.map((item) => (
                  <div key={item.description} className="flex min-h-8 items-center justify-between gap-3 border-b border-border py-1 last:border-b-0">
                    <dt className="text-small text-muted-foreground">{item.description}</dt>
                    <dd className="m-0 flex shrink-0 items-center gap-1">
                      {item.keys.map((combo, index) => (
                        <span key={combo.join("+")} className="flex items-center gap-1">
                          {index === 0 ? null : <span className="text-caption text-subtle-foreground">{combo[0] === "…" || item.keys[index - 1]?.[0] === "…" ? "" : "或"}</span>}
                          {combo[0] === "…" ? (
                            <span className="text-caption text-subtle-foreground">…</span>
                          ) : (
                            combo.map((key) => <Kbd key={key}>{keyLabel(key)}</Kbd>)
                          )}
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
