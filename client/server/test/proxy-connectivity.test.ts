import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { probeModelGateway } from "../src/application/proxy-connectivity-service.js";
import { EMPTY_PROXY_SETTINGS } from "../src/application/proxy-settings.js";
import { messagesFor } from "../src/i18n/messages/index.js";

describe("试连模型服务的失败原因（界面据此说明，不解析文字）", () => {
  it("服务地址无效", async () => {
    const result = await probeModelGateway("ftp://models.example", EMPTY_PROXY_SETTINGS, messagesFor("zh-CN"));
    expect(result).toMatchObject({ reachable: false, failure: { reason: "invalid-base-url" } });
  });

  it("代理设置无效", async () => {
    const result = await probeModelGateway("https://models.example/v1", {
      ...EMPTY_PROXY_SETTINGS,
      httpsProxy: "not a url",
    }, messagesFor("zh-CN"));
    expect(result).toMatchObject({ reachable: false, failure: { reason: "invalid-proxy" } });
  });

  it("连不上时带网络错误码", async () => {
    // 先占一个临时端口再关掉，确保这个端口上没有服务、连接会被立即拒绝（不依赖固定端口的环境）。
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const free = typeof address === "object" && address !== null ? address.port : 0;
        server.close(() => resolve(free));
      });
    });
    const result = await probeModelGateway(`http://127.0.0.1:${String(port)}/v1`, EMPTY_PROXY_SETTINGS, messagesFor("zh-CN"));
    expect(result).toMatchObject({
      reachable: false,
      usingProxy: false,
      failure: { reason: "unreachable", networkCode: "ECONNREFUSED" },
    });
  });
});
