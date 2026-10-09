import { createContext, useContext } from "react";

/**
 * 会话页的「共享到需求」（多 Agent 协作 S11）：只有需求会话能发布；时间线上的草稿卡、评审卡据此给入口，
 * 打开发布对话框由会话页统一管。
 */
export interface ShareActions {
  canPublish: boolean;
  openDraft(draftId: string): void;
}

export const ShareContext = createContext<ShareActions>({ canPublish: false, openDraft: () => undefined });

export function useShare(): ShareActions {
  return useContext(ShareContext);
}
