/** 用 ChatGPT 账号登录 Codex（桌面应用 D2）。 */
export const codexAccount = {
  codexFailed: (detail: string) => `没能和 Codex 通信：${detail}`,
  invalidResponse: "Codex 没有给出可用的登录地址，请稍后再试。",
  loginNotFound: "这次登录已经结束或不存在，请重新登录。",
};
