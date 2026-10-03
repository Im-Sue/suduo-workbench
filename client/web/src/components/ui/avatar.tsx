import * as AvatarPrimitive from "@radix-ui/react-avatar";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const AVATAR_TONES = ["#2f6f5e", "#8a4fb8", "#b5651d", "#3451d1", "#0f7a8a", "#a3485f", "#5b6b2f"] as const;

/** 由名字稳定映射到一种头像底色：同一个人在各处颜色一致。 */
function avatarTone(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? AVATAR_TONES[0];
}

function Avatar({
  className,
  size = "md",
  ...props
}: ComponentProps<typeof AvatarPrimitive.Root> & { size?: "sm" | "md" | "lg" }) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn(
        "relative inline-flex shrink-0 overflow-hidden rounded-full",
        size === "sm" && "size-4 text-[9px]",
        size === "md" && "size-5 text-[11px]",
        size === "lg" && "size-7 text-caption",
        className,
      )}
      {...props}
    />
  );
}

function AvatarImage({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Image>) {
  return <AvatarPrimitive.Image className={cn("aspect-square size-full", className)} {...props} />;
}

function AvatarFallback({
  className,
  name,
  style,
  children,
  ...props
}: ComponentProps<typeof AvatarPrimitive.Fallback> & { name?: string }) {
  return (
    <AvatarPrimitive.Fallback
      className={cn(
        "flex size-full items-center justify-center font-semibold",
        name === undefined ? "bg-muted text-muted-foreground" : "text-white",
        className,
      )}
      style={name === undefined ? style : { backgroundColor: avatarTone(name), ...style }}
      {...props}
    >
      {children ?? (name === undefined ? null : Array.from(name)[0])}
    </AvatarPrimitive.Fallback>
  );
}

export { Avatar, AvatarImage, AvatarFallback, avatarTone };
