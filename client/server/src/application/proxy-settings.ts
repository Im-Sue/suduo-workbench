import type { ServerMessages } from "../i18n/messages/index.js";
import { ApiError } from "./api-error.js";

export interface ProxySettings {
  httpProxy: string;
  httpsProxy: string;
  allProxy: string;
  noProxy: string;
}

export const EMPTY_PROXY_SETTINGS: ProxySettings = {
  httpProxy: "",
  httpsProxy: "",
  allProxy: "",
  noProxy: "",
};

const PROXY_FIELDS = ["httpProxy", "httpsProxy", "allProxy"] as const;
const PROXY_ENVIRONMENT: ReadonlyArray<{
  field: keyof ProxySettings;
  names: readonly string[];
}> = [
  { field: "httpProxy", names: ["HTTP_PROXY", "http_proxy"] },
  { field: "httpsProxy", names: ["HTTPS_PROXY", "https_proxy"] },
  { field: "allProxy", names: ["ALL_PROXY", "all_proxy"] },
  { field: "noProxy", names: ["NO_PROXY", "no_proxy"] },
];

/**
 * 解析一次 PATCH / 自检请求中的代理字段；未给出的字段沿用已保存值。
 * URL 中的用户名、密码不属于本期支持范围，保存前明确拒绝。
 */
export function resolveProxySettings(
  input: Record<string, unknown>,
  current: ProxySettings,
): ProxySettings {
  const next = { ...current };
  for (const field of PROXY_FIELDS) {
    if (input[field] !== undefined) {
      next[field] = validateProxyUrl(field, input[field]);
    }
  }
  if (input["noProxy"] !== undefined) {
    next.noProxy = validateNoProxy(input["noProxy"]);
  }
  return next;
}

/**
 * 将设置层覆盖到给 Codex 子进程使用的环境对象。空设置不删除或留住上次
 * 覆盖值，而是精确还原服务启动时继承的原始环境。
 */
export function applyProxySettings(
  target: Record<string, string>,
  inherited: Readonly<Record<string, string>>,
  settings: ProxySettings,
): void {
  for (const { field, names } of PROXY_ENVIRONMENT) {
    for (const name of names) {
      if (settings[field] !== "") {
        target[name] = settings[field];
      } else {
        restoreEnvironmentValue(target, inherited, name);
      }
    }
  }
}

/** 报错里的字段用界面上的叫法（config.fields.proxy），不露接口字段名。 */
function validateProxyUrl(field: (typeof PROXY_FIELDS)[number], value: unknown): string {
  const label = (t: ServerMessages) => t.config.fields.proxy[field];
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.config.mustBeString(label(t)));
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.config.proxy.invalidUrl(label(t)));
  }
  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:" &&
    parsed.protocol !== "socks5:" &&
    parsed.protocol !== "socks5h:"
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.config.proxy.unsupportedProtocol(label(t)));
  }
  if (parsed.hostname === "") {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.config.proxy.hostRequired(label(t)));
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.config.proxy.credentialsUnsupported(label(t)));
  }
  if (
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.config.proxy.extraPartsUnsupported(label(t)));
  }
  return trimmed;
}

function validateNoProxy(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.config.mustBeString(t.config.fields.proxy.noProxy));
  }
  const trimmed = value.trim();
  if (/\r|\n/u.test(trimmed)) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.config.proxy.noLineBreaks(t.config.fields.proxy.noProxy));
  }
  return trimmed;
}

function restoreEnvironmentValue(
  target: Record<string, string>,
  inherited: Readonly<Record<string, string>>,
  name: string,
): void {
  const value = inherited[name];
  if (value === undefined) {
    delete target[name];
  } else {
    target[name] = value;
  }
}
