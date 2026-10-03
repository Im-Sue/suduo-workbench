/** 浮层与菜单项的共用外观：Select / DropdownMenu / Command / Popover 保持一致。 */
export const overlaySurface =
  "z-70 overflow-hidden rounded-md bg-popover text-popover-foreground shadow-overlay";

export const overlayMotion = [
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
  "data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1",
].join(" ");

/** 菜单项外观（不含禁用规则）：Radix 与 cmdk 的禁用属性写法不同，各自补。 */
export const menuItemBase = [
  "relative flex min-h-[30px] w-full cursor-default select-none items-center gap-2 rounded-[5px] px-2 py-1 text-small text-foreground outline-none",
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg]:text-muted-foreground",
].join(" ");

/** Radix 菜单项：禁用时写 data-disabled=""，高亮写 data-highlighted。 */
export const menuItem = [
  menuItemBase,
  "data-[highlighted]:bg-popover-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
].join(" ");

export const menuLabel = "px-2 pt-1.5 pb-1 text-caption text-subtle-foreground";

export const menuSeparator = "-mx-1 my-1 h-px bg-border";
