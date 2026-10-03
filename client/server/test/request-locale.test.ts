import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { Locale } from "@suduo/client-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsService } from "../src/application/settings-service.js";
import { registerRequestLocale, resolveRequestLocale } from "../src/i18n/locale.js";
import { messagesFor } from "../src/i18n/messages/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function settingsFile(): string {
  const root = mkdtempSync(join(tmpdir(), "suduo-locale-"));
  roots.push(root);
  return join(root, "settings.json");
}

describe("请求语言的回退链", () => {
  it("请求头 → 已同步的语言 → Accept-Language → en", () => {
    expect(resolveRequestLocale({ header: "zh-CN", stored: "en", acceptLanguage: "en" })).toBe("zh-CN");
    expect(resolveRequestLocale({ header: "fr", stored: "en", acceptLanguage: "zh-CN" })).toBe("en");
    expect(resolveRequestLocale({ header: undefined, stored: null, acceptLanguage: "zh-CN,zh;q=0.9" })).toBe("zh-CN");
    expect(resolveRequestLocale({ header: ["en", "zh-CN"], stored: null, acceptLanguage: undefined })).toBe("en");
  });

  it("挂在每个请求上，并记住请求头带来的语言", async () => {
    const settings = new SettingsService(settingsFile(), {});
    const server = Fastify();
    registerRequestLocale(server, settings);
    server.get("/probe", async (request) => ({ locale: request.locale }));
    const probe = async (headers: Record<string, string>) =>
      (await server.inject({ method: "GET", url: "/probe", headers })).json() as { locale: Locale };

    expect(await probe({})).toEqual({ locale: "en" });
    expect(await probe({ "accept-language": "zh-TW" })).toEqual({ locale: "zh-CN" });
    expect(settings.locale()).toBeNull();
    expect(await probe({ "x-suduo-locale": "zh-CN" })).toEqual({ locale: "zh-CN" });
    expect(settings.locale()).toBe("zh-CN");
    // EventSource 这类带不了头的请求沿用最近一次的语言，而不是 Accept-Language。
    expect(await probe({ "accept-language": "en-US" })).toEqual({ locale: "zh-CN" });
    expect(await probe({ "x-suduo-locale": "fr" })).toEqual({ locale: "zh-CN" });
    await server.close();
  });
});

describe("记下的界面语言", () => {
  it("默认为 null；记下后存进 settings.locale.json，重启后读回", () => {
    const file = settingsFile();
    const settings = new SettingsService(file, {});
    expect(settings.get().locale).toBeNull();
    settings.rememberLocale("en");
    expect(settings.get().locale).toBe("en");
    expect(JSON.parse(readFileSync(file.replace(/\.json$/, ".locale.json"), "utf8"))).toEqual({ locale: "en" });
    expect(existsSync(file)).toBe(false);
    expect(new SettingsService(file, {}).get().locale).toBe("en");
  });

  it("不碰 settings.json：手改坏的设置文件保持原样，不会被覆盖成默认值", () => {
    const file = settingsFile();
    const broken = '{ "httpsProxy": "http://proxy.internal:3128", }';
    writeFileSync(file, broken);
    const settings = new SettingsService(file, {});
    settings.rememberLocale("zh-CN");
    expect(readFileSync(file, "utf8")).toBe(broken);
  });

  it("文件里的坏值当作没记过；写不进去只记日志、不抛错", () => {
    const file = settingsFile();
    writeFileSync(file.replace(/\.json$/, ".locale.json"), JSON.stringify({ locale: "system" }));
    expect(new SettingsService(file, {}).get().locale).toBeNull();

    // 数据目录的位置被一个普通文件占着：建不了目录，写不进去。
    const blocker = settingsFile();
    writeFileSync(blocker, "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const settings = new SettingsService(join(blocker, "settings.json"), {});
    expect(() => settings.rememberLocale("en")).not.toThrow();
    expect(settings.locale()).toBe("en");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("本机服务字典", () => {
  it("按语言取字典", () => {
    expect(messagesFor("zh-CN").checkpoint.restoredTo("abc1234")).toBe("还原到 abc1234");
    expect(messagesFor("en").checkpoint.restoredTo("abc1234")).toBe("Restored to abc1234");
  });
});
