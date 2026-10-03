import * as TabsPrimitive from "@radix-ui/react-tabs";
import { createContext, useContext, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * 标签页：variant="underline"（默认，页面与面板内分区）/ "segmented"（小范围视图切换）。
 */
type TabsVariant = "underline" | "segmented";
const TabsVariantContext = createContext<TabsVariant>("underline");

const Tabs = TabsPrimitive.Root;

function TabsList({
  className,
  variant = "underline",
  ...props
}: ComponentProps<typeof TabsPrimitive.List> & { variant?: TabsVariant }) {
  return (
    <TabsVariantContext.Provider value={variant}>
      <TabsPrimitive.List
        data-variant={variant}
        className={cn(
          variant === "underline"
            ? "flex items-end gap-5 border-b border-border"
            : "inline-flex items-center gap-0.5 rounded-[7px] border border-border bg-muted p-0.5",
          className,
        )}
        {...props}
      />
    </TabsVariantContext.Provider>
  );
}

function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  const variant = useContext(TabsVariantContext);
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium outline-none transition-colors duration-(--dur-fast)",
        "focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45",
        variant === "underline"
          ? "-mb-px h-10 border-b-2 border-transparent px-0.5 text-small text-subtle-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground"
          : "h-7 rounded-[5px] px-2.5 text-small text-muted-foreground hover:text-foreground data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-raised",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  // Radix 的面板可以 Tab 到（tabIndex=0）：给看得见的焦点环（WCAG 2.4.7）。
  return <TabsPrimitive.Content className={cn("outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset", className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
