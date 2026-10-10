/**
 * Codex 账号（桌面应用 D2，需求 4.5）：用 ChatGPT 账号登录 Codex。走 Codex 自己的登录流程（app-server 的
 * account/login），凭据由 Codex 写进它自己的配置目录；SuDuo 只拿到授权地址和登录结果（R4）。源码运行同样能用。
 */

/** GET /api/v1/codex/account。 */
export interface CodexAccountDto {
  /** chatgpt：用 ChatGPT 账号登录；apiKey：用 API Key；other：别的方式（如 Amazon Bedrock）；none：还没登录。 */
  mode: "chatgpt" | "apiKey" | "other" | "none";
  email: string | null;
  plan: string | null;
  /** 当前用的模型服务要不要 OpenAI 的登录（用自定义模型服务时为 false，ChatGPT 登录对它不起作用）。 */
  requiresOpenaiAuth: boolean;
}

/** POST /api/v1/codex/account/login：开始登录，前端在系统浏览器里打开 authUrl。 */
export interface CodexLoginStartDto {
  loginId: string;
  authUrl: string;
}

/** GET /api/v1/codex/account/login/:loginId。 */
export interface CodexLoginStatusDto {
  status: "pending" | "succeeded" | "failed" | "cancelled";
  error: string | null;
}
