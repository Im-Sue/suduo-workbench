/** 本机地址：SuDuo 工具服务只听 127.0.0.1。 */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

/**
 * 交给 Agent 子进程的环境：NO_PROXY / no_proxy 补上本机地址。Agent 访问 SuDuo 本机 MCP 工具服务时
 * 也会走 HTTP_PROXY / ALL_PROXY（审查实测 Codex 0.159.2）：代理在别的机器上时连不到本机服务，
 * 会话令牌还会明文发给代理。只在启动子进程时加，不改出网代理设置本身（设置清空时要精确还原继承环境）。
 */
export function withLoopbackNoProxy(env: Readonly<Record<string, string>>): Record<string, string> {
  const next = { ...env };
  for (const name of ["NO_PROXY", "no_proxy"]) {
    const entries = (next[name] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    const missing = LOOPBACK_HOSTS.filter((host) => !entries.includes(host));
    next[name] = [...entries, ...missing].join(",");
  }
  return next;
}
