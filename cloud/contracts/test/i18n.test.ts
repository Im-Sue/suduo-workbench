import { describe, expect, it } from "vitest";
import {
  isLocale,
  isLocalePreference,
  localeFromAcceptLanguage,
  localeFromTag,
  plural,
  resolveLocale,
} from "../src/index.js";

describe("语言解析", () => {
  it("语言标签以 zh 开头归到 zh-CN，其余归到 en", () => {
    expect(localeFromTag("zh-CN")).toBe("zh-CN");
    expect(localeFromTag("zh-TW")).toBe("zh-CN");
    expect(localeFromTag("zh")).toBe("zh-CN");
    expect(localeFromTag("ZH_cn")).toBe("zh-CN");
    expect(localeFromTag("en-US")).toBe("en");
    expect(localeFromTag("ja")).toBe("en");
    expect(localeFromTag("zhuang")).toBe("en");
    expect(localeFromTag("")).toBeNull();
    expect(localeFromTag(undefined)).toBeNull();
  });

  it("固定偏好直接用，跟随系统按标签，且只落在可用语言里", () => {
    expect(resolveLocale("en", "zh-CN")).toBe("en");
    expect(resolveLocale("zh-CN", "en-US")).toBe("zh-CN");
    expect(resolveLocale("system", "en-US")).toBe("en");
    expect(resolveLocale("system", "zh-HK")).toBe("zh-CN");
    expect(resolveLocale("system", "en-US", ["zh-CN"])).toBe("zh-CN");
    expect(resolveLocale("system", null, ["en", "zh-CN"])).toBe("en");
  });

  it("Accept-Language 按权重取第一个能用的语言", () => {
    expect(localeFromAcceptLanguage("en-US,en;q=0.9,zh-CN;q=0.8")).toBe("en");
    expect(localeFromAcceptLanguage("zh-CN;q=0.5, en;q=0.9")).toBe("en");
    expect(localeFromAcceptLanguage("fr;q=0, zh;q=0.4")).toBe("zh-CN");
    expect(localeFromAcceptLanguage("*")).toBeNull();
    expect(localeFromAcceptLanguage("")).toBeNull();
    expect(localeFromAcceptLanguage(undefined)).toBeNull();
  });

  it("类型守卫", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("system")).toBe(false);
    expect(isLocalePreference("system")).toBe(true);
    expect(isLocalePreference("fr")).toBe(false);
  });
});

describe("单复数", () => {
  it("英文区分 one / other，中文只用 other", () => {
    const forms = { one: "1 file", other: "many files" };
    expect(plural("en", 1, forms)).toBe("1 file");
    expect(plural("en", 2, forms)).toBe("many files");
    expect(plural("en", 0, forms)).toBe("many files");
    expect(plural("zh-CN", 1, { other: "1 个文件" })).toBe("1 个文件");
    expect(plural("en", 1, { other: "files" })).toBe("files");
  });
});
