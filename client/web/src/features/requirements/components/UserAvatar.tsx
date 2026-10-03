import type { UserSummaryDto } from "@suduo/cloud-contracts";
import { UserRoundIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/** 人员头像：同一个人各处同色；未指派时显示虚线圆圈。 */
export function UserAvatar({
  user,
  size = "md",
  className,
}: {
  user: UserSummaryDto | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  if (user === null) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-border-strong text-disabled-foreground",
          size === "sm" && "size-4",
          size === "md" && "size-5",
          size === "lg" && "size-7",
          className,
        )}
      >
        <UserRoundIcon className="size-3" />
      </span>
    );
  }
  return (
    <Avatar size={size} className={className} aria-hidden="true">
      <AvatarFallback name={user.displayName} />
    </Avatar>
  );
}
