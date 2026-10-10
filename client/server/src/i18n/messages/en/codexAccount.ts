import type { codexAccount as zh } from "../zh-CN/codexAccount.js";

/** English for signing in to Codex with a ChatGPT account (desktop D2). */
export const codexAccount: typeof zh = {
  codexFailed: (detail: string) => `Couldn't talk to Codex: ${detail}`,
  invalidResponse: "Codex didn't return a usable sign-in address. Try again later.",
  loginNotFound: "This sign-in has ended or doesn't exist. Start a new one.",
};
