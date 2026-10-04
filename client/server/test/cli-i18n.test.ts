import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_VERSION } from "@suduo/client-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/application/api-error.js";
import { maxApprovalMode } from "../src/application/approval-mode-cap.js";
import { RequirementsV2Service } from "../src/application/requirements-v2-service.js";
import { en } from "../src/i18n/messages/en/index.js";
import { zhCN } from "../src/i18n/messages/zh-CN/index.js";
import {
  DatabaseAdapterLoadError,
  openBetterSqlite3Database,
} from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { resolvePinnedCodexBin } from "../src/infrastructure/platform/codex-bin.js";
import { applyRuntimeConfigFromArgs } from "../src/infrastructure/platform/runtime-config.js";
import { readPrivateJson } from "../src/infrastructure/requirements-v2/local-json-store.js";
import {
  RequirementsSettingsStore,
  normalizeRequirementsServiceUrl,
} from "../src/infrastructure/requirements-v2/settings-store.js";

/**
 * 本机服务启动阶段的输出与报错按系统语言（中英双语 S8，`cliLocale`）：
 * 中文与迁移前逐字相同，英文走 `cli` 分区；语言在出错时才取，不在模块加载时固定。
 */
const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function messageOf(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the operation to throw");
}

describe("中文与迁移前逐字相同", () => {
  // 右边照抄迁移前源码里的写法（含拼接方式），左边是字典生成的结果。
  const name = "SUDUO_IDLE_EXIT_MS";
  const minimum = 0;
  const maximum = Number.MAX_SAFE_INTEGER;
  const configured = "0.0.1";
  const codexHome = "/tmp/no-such-codex-home";
  const key = "SUDUO_DATA_DIR";
  const cases: Array<[string, string]> = [
    [zhCN.cli.hostMustBeLoopback, "SUDUO_HOST 必须严格为 127.0.0.1"],
    [zhCN.cli.transportStdioOnly, "M1 的 SUDUO_CODEX_TRANSPORT 仅允许 stdio"],
    [
      zhCN.cli.integerOutOfRange(name, minimum, maximum),
      name + " 必须是 " + String(minimum) + " 到 " + String(maximum) + " 的整数",
    ],
    [
      "SuDuo: " + zhCN.cli.codexVersionMismatch(configured, CODEX_VERSION) + "\n",
      `SuDuo: 安装配置里的 SUDUO_CODEX_VERSION=${configured} 与锁定的 Codex ${CODEX_VERSION} 不一致；` +
        "重新运行安装（pnpm install:m1）即可更新。\n",
    ],
    [
      "SuDuo: " + zhCN.cli.codexHomeMissing(codexHome) + "\n",
      `SuDuo: CODEX_HOME 指向的目录不存在：${codexHome}。Codex 会无法启动；请检查 SUDUO_CODEX_HOME / CODEX_HOME，或删掉这个设置改用默认的 ~/.codex。\n`,
    ],
    [zhCN.cli.runtimeConfigPathRequired, "--runtime-config 必须提供配置文件路径"],
    [zhCN.cli.runtimeConfigKeyNotAllowed(key), "runtime config 包含不允许的环境项: " + key],
    [zhCN.cli.runtimeConfigNotObject, "runtime config 必须是 JSON object"],
    [zhCN.cli.runtimeConfigSchemaVersion, "runtime config schemaVersion 必须为 1"],
    [zhCN.cli.runtimeConfigEnvironmentNotObject, "runtime config environment 必须是 object"],
    [zhCN.cli.runtimeConfigValueNotString(key), "runtime config 环境项必须是非空字符串: " + key],
    [zhCN.cli.runtimeConfigPathNotRelative(key), key + " 必须是相对安装目录的路径"],
    [zhCN.cli.runtimeConfigPathOutsideInstall(key), key + " 不得越出安装目录"],
    [
      zhCN.cli.pinnedCodexNotFound(CODEX_VERSION),
      `未找到 workspace 锁定的 Codex ${CODEX_VERSION}；请通过绝对或相对路径设置 SUDUO_CODEX_BIN`,
    ],
    [
      zhCN.cli.databaseAdapterLoadFailed,
      "无法加载 better-sqlite3 原生适配器；请确认 Node 版本与平台预构建包匹配，并重新执行 pnpm install。",
    ],
    [
      zhCN.cli.legacyMigrations([3, 9]),
      `检测到旧数据库迁移版本 [${[3, 9].join(", ")}]；按 D4 删除本机数据库后重建。`,
    ],
    [zhCN.cli.maxApprovalModeInvalid, "SUDUO_MAX_APPROVAL_MODE 仅支持 ask / auto / full"],
    [zhCN.cli.requirementsSettingsInvalid, "V2 本机远程服务配置格式无效"],
    [zhCN.cli.serverAddressEmpty, "远程服务地址不能为空"],
    [zhCN.cli.serverAddressNotUrl, "远程服务地址不是有效 URL"],
    [zhCN.cli.serverAddressProtocol, "远程服务地址仅支持 http 或 https"],
    [zhCN.cli.serverAddressCredentials, "远程服务地址不允许包含用户名或密码"],
    [zhCN.cli.serverAddressOriginOnly, "远程服务地址只能是协议、主机和可选端口"],
    [zhCN.cli.privateJsonUnreadable, "V2 本机配置文件无法读取或解析"],
  ];

  it.each(cases)("%s", (actual, expected) => {
    expect(actual).toBe(expected);
  });

  it("字典的每个键都核对过", () => {
    expect(cases).toHaveLength(Object.keys(zhCN.cli).length);
  });
});

