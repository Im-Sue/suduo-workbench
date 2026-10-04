import { describe, expect, it } from "vitest";
import { containsCjk } from "./untranslated-audit.js";
import { browserLocaleOf, gateLocaleFromEnv, loadGateUiText, templateParts, type GateUiText } from "./ui-text.js";

/** 把文字表摊平成「路径 → 文字」，函数按一个示例参数展开。 */
function flatten(value: unknown, prefix = ""): [string, string][] {
  if (typeof value === "string") return [[prefix, value]];
  if (typeof value === "function") return [[prefix, String((value as (input: string) => unknown)("X"))]];
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => flatten(item, prefix === "" ? key : `${prefix}.${key}`));
  }
  return [];
}

describe("gate-c 验收语言", () => {
  it("不设或空 = 中文；只认 zh-CN / en，写错立刻报错", () => {
    expect(gateLocaleFromEnv(undefined)).toBe("zh-CN");
    expect(gateLocaleFromEnv("")).toBe("zh-CN");
    expect(gateLocaleFromEnv(" en ")).toBe("en");
    expect(gateLocaleFromEnv("zh-CN")).toBe("zh-CN");
    expect(() => gateLocaleFromEnv("fr")).toThrow(/SUDUO_GATE_LOCALE/);
    expect(browserLocaleOf("zh-CN")).toBe("zh-CN");
    expect(browserLocaleOf("en")).toBe("en-US");
  });

  it("模板参数前后两段", () => {
    expect(templateParts((value) => `前${value}后`)).toEqual(["前", "后"]);
    expect(() => templateParts((value) => `${value}${value}`)).toThrow();
  });
});

describe("gate-c 界面文字取自前端字典", () => {
  it("中文与改动前步骤里写死的文字逐字相同（中文全量行为不变）", async () => {
    const ui = await loadGateUiText("zh-CN");
    expect(ui.login).toEqual({ title: "登录 SuDuo", loginName: "登录名", password: "密码", submit: "登录" });
    expect(ui.projectSwitcher("Gate C 远程项目")).toBe("切换项目：Gate C 远程项目");
    expect(ui.palette).toEqual({ title: "搜索或执行命令", startProjectSession: "在本机开始项目会话", query: "项目会话" });
    expect(ui.startSession.directoryTitle).toBe("选择本机代码目录");
    expect(ui.startSession.createNew).toBe("新开一个会话");
    expect(ui.startSession.failed).toBe("没能开始会话");
    expect(ui.startSession.manual).toBe("手动输入路径");
    expect(ui.startSession.manualLabel).toBe("代码目录的绝对路径");
    expect(ui.startSession.useDirectory).toBe("使用这个目录");
    // 原来只认「可以读写」：两种可读写结论都以它开头，等价。
    for (const verdict of ui.startSession.readable) expect(verdict.startsWith("可以读写")).toBe(true);
    expect(ui.nav).toMatchObject({ myWork: "我的工作", requirements: "需求", sessions: "会话", overview: "概览", settings: "设置" });
  });

  it("英文文字齐全且不含中文（各语言自己写法的语言名除外）", async () => {
    const ui: GateUiText = await loadGateUiText("en");
    expect(ui.locale).toBe("en");
    expect(ui.nativeLocaleNames).toEqual(["简体中文"]);
    const withCjk = flatten({ ...ui, nativeLocaleNames: [] })
      .filter(([path]) => path !== "settings.localeOption.zh-CN")
      .filter(([, text]) => containsCjk(text));
    expect(withCjk).toEqual([]);
    expect(ui.startSession.readable).toHaveLength(2);
    expect(ui.settings.lockReason[0].length + ui.settings.lockReason[1].length).toBeGreaterThan(0);
    expect(ui.palette.query).toBe(ui.palette.startProjectSession);
  });
});
