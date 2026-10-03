import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDensityPreference, loadDensityPreference } from "../src/ui/density.js";
import { applyThemePreference, loadThemePreference, resolveTheme } from "../src/ui/theme.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

let systemDark = false;
const listeners = new Set<() => void>();

beforeEach(() => {
  systemDark = false;
  listeners.clear();
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("document", { documentElement: { dataset: {} }, querySelector: () => null });
  vi.stubGlobal("window", {
    matchMedia: () => ({
      get matches() { return systemDark; },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("本机外观偏好", () => {
  it("主题默认跟随系统，非法值同样回退跟随系统", () => {
    expect(loadThemePreference()).toBe("system");
    localStorage.setItem("suduo.theme", "invalid");
    expect(loadThemePreference()).toBe("system");
  });

  it("固定主题直接写入根元素；跟随系统时解析并持续监听系统变化", () => {
    applyThemePreference("light");
    expect(localStorage.getItem("suduo.theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");

    systemDark = true;
    applyThemePreference("system");
    expect(resolveTheme("system")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    systemDark = false;
    for (const listener of listeners) listener();
    expect(document.documentElement.dataset.theme).toBe("light");

    applyThemePreference("dark");
    expect(listeners.size).toBe(0);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("密度只有舒适与紧凑两档，并清理旧的缩放偏好", () => {
    localStorage.setItem("suduo.uiScale", "large");
    expect(loadDensityPreference()).toBe("comfortable");

    applyDensityPreference("compact");
    expect(localStorage.getItem("suduo.density")).toBe("compact");
    expect(localStorage.getItem("suduo.uiScale")).toBeNull();
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(loadDensityPreference()).toBe("compact");
  });
});