describe("运行配置文件（--runtime-config）", () => {
  function configFile(content: unknown): { root: string; path: string } {
    const root = tempDir("suduo-cli-i18n-rc-");
    mkdirSync(join(root, "config"), { recursive: true });
    const path = join(root, "config", "runtime.json");
    writeFileSync(path, JSON.stringify(content));
    return { root, path };
  }

  const fixtures: Array<[string, unknown, (t: typeof en.cli) => string]> = [
    ["不是对象", [], (t) => t.runtimeConfigNotObject],
    ["版本不对", { schemaVersion: 2, environment: {} }, (t) => t.runtimeConfigSchemaVersion],
    ["environment 不是对象", { schemaVersion: 1, environment: [] }, (t) => t.runtimeConfigEnvironmentNotObject],
    ["空值", { schemaVersion: 1, environment: { SUDUO_PORT: "" } }, (t) => t.runtimeConfigValueNotString("SUDUO_PORT")],
    ["不允许的变量", { schemaVersion: 1, environment: { LANG: "en_US.UTF-8" } }, (t) => t.runtimeConfigKeyNotAllowed("LANG")],
    [
      "绝对路径",
      { schemaVersion: 1, environment: { SUDUO_DATA_DIR: join(tmpdir(), "abs") } },
      (t) => t.runtimeConfigPathNotRelative("SUDUO_DATA_DIR"),
    ],
    [
      "越出安装目录",
      { schemaVersion: 1, environment: { SUDUO_DATA_DIR: "../../outside" } },
      (t) => t.runtimeConfigPathOutsideInstall("SUDUO_DATA_DIR"),
    ],
  ];

  it.each(fixtures)("%s：按传入环境的系统语言", (_label, content, expected) => {
    const { root, path } = configFile(content);
    const run = (environment: NodeJS.ProcessEnv) =>
      messageOf(() => applyRuntimeConfigFromArgs(["--runtime-config", path], environment, root));
    expect(run({ LANG: "zh_CN.UTF-8" })).toBe(expected(zhCN.cli));
    expect(run({ LANG: "en_US.UTF-8" })).toBe(expected(en.cli));
    expect(run({ SUDUO_LOCALE: "en", LANG: "zh_CN.UTF-8" })).toBe(expected(en.cli));
    expect(run({ LANG: "C.UTF-8" })).toBe(expected(en.cli));
  });

  it("缺少路径", () => {
    const run = (environment: NodeJS.ProcessEnv) =>
      messageOf(() => applyRuntimeConfigFromArgs(["--runtime-config"], environment));
    expect(run({ LANG: "zh_CN.UTF-8" })).toBe("--runtime-config 必须提供配置文件路径");
    expect(run({ SUDUO_LOCALE: "en" })).toBe("--runtime-config requires a config file path");
  });
});

