import { AGENT_SHARE_DURATIONS, type AgentShareDuration } from "@suduo/cloud-contracts";

/**
 * 「共享多久」上次选的档（个人偏好，只记在本浏览器）：还没共享时面板默认选它，没记过为「今天」。
 * 存储不可用或读到坏数据时当没记过。
 */
export const SHARE_DURATION_KEY = "suduo.roomShare.duration";

export function readShareDuration(): AgentShareDuration {
  try {
    const raw = localStorage.getItem(SHARE_DURATION_KEY);
    return AGENT_SHARE_DURATIONS.find((value) => value === raw) ?? "today";
  } catch {
    return "today";
  }
}

export function writeShareDuration(duration: AgentShareDuration): void {
  try {
    localStorage.setItem(SHARE_DURATION_KEY, duration);
  } catch {
    // 记不住只影响下次打开面板时的默认档。
  }
}
