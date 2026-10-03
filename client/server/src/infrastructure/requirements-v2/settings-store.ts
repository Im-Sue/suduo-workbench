import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "./local-json-store.js";

interface StoredRequirementsSettings {
  schemaVersion: 1;
  baseUrl: string;
}

export class RequirementsSettingsStore {
  private readonly filePath: string;

  constructor(dataDirectory: string, defaultBaseUrl?: string) {
    this.filePath = join(dataDirectory, "requirements-service.json");
    if (defaultBaseUrl && !this.getBaseUrl()) {
      this.setBaseUrl(defaultBaseUrl);
    }
  }

  getBaseUrl(): string | null {
    const value = readPrivateJson<StoredRequirementsSettings>(this.filePath);
    if (!value) {
      return null;
    }
    if (value.schemaVersion !== 1 || typeof value.baseUrl !== "string") {
      throw new Error("V2 本机远程服务配置格式无效");
    }
    return normalizeRequirementsServiceUrl(value.baseUrl);
  }

  setBaseUrl(value: string): string {
    const baseUrl = normalizeRequirementsServiceUrl(value);
    writePrivateJson(this.filePath, { schemaVersion: 1, baseUrl });
    return baseUrl;
  }
}

export function normalizeRequirementsServiceUrl(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("远程服务地址不能为空");
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch (error) {
    throw new Error("远程服务地址不是有效 URL", { cause: error });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("远程服务地址仅支持 http 或 https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("远程服务地址不允许包含用户名或密码");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("远程服务地址只能是协议、主机和可选端口");
  }
  return parsed.origin;
}
