export interface RequirementsHealthDto {
  service: "suduo-requirements-service";
  status: "ok";
  /** 产品版本（与 cloud/package.json 一致）。较早的服务端不返回这一项。 */
  version?: string;
  database: {
    status: "ok";
    schemaVersion: string;
  };
  uptimeMs: number;
}
