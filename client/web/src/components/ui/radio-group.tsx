import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

function RadioGroup({ className, ...props }: ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root data-slot="radio-group" className={cn("grid gap-2", className)} {...props} />
  );
}

function RadioGroupItem({ className, ...props }: ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] border-border-strong bg-card",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
        "data-[state=checked]:border-primary disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="block size-2 rounded-full bg-primary" />
    </RadioGroupPrimitive.Item>
  );
}

/** 卡片式单选：整块可点，选中描边高亮；用于"每步确认 / 越界时确认 / 完全访问"这类带说明的选项。 */
function RadioCard({
  value,
  title,
  description,
  badge,
  className,
  disabled,
  ...props
}: Omit<ComponentProps<typeof RadioGroupPrimitive.Item>, "value" | "title" | "children"> & {
  value: string;
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <RadioGroupPrimitive.Item
      {...props}
      value={value}
      disabled={disabled}
      data-slot="radio-card"
      className={cn(
        "group flex w-full items-start gap-3 rounded-md border border-border bg-card px-3.5 py-3 text-left",
        "transition-[border-color,box-shadow] duration-(--dur-fast) outline-none hover:border-border-strong",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
        "data-[state=checked]:border-primary data-[state=checked]:shadow-[0_0_0_1px_var(--primary)]",
        "disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
    >
      <span className="mt-[3px] inline-flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] border-border-strong group-data-[state=checked]:border-primary">
        <RadioGroupPrimitive.Indicator className="block size-2 rounded-full bg-primary" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-body font-medium text-foreground">
          {title}
          {badge}
        </span>
        {description === undefined ? null : (
          <span className="text-small text-muted-foreground">{description}</span>
        )}
      </span>
    </RadioGroupPrimitive.Item>
  );
}

/** 图块式单选：内容自定（如主题预览缩略图 + 名称），选中时描边高亮。 */
function RadioTile({
  value,
  className,
  disabled,
  children,
  ...props
}: Omit<ComponentProps<typeof RadioGroupPrimitive.Item>, "value"> & { value: string }) {
  return (
    <RadioGroupPrimitive.Item
      value={value}
      disabled={disabled}
      data-slot="radio-tile"
      className={cn(
        "flex flex-col gap-2 rounded-[10px] border border-border bg-card p-1.5 pb-2.5 text-left text-small font-medium text-foreground",
        "transition-[border-color,box-shadow] duration-(--dur-fast) outline-none hover:border-border-strong",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
        "data-[state=checked]:border-primary data-[state=checked]:shadow-[0_0_0_1px_var(--primary)]",
        "disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
      {...props}
    >
      {children}
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem, RadioCard, RadioTile };
