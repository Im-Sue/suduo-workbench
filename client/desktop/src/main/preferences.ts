import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 外壳偏好 desktop.json（技术设计 §六）。 */
export interface DesktopPreferences {
  schemaVersion: 1;
  /** 外壳给自己拉起的本机服务分配的实例标识，随 /healthz 带出，用来认出「上次自己留下的服务」。 */
  instanceId: string;
  /** 上次用的端口；没有时从首选端口开始找。 */
  port: number | null;
  openAtLogin: boolean;
  autoCheckUpdates: boolean;
  closeHintShown: boolean;
  window: WindowBounds | null;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export function defaultPreferences(): DesktopPreferences {
  return {
    schemaVersion: 1,
    instanceId: randomUUID(),
    port: null,
    openAtLogin: false,
    autoCheckUpdates: true,
    closeHintShown: false,
    window: null,
  };
}

/**
 * 读偏好。文件不存在按默认；内容损坏时把坏文件改名留着（desktop.json.broken-<时间>）再按默认继续，不让外壳因此起不来。
 * 逐项校验，认不出的项用默认值，其余保留。
 */
export function loadPreferences(file: string, now = Date.now()): DesktopPreferences {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return defaultPreferences();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    try {
      renameSync(file, `${file}.broken-${String(now)}`);
    } catch {
      // 改名失败就算了，下次保存会覆盖它。
    }
    return defaultPreferences();
  }
  const value = raw as Record<string, unknown>;
  const defaults = defaultPreferences();
  return {
    schemaVersion: 1,
    instanceId: typeof value["instanceId"] === "string" && value["instanceId"] !== "" ? value["instanceId"] : defaults.instanceId,
    port: isPort(value["port"]) ? value["port"] : null,
    openAtLogin: typeof value["openAtLogin"] === "boolean" ? value["openAtLogin"] : defaults.openAtLogin,
    autoCheckUpdates: typeof value["autoCheckUpdates"] === "boolean" ? value["autoCheckUpdates"] : defaults.autoCheckUpdates,
    closeHintShown: typeof value["closeHintShown"] === "boolean" ? value["closeHintShown"] : defaults.closeHintShown,
    window: parseBounds(value["window"]),
  };
}

/** 先写临时文件再改名，写到一半断电也不会留下半个文件。 */
export function savePreferences(file: string, preferences: DesktopPreferences): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, JSON.stringify(preferences, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, file);
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function parseBounds(value: unknown): WindowBounds | null {
  if (!value || typeof value !== "object") return null;
  const bounds = value as Record<string, unknown>;
  const numbers = ["x", "y", "width", "height"].map((key) => bounds[key]);
  if (!numbers.every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  const [x, y, width, height] = numbers as [number, number, number, number];
  if (width < 200 || height < 200) return null;
  return { x, y, width, height, maximized: bounds["maximized"] === true };
}
