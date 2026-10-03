export type DensityPreference = "comfortable" | "compact";

const STORAGE_KEY = "suduo.density";
const LEGACY_SCALE_KEY = "suduo.uiScale";

export function loadDensityPreference(): DensityPreference {
  const raw = readStorage(STORAGE_KEY);
  return raw === "compact" ? "compact" : "comfortable";
}

/** 密度只改控件与行高令牌，不像旧版 CSS zoom 那样整体放大，浮层定位不受影响。 */
export function applyDensityPreference(preference: DensityPreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
    localStorage.removeItem(LEGACY_SCALE_KEY);
  } catch {
    // 存储不可用时仅本次会话生效。
  }
  document.documentElement.dataset["density"] = preference;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
