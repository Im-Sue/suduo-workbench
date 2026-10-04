import { cliLocale } from "@suduo/client-contracts";
import { join } from "node:path";
import { messagesFor, type ServerMessages } from "../../i18n/messages/index.js";
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
      throw new Error(cliText().requirementsSettingsInvalid);
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
    throw new Error(cliText().serverAddressEmpty);
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch (error) {
    throw new Error(cliText().serverAddressNotUrl, { cause: error });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(cliText().serverAddressProtocol);
  }
  if (parsed.username || parsed.password) {
    throw new Error(cliText().serverAddressCredentials);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(cliText().serverAddressOriginOnly);
  }
  return parsed.origin;
}

/**
 * 这里的报错不带请求语言，按这个进程的系统语言（中英双语 S8）：启动时由 SUDUO_REQUIREMENTS_SERVICE_URL
 * 写入或读到坏的配置文件时直接出现在命令行。界面改地址时设置接口另换成按请求语言的说明（remote.validation）。
 * 运行中读到被改坏的文件时，经接口的统一错误处理只显示按请求语言的「服务端处理请求失败」；拼进别的说明时
 * （`errorTextOf`：本机 Agent 状态、「我的工作」分块报错、共享 Agent 任务原因）是这里的原文。
 */
function cliText(): ServerMessages["cli"] {
  return messagesFor(cliLocale(process.env)).cli;
}
