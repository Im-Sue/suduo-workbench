import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyProxySettings } from "../src/application/proxy-settings.js";
import { SettingsService } from "../src/application/settings-service.js";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("G 出网代理设置", () => {
  it("注入大小写代理变量；清空后精确恢复服务启动时继承环境并触发热重连", async () => {
    const root = mkdtempSync(join(tmpdir(), "suduo-proxy-settings-"));
    temporaryPaths.push(root);
    const settings = new SettingsService(join(root, "settings.json"));
    const inherited = {
      HTTP_PROXY: "http://ambient.test:8080",
      http_proxy: "http://ambient.test:8080",
      NO_PROXY: "localhost",
      no_proxy: "localhost",
    };
    const runtimeEnvironment = { ...inherited };
    let restarts = 0;
    settings.setProxySettingsChangedHandler(async () => {
      applyProxySettings(runtimeEnvironment, inherited, settings.proxySettings());
      restarts += 1;
    });

    await settings.update({
      httpProxy: "http://127.0.0.1:7890",
      allProxy: "socks5h://127.0.0.1:7890",
      noProxy: "localhost,.internal.test",
    });

    expect(settings.get()).toMatchObject({
      httpProxy: "http://127.0.0.1:7890",
      allProxy: "socks5h://127.0.0.1:7890",
      noProxy: "localhost,.internal.test",
    });
    expect(runtimeEnvironment).toMatchObject({
      HTTP_PROXY: "http://127.0.0.1:7890",
      http_proxy: "http://127.0.0.1:7890",
      ALL_PROXY: "socks5h://127.0.0.1:7890",
      all_proxy: "socks5h://127.0.0.1:7890",
      NO_PROXY: "localhost,.internal.test",
      no_proxy: "localhost,.internal.test",
    });
    expect(restarts).toBe(1);

    await settings.update({ httpProxy: "", allProxy: "", noProxy: "" });

    expect(runtimeEnvironment).toEqual(inherited);
    expect(restarts).toBe(2);
  });

  // 报错里的字段用界面上的叫法（与以前前端把字段名换成界面叫法后的文字逐字相同）。
  it("拒绝非法、带鉴权或非字符串的代理值，并给出可读诊断", async () => {
    const root = mkdtempSync(join(tmpdir(), "suduo-proxy-settings-"));
    temporaryPaths.push(root);
    const settings = new SettingsService(join(root, "settings.json"));

    await expect(settings.update({ httpProxy: "not-a-url" })).rejects.toMatchObject({
      statusCode: 400,
      message: "HTTP 代理 不是合法代理 URL",
    });
    await expect(settings.update({ httpsProxy: "http://user:pass@proxy.test" })).rejects.toMatchObject({
      statusCode: 400,
      message: "HTTPS 代理 暂不支持带用户名或密码的代理",
    });
    await expect(settings.update({ allProxy: 42 as unknown as string })).rejects.toMatchObject({
      statusCode: 400,
      message: "其他连接的代理 必须是字符串",
    });
  });
});
