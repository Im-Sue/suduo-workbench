import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge 必须认识设计令牌里自定义的字号与阴影名，
 * 否则会把 `text-small` 当成文字颜色，与 `text-primary-foreground` 互相吞掉。
 * 新增 @theme 字号 / 阴影令牌时同步登记在这里。
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["caption", "small", "body", "section", "page", "display"],
      shadow: ["raised", "overlay", "dialog"],
    },
  },
});

/** shadcn 惯例的 className 合并器：条件类 + Tailwind 冲突消解。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
