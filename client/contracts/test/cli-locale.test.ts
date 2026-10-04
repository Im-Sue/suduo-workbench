import { describe, expect, it } from "vitest";
import { cliLocale } from "../src/index.js";

describe("命令行语言", () => {
  const system = (tag: string | undefined) => () => tag;

  it("SUDUO_LOCALE 显式指定优先；非法值忽略", () => {
    expect(cliLocale({ SUDUO_LOCALE: "en", LANG: "zh_CN.UTF-8" }, system("zh-CN"))).toBe("en");
    expect(cliLocale({ SUDUO_LOCALE: "zh-CN", LANG: "en_US.UTF-8" }, system("en-US"))).toBe("zh-CN");
    expect(cliLocale({ SUDUO_LOCALE: "fr", LANG: "zh_CN.UTF-8" }, system("en-US"))).toBe("zh-CN");
  });

  it("LC_ALL → LC_MESSAGES → LANG；zh 开头为中文，C / POSIX 与其它为英文", () => {
    expect(cliLocale({ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" }, system("zh-CN"))).toBe("en");
    expect(cliLocale({ LC_MESSAGES: "zh_TW.UTF-8", LANG: "en_US.UTF-8" }, system("en-US"))).toBe("zh-CN");
    expect(cliLocale({ LANG: "zh_CN.UTF-8" }, system("en-US"))).toBe("zh-CN");
    expect(cliLocale({ LANG: "C.UTF-8" }, system("zh-CN"))).toBe("en");
    expect(cliLocale({ LANG: "POSIX" }, system("zh-CN"))).toBe("en");
  });

  it("都没设时看系统区域（Windows 一般不设 LANG）；也取不到时为英文", () => {
    expect(cliLocale({}, system("zh-Hans-CN"))).toBe("zh-CN");
    expect(cliLocale({}, system("en-GB"))).toBe("en");
    expect(cliLocale({ LANG: "  " }, system(undefined))).toBe("en");
  });
});
