/**
 * 云端声明自己支持的功能（需求附件评论文件与优先级）。客户端据此显示或隐藏对应入口，
 * 不靠比较版本号；较早的服务端不返回 `features`，按「都不支持」处理。
 */
export const CLOUD_FEATURES = ["requirement_priority", "comment_files"] as const;

export type CloudFeature = (typeof CLOUD_FEATURES)[number];

export interface RequirementsHealthDto {
  service: "suduo-requirements-service";
  status: "ok";
  /** 产品版本（与 cloud/package.json 一致）。较早的服务端不返回这一项。 */
  version?: string;
  /** 支持的功能，见 `CLOUD_FEATURES`。较早的服务端不返回这一项。 */
  features?: CloudFeature[];
  database: {
    status: "ok";
    schemaVersion: string;
  };
  uptimeMs: number;
}
