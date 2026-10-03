export interface RequirementsHealthDto {
  service: "suduo-requirements-service";
  status: "ok";
  database: {
    status: "ok";
    schemaVersion: string;
  };
  uptimeMs: number;
}
