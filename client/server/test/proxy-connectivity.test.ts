import { describe, expect, it } from "vitest";
import { probeModelGateway } from "../src/application/proxy-connectivity-service.js";
import { EMPTY_PROXY_SETTINGS } from "../src/application/proxy-settings.js";

describe("试连模型服务的失败原因（界面据此说明，不解析文字）", () => {
  it("服务地址无效", async () => {
    const result = await probeModelGateway("ftp://models.example", EMPTY_PROXY_SETTINGS);
    expect(result).toMatchObject({ reachable: false, failure: { reason: "invalid-base-url" } });
  });

  it("代理设置无效", async () => {
    const result = await probeModelGateway("https://models.example/v1", {
      ...EMPTY_PROXY_SETTINGS,
      httpsProxy: "not a url",
    });
    expect(result).toMatchObject({ reachable: false, failure: { reason: "invalid-proxy" } });
  });

  it("连不上时带网络错误码", async () => {
    const result = await probeModelGateway("http://127.0.0.1:1/v1", EMPTY_PROXY_SETTINGS);
    expect(result).toMatchObject({
      reachable: false,
      usingProxy: false,
      failure: { reason: "unreachable", networkCode: "ECONNREFUSED" },
    });
  });
});