describe("启动时的其它报错按进程的系统语言", () => {
  it("找不到锁定的 Codex", () => {
    const missing = join(tempDir("suduo-cli-i18n-codex-"), "no-package");
    const run = () => messageOf(() => resolvePinnedCodexBin({ workspaceRoot: missing, configuredBin: "codex" }));
    vi.stubEnv("SUDUO_LOCALE", "zh-CN");
    expect(run()).toBe(`未找到 workspace 锁定的 Codex ${CODEX_VERSION}；请通过绝对或相对路径设置 SUDUO_CODEX_BIN`);
    // 同一个模块里换了语言就跟着换：语言在出错时才取。
    vi.stubEnv("SUDUO_LOCALE", "en");
    expect(run()).toBe(
      `Couldn't find the Codex ${CODEX_VERSION} pinned in the workspace. Set SUDUO_CODEX_BIN to an absolute or relative path.`,
    );
  });

  it("数据库打不开", () => {
    const directory = tempDir("suduo-cli-i18n-db-");
    const open = () => {
      try {
        openBetterSqlite3Database(directory);
      } catch (error) {
        return error;
      }
      throw new Error("expected the database to fail to open");
    };
    vi.stubEnv("SUDUO_LOCALE", "zh-CN");
    const zh = open();
    expect(zh).toBeInstanceOf(DatabaseAdapterLoadError);
    expect((zh as Error).message).toBe(zhCN.cli.databaseAdapterLoadFailed);
    vi.stubEnv("SUDUO_LOCALE", "en");
    expect((open() as Error).message).toBe(
      "Couldn't load the better-sqlite3 native adapter. Make sure your Node version matches the prebuilt package for this platform, then run pnpm install again.",
    );
  });

  it("库里有旧版本的迁移记录", () => {
    const run = () => {
      const database = openBetterSqlite3Database(":memory:");
      try {
        database.exec(`
          CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            applied_at INTEGER NOT NULL
          ) STRICT;
          INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (1, 'm1_initial', 1), (3, 'old_three', 1), (9, 'old_nine', 1);
        `);
        return messageOf(() => runMigrations(database));
      } finally {
        database.close();
      }
    };
    vi.stubEnv("SUDUO_LOCALE", "zh-CN");
    expect(run()).toBe("检测到旧数据库迁移版本 [3, 9]；按 D4 删除本机数据库后重建。");
    vi.stubEnv("SUDUO_LOCALE", "en");
    expect(run()).toBe(
      "The local database has legacy migration versions [3, 9]. Delete it and restart to recreate it (see D4).",
    );
  });

  it("审批上限的环境变量不合法（按传入的环境）", () => {
    expect(messageOf(() => maxApprovalMode({ SUDUO_MAX_APPROVAL_MODE: "bad", LANG: "zh_CN.UTF-8" }))).toBe(
      "SUDUO_MAX_APPROVAL_MODE 仅支持 ask / auto / full",
    );
    expect(messageOf(() => maxApprovalMode({ SUDUO_MAX_APPROVAL_MODE: "bad", LANG: "en_US.UTF-8" }))).toBe(
      "SUDUO_MAX_APPROVAL_MODE must be ask, auto, or full",
    );
    // 合法与未设置时行为不变。
    expect(maxApprovalMode({ SUDUO_MAX_APPROVAL_MODE: "auto", LANG: "en_US.UTF-8" })).toBe("auto");
    expect(maxApprovalMode({ LANG: "en_US.UTF-8" })).toBeNull();
  });
});

describe("需求服务地址与本机配置文件", () => {
  const addresses: Array<[string, (t: typeof en.cli) => string]> = [
    ["   ", (t) => t.serverAddressEmpty],
    ["not a url", (t) => t.serverAddressNotUrl],
    ["ftp://example.com", (t) => t.serverAddressProtocol],
    ["http://user:secret@example.com", (t) => t.serverAddressCredentials],
    ["http://example.com/api", (t) => t.serverAddressOriginOnly],
  ];

  it.each(addresses)("%j", (address, expected) => {
    vi.stubEnv("SUDUO_LOCALE", "zh-CN");
    expect(messageOf(() => normalizeRequirementsServiceUrl(address))).toBe(expected(zhCN.cli));
    vi.stubEnv("SUDUO_LOCALE", "en");
    expect(messageOf(() => normalizeRequirementsServiceUrl(address))).toBe(expected(en.cli));
  });

  it("启动时带默认地址、读到坏的配置文件", () => {
    const directory = tempDir("suduo-cli-i18n-v2-");
    const file = join(directory, "requirements-service.json");
    const start = () => messageOf(() => new RequirementsSettingsStore(directory, "http://example.com"));

    writeFileSync(file, JSON.stringify({ schemaVersion: 2, baseUrl: "http://example.com" }), { mode: 0o600 });
    vi.stubEnv("SUDUO_LOCALE", "zh-CN");
    expect(start()).toBe("V2 本机远程服务配置格式无效");
    vi.stubEnv("SUDUO_LOCALE", "en");
    expect(start()).toBe("The local requirements service settings file (V2) has an invalid format");

    writeFileSync(file, "{", { mode: 0o600 });
    vi.stubEnv("SUDUO_LOCALE", "zh-CN");
    expect(start()).toBe("V2 本机配置文件无法读取或解析");
    vi.stubEnv("SUDUO_LOCALE", "en");
    expect(start()).toBe("Couldn't read or parse a local settings file (V2)");
    expect(messageOf(() => readPrivateJson(file))).toBe("Couldn't read or parse a local settings file (V2)");
  });

  it("界面改地址仍按请求语言，不受系统语言影响（S5 的 remote.validation）", () => {
    // 地址校验在碰到其它依赖之前就失败，其余依赖用不到。
    const unused = {} as never;
    const service = new RequirementsV2Service(
      new RequirementsSettingsStore(tempDir("suduo-cli-i18n-ui-")),
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
    );
    const failure = (baseUrl: string) => {
      try {
        service.updateSettings({ baseUrl });
      } catch (error) {
        return error;
      }
      throw new Error("expected updateSettings to fail");
    };
    vi.stubEnv("SUDUO_LOCALE", "en");
    const error = failure("ftp://example.com");
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("VALIDATION_ERROR");
    expect((error as ApiError).localizedMessage("zh-CN")).toBe("远程服务地址无效");
    vi.stubEnv("SUDUO_LOCALE", "zh-CN");
    expect((failure("ftp://example.com") as ApiError).localizedMessage("en")).toBe("The server address isn't valid");
  });
});
