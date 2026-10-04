import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Locale, SettingsDto, UpdateSettingsRequest } from "@suduo/client-contracts";
import { UiLocaleStore, uiLocalePathFor } from "../i18n/ui-locale-store.js";
import { maxApprovalMode } from "./approval-mode-cap.js";
import { ApiError } from "./api-error.js";
import {
  EMPTY_PROXY_SETTINGS,
  resolveProxySettings,
  type ProxySettings,
} from "./proxy-settings.js";

interface SettingsFile {
  schemaVersion: 1;
  globalSkills: boolean;
  gitAutoCheckpointDefault: boolean;
  defaultApprovalMode: "ask" | "auto" | "full";
  httpProxy: string;
  httpsProxy: string;
  allProxy: string;
  noProxy: string;
}

const DEFAULTS: SettingsFile = {
  schemaVersion: 1,
  globalSkills: true,
  gitAutoCheckpointDefault: true,
  defaultApprovalMode: "ask",
  ...EMPTY_PROXY_SETTINGS,
};

/**
 * 运行时设置：data/settings.json 持久化。
 * 环境变量优先级高于设置文件（部署强制口子）：
 * SUDUO_GLOBAL_SKILLS=0/1 存在时锁定 globalSkills，界面开关禁用。
 */
export class SettingsService {
  private state: SettingsFile;
  /** 界面语言单独存（见 UiLocaleStore），请求路径上的写入不碰 settings.json。 */
  private readonly uiLocale: UiLocaleStore;
  private onProxySettingsChanged: (() => Promise<void>) | null = null;

  constructor(
    private readonly filePath: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.state = this.load();
    this.uiLocale = new UiLocaleStore(uiLocalePathFor(filePath));
  }

  get(): SettingsDto {
    const globalSkillsLock = this.globalSkillsEnvOverride();
    const approvalModeCap = maxApprovalMode(this.env);
    return {
      globalSkills: globalSkillsLock ?? this.state.globalSkills,
      gitAutoCheckpointDefault: this.state.gitAutoCheckpointDefault,
      globalSkillsLocked: globalSkillsLock !== null,
      defaultApprovalMode: this.state.defaultApprovalMode,
      ...(approvalModeCap === null ? {} : { maxApprovalMode: approvalModeCap }),
      approvalModeLocked: approvalModeCap !== null,
      ...this.proxySettings(),
      locale: this.uiLocale.locale(),
    };
  }

  async update(input: UpdateSettingsRequest): Promise<SettingsDto> {
    if (input.globalSkills !== undefined) {
      if (typeof input.globalSkills !== "boolean") {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.config.settings.mustBeBoolean("globalSkills"));
      }
      if (this.globalSkillsEnvOverride() !== null) {
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          (t) => t.config.settings.globalSkillsLocked,
        );
      }
      this.state.globalSkills = input.globalSkills;
    }
    if (input.gitAutoCheckpointDefault !== undefined) {
      if (typeof input.gitAutoCheckpointDefault !== "boolean") {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          (t) => t.config.settings.mustBeBoolean("gitAutoCheckpointDefault"),
        );
      }
      this.state.gitAutoCheckpointDefault = input.gitAutoCheckpointDefault;
    }
    if (input.defaultApprovalMode !== undefined) {
      if (
        input.defaultApprovalMode !== "ask" &&
        input.defaultApprovalMode !== "auto" &&
        input.defaultApprovalMode !== "full"
      ) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          (t) => t.config.settings.approvalModeInvalid,
        );
      }
      this.state.defaultApprovalMode = input.defaultApprovalMode;
    }
    const previousProxySettings = this.proxySettings();
    const nextProxySettings = resolveProxySettings(
      input as Record<string, unknown>,
      previousProxySettings,
    );
    Object.assign(this.state, nextProxySettings);
    this.save();
    if (!sameProxySettings(previousProxySettings, nextProxySettings)) {
      await this.onProxySettingsChanged?.();
    }
    return this.get();
  }

  /** 注册代理实际变更后的热生效钩子；仅应用层装配 runtime。 */
  setProxySettingsChangedHandler(handler: () => Promise<void>): void {
    this.onProxySettingsChanged = handler;
  }

  proxySettings(input: Record<string, unknown> = {}): ProxySettings {
    return resolveProxySettings(input, {
      httpProxy: this.state.httpProxy,
      httpsProxy: this.state.httpsProxy,
      allProxy: this.state.allProxy,
      noProxy: this.state.noProxy,
    });
  }

  /** 全局 skills 当前是否生效（env 优先）。 */
  globalSkillsEnabled(): boolean {
    return this.get().globalSkills;
  }

  gitAutoCheckpointDefault(): boolean {
    return this.state.gitAutoCheckpointDefault;
  }

  defaultApprovalMode(): "ask" | "auto" | "full" {
    return this.state.defaultApprovalMode;
  }

  /** 前端最近一次使用的界面语言；还没收到过为 null。 */
  locale(): Locale | null {
    return this.uiLocale.locale();
  }

  /** 记下前端当前的界面语言（由请求头带来）；没变化时不写文件，写失败只记日志。 */
  rememberLocale(locale: Locale): void {
    this.uiLocale.rememberLocale(locale);
  }

  private globalSkillsEnvOverride(): boolean | null {
    const raw = this.env["SUDUO_GLOBAL_SKILLS"];
    if (raw === undefined || raw === "") {
      return null;
    }
    return raw !== "0";
  }

  private load(): SettingsFile {
    try {
      const parsed = JSON.parse(
        readFileSync(this.filePath, "utf8"),
      ) as Partial<SettingsFile>;
      return {
        schemaVersion: 1,
        globalSkills:
          typeof parsed.globalSkills === "boolean"
            ? parsed.globalSkills
            : DEFAULTS.globalSkills,
        gitAutoCheckpointDefault:
          typeof parsed.gitAutoCheckpointDefault === "boolean"
            ? parsed.gitAutoCheckpointDefault
            : DEFAULTS.gitAutoCheckpointDefault,
        defaultApprovalMode:
          parsed.defaultApprovalMode === "auto" ||
          parsed.defaultApprovalMode === "full"
            ? parsed.defaultApprovalMode
            : DEFAULTS.defaultApprovalMode,
        httpProxy: readStoredProxy(parsed.httpProxy),
        httpsProxy: readStoredProxy(parsed.httpsProxy),
        allProxy: readStoredProxy(parsed.allProxy),
        noProxy: readStoredNoProxy(parsed.noProxy),
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), {
      mode: 0o600,
    });
  }
}

function sameProxySettings(left: ProxySettings, right: ProxySettings): boolean {
  return (
    left.httpProxy === right.httpProxy &&
    left.httpsProxy === right.httpsProxy &&
    left.allProxy === right.allProxy &&
    left.noProxy === right.noProxy
  );
}

function readStoredProxy(value: unknown): string {
  try {
    return value === undefined
      ? ""
      : resolveProxySettings({ httpProxy: value }, EMPTY_PROXY_SETTINGS).httpProxy;
  } catch {
    return "";
  }
}

function readStoredNoProxy(value: unknown): string {
  try {
    return value === undefined
      ? ""
      : resolveProxySettings({ noProxy: value }, EMPTY_PROXY_SETTINGS).noProxy;
  } catch {
    return "";
  }
}
