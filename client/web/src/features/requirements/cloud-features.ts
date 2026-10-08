import { useQuery } from "@tanstack/react-query";
import type { CloudFeature } from "@suduo/cloud-contracts";
import { settingsQuery } from "../../app/queries.js";
import { serviceHealthQuery } from "../settings/queries.js";

/**
 * 当前连接的云端是否支持某项功能（`/v2/health` 的 features，经本机服务的连接测试带回）。
 * 还没测到、连不上或较早的云端（不声明 features）都按不支持处理：对应入口先不显示，
 * 避免在旧云端上点了才报错（需求附件评论文件与优先级 技术设计 §三）。
 */
export function useCloudFeature(feature: CloudFeature): boolean {
  const settings = useQuery(settingsQuery);
  const baseUrl = settings.data?.configured === true ? (settings.data.baseUrl ?? "") : "";
  const health = useQuery({ ...serviceHealthQuery(baseUrl), enabled: baseUrl !== "" });
  return health.data?.features?.includes(feature) ?? false;
}
