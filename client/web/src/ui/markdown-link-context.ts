import { createContext } from "react";
import type { FileExistenceStore } from "./file-existence.js";

/**
 * Markdown 里文件链接的处理方（需求 4.6）。会话页提供：点击项目内的文件链接，在右侧文件面板打开并定位到行。
 * 没有提供方的地方（需求页等），文件路径形状的链接只显示文字。
 */
export interface MarkdownLinkHandlers {
  /**
   * path 是项目内相对路径；line 从 1 开始，没有行号时为 null。
   * external = ⌘ / Ctrl 点击：用本机编辑器打开，而不是右侧面板预览。
   */
  onOpenPath?(path: string, line: number | null, options?: { external: boolean }): void;
  /** 项目目录绝对路径：用来把项目内的绝对路径换成相对路径；不知道时为空串。 */
  projectRoot?: string;
  /**
   * 文件存在确认（会话回答里的文件路径可点击）：有它时，行内代码与正文里的路径确认存在后才变成链接；
   * 没有时行内代码与正文不做识别，只有 Markdown 链接可点。
   */
  files?: FileExistenceStore;
}

export const MarkdownLinkContext = createContext<MarkdownLinkHandlers>({});
