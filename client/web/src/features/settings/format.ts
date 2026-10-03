/** 日期：今年内「10月28日」，跨年「2027年1月3日」。 */
export function formatDay(value: string | number | Date, now: Date = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}年${monthDay}`;
}

/** 本机路径缩写：家目录下显示为 ~/…（完整路径放在 title 里）。 */
export function shortenPath(path: string): string {
  const match = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/.exec(path);
  return match === null ? path : `~${path.slice(match[1]!.length)}`;
}

/** 代理服务端校验信息里的字段名换成界面上的叫法。 */
const PROXY_FIELD_LABEL: Readonly<Record<string, string>> = {
  httpProxy: "HTTP 代理",
  httpsProxy: "HTTPS 代理",
  allProxy: "其他连接的代理",
  noProxy: "不走代理的地址",
};

export function humanizeProxyMessage(message: string): string {
  return message.replace(/\b(httpProxy|httpsProxy|allProxy|noProxy)\b/g, (field) => PROXY_FIELD_LABEL[field] ?? field);
}

/** 模型服务端校验信息里的字段名换成界面上的叫法（D1：不对用户露出接口字段名）。 */
const MODEL_FIELD_LABEL: Readonly<Record<string, string>> = {
  baseUrl: "服务地址",
  apiKey: "API Key",
  model: "默认模型",
  reasoningEffort: "默认推理强度",
  contextWindow: "上下文上限",
};

export function humanizeModelMessage(message: string): string {
  return message.replace(/\b(baseUrl|apiKey|model|reasoningEffort|contextWindow)\b/g, (field) => MODEL_FIELD_LABEL[field] ?? field);
}
