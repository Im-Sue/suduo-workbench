import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chooseDesktopLocale, desktopMessages, parseStoredLocale } from "../src/i18n/index.js";
import { en } from "../src/i18n/en.js";
import { zhCN } from "../src/i18n/zh-CN.js";
import { buildServerEnvironment } from "../src/main/environment.js";
import { isAllowedPermission, isAppPageUrl, isAppUrl, isExternalOpenable, isStartupUrl } from "../src/main/navigation.js";
import { codexTargetTriple, resolveDesktopPaths, type DesktopPathsInput } from "../src/main/paths.js";
import { PREFERRED_PORT, candidatePorts, choosePort, isOwnServer, type PortState } from "../src/main/ports.js";
import { defaultPreferences, loadPreferences, savePreferences } from "../src/main/preferences.js";
import { nextRestartDelay } from "../src/main/server-process.js";
import { needsShellEnvironment, parseShellEnvironment, shellEnvironmentCommand } from "../src/main/shell-env.js";

/** 客户端桌面应用 D0：外壳里不依赖 Electron 的逻辑（技术设计 §四、§五「外壳单元测试」）。 */

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "suduo-desktop-test-"));
  temporary.push(dir);
  return dir;
}

describe("外壳字典", () => {
  it("中英同形：每个键都在，类型一致，文字不为空", () => {
    const walk = (zh: unknown, other: unknown, path: string) => {
      expect(typeof other, path).toBe(typeof zh);
      if (typeof zh === "function") {
        expect((other as (...args: unknown[]) => unknown).length, path).toBe(zh.length);
        return;
      }
      if (typeof zh === "string") {
        expect((other as string).trim(), path).not.toBe("");
        return;
      }
      const zhKeys = Object.keys(zh as object).sort();
      expect(Object.keys(other as object).sort(), path).toEqual(zhKeys);
      for (const key of zhKeys) {
        walk((zh as Record<string, unknown>)[key], (other as Record<string, unknown>)[key], `${path}.${key}`);
      }
    };
    walk(zhCN, en, "messages");
  });

  it("英文按数量变单复数", () => {
    expect(en.quitConfirm.message(1)).toBe("1 session is in progress");
    expect(en.quitConfirm.message(3)).toBe("3 sessions are in progress");
    expect(desktopMessages("zh-CN").quitConfirm.message(2)).toBe("有 2 个会话正在进行");
  });

  it("语言：前端告知的 → 本机服务记下的 → 系统语言；不认识的值跳过", () => {
    expect(chooseDesktopLocale({ announced: "en", stored: "zh-CN", system: "zh-Hans-CN" })).toBe("en");
    expect(chooseDesktopLocale({ announced: null, stored: "zh-CN", system: "en-US" })).toBe("zh-CN");
    expect(chooseDesktopLocale({ announced: "fr", stored: "xx", system: "zh-Hans-CN" })).toBe("zh-CN");
    expect(chooseDesktopLocale({ system: "zh-TW" })).toBe("zh-CN");
    expect(chooseDesktopLocale({ system: "ja-JP" })).toBe("en");
  });

  it("读本机服务记下的界面语言文件，坏文件当成没有", () => {
    expect(parseStoredLocale(JSON.stringify({ locale: "en" }))).toBe("en");
    expect(parseStoredLocale("{oops")).toBeNull();
    expect(parseStoredLocale(JSON.stringify({ locale: 3 }))).toBeNull();
    expect(parseStoredLocale(null)).toBeNull();
  });
});

describe("路径", () => {
  const base: DesktopPathsInput = {
    isPackaged: true,
    platform: "darwin",
    arch: "arm64",
    env: {},
    homeDir: "/Users/u",
    resourcesPath: "/Applications/SuDuo.app/Contents/Resources",
    appPath: "/Applications/SuDuo.app/Contents/Resources/app.asar",
    codexVersion: "0.159.2",
  };

  it("Mac 安装版：数据在 SuDuo Desktop（不是源码运行的 SuDuo），程序都在 Resources 下", () => {
    const paths = resolveDesktopPaths(base);
    expect(paths.shellDataDir).toBe("/Users/u/Library/Application Support/SuDuo Desktop");
    expect(paths.dataDir).toBe("/Users/u/Library/Application Support/SuDuo Desktop/data");
    expect(paths.serverLog).toBe("/Users/u/Library/Application Support/SuDuo Desktop/data/logs/suduo.log");
    expect(paths.preferencesFile).toBe("/Users/u/Library/Application Support/SuDuo Desktop/desktop.json");
    expect(paths.storedLocaleFile).toBe("/Users/u/Library/Application Support/SuDuo Desktop/data/settings.locale.json");
    expect(paths.nodeBinary).toBe("/Applications/SuDuo.app/Contents/Resources/node/node");
    expect(paths.serverMain).toBe("/Applications/SuDuo.app/Contents/Resources/app/server/dist/main.mjs");
    expect(paths.codexBin).toBe("/Applications/SuDuo.app/Contents/Resources/codex/aarch64-apple-darwin/bin/codex");
    expect(paths.serverCwd).toBe(paths.dataDir);
    expect(paths.clientRoot).toBeNull();
  });

  it("Windows 安装版：数据放 LOCALAPPDATA（不是漫游目录），程序带 .exe", () => {
    const paths = resolveDesktopPaths({
      ...base,
      platform: "win32",
      arch: "x64",
      env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
      homeDir: "C:\\Users\\u",
      resourcesPath: "C:\\Users\\u\\AppData\\Local\\Programs\\SuDuo\\resources",
      appPath: "C:\\Users\\u\\AppData\\Local\\Programs\\SuDuo\\resources\\app.asar",
    });
    expect(paths.shellDataDir).toBe("C:\\Users\\u\\AppData\\Local\\SuDuo Desktop");
    expect(paths.nodeBinary).toBe("C:\\Users\\u\\AppData\\Local\\Programs\\SuDuo\\resources\\node\\node.exe");
    expect(paths.codexBin).toBe("C:\\Users\\u\\AppData\\Local\\Programs\\SuDuo\\resources\\codex\\x86_64-pc-windows-msvc\\bin\\codex.exe");
  });

  it("开发态：数据默认放 SuDuo Desktop Dev，可用 SUDUO_DESKTOP_HOME 覆盖；Node 用启动脚本那个", () => {
    const dev = { ...base, isPackaged: false, appPath: "/repo/client/desktop", env: { SUDUO_DESKTOP_NODE: "/opt/node/bin/node" } };
    const paths = resolveDesktopPaths(dev);
    expect(paths.shellDataDir).toBe("/Users/u/Library/Application Support/SuDuo Desktop Dev");
    expect(paths.clientRoot).toBe("/repo/client");
    expect(paths.serverMain).toBe("/repo/client/server/dist/main.js");
    expect(paths.nodeBinary).toBe("/opt/node/bin/node");
    expect(paths.startupPage).toBe("/repo/client/desktop/dist/startup/startup.html");
    expect(resolveDesktopPaths({ ...dev, env: { SUDUO_DESKTOP_HOME: "/tmp/d" } }).dataDir).toBe("/tmp/d/data");
  });

  it("开发态在 client/node_modules 里找锁定版本的 Codex 二进制", () => {
    const client = tempDir();
    const bin = join(
      client, "node_modules", ".pnpm", "@openai+codex@0.159.2-darwin-arm64", "node_modules", "@openai", "codex", "vendor", "aarch64-apple-darwin", "bin",
    );
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codex"), "");
    const paths = resolveDesktopPaths({ ...base, isPackaged: false, appPath: join(client, "desktop") });
    expect(paths.codexBin).toBe(join(bin, "codex"));
    expect(resolveDesktopPaths({ ...base, isPackaged: false, appPath: join(client, "desktop"), codexVersion: "9.9.9" }).codexBin).toBeNull();
  });

  it("Codex 目标三元组", () => {
    expect(codexTargetTriple("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(codexTargetTriple("win32", "x64")).toBe("x86_64-pc-windows-msvc");
    expect(codexTargetTriple("aix", "ppc64")).toBeNull();
  });
});

describe("偏好 desktop.json", () => {
  it("没有文件按默认，实例标识每次生成都不同", () => {
    const dir = tempDir();
    const loaded = loadPreferences(join(dir, "desktop.json"));
    expect(loaded).toMatchObject({ schemaVersion: 1, port: null, serverPid: null, openAtLogin: false, autoCheckUpdates: true, closeHintShown: false, window: null });
    expect(loaded.instanceId).not.toBe(defaultPreferences().instanceId);
  });

  it("保存再读回来一致", () => {
    const file = join(tempDir(), "nested", "desktop.json");
    const preferences = { ...defaultPreferences(), port: 8791, serverPid: 4242, closeHintShown: true, window: { x: 10, y: 20, width: 1200, height: 800, maximized: true } };
    savePreferences(file, preferences);
    expect(loadPreferences(file)).toEqual(preferences);
  });

  it("损坏的文件改名留着，按默认继续", () => {
    const dir = tempDir();
    const file = join(dir, "desktop.json");
    writeFileSync(file, "{not json");
    const loaded = loadPreferences(file, 1234);
    expect(loaded.port).toBeNull();
    expect(readdirSync(dir)).toContain("desktop.json.broken-1234");
  });

  it("逐项校验：认不出的项用默认，其余保留", () => {
    const file = join(tempDir(), "desktop.json");
    writeFileSync(file, JSON.stringify({ instanceId: "keep-me", port: 70000, serverPid: -1, openAtLogin: "yes", closeHintShown: true, window: { x: 1, y: 2, width: 50, height: 50 } }));
    const loaded = loadPreferences(file);
    expect(loaded).toMatchObject({ instanceId: "keep-me", port: null, serverPid: null, openAtLogin: false, closeHintShown: true, window: null });
  });
});

describe("登录 shell 环境", () => {
  it("只取两个标记之间的 env -0 输出，跳过欢迎信息与 shell 自己的变量", () => {
    const marker = "__M__";
    const output = `Welcome to oh-my-zsh!\n${marker}PATH=/opt/homebrew/bin:/usr/bin\0HOME=/Users/u\0PWD=/tmp\0SHLVL=2\0_=/usr/bin/env\0EQ=a=b\0\0${marker}bye`;
    expect(parseShellEnvironment(output, marker)).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/u", EQ: "a=b" });
  });

  it("标记不成对、中间为空或没有 PATH（例如 env 不认 -0）时返回 null", () => {
    expect(parseShellEnvironment("no markers here", "__M__")).toBeNull();
    expect(parseShellEnvironment("__M__PATH=/usr/bin", "__M__")).toBeNull();
    expect(parseShellEnvironment("__M____M__", "__M__")).toBeNull();
    expect(parseShellEnvironment("__M__HOME=/Users/u\0__M__", "__M__")).toBeNull();
  });

  it("只看第一对标记：输出还没读完时也能先解析", () => {
    expect(parseShellEnvironment("x__M__PATH=/usr/bin\0__M__ trailing __M__", "__M__")).toEqual({ PATH: "/usr/bin" });
  });

  it("用登录交互 shell 跑 env -0", () => {
    const { command, args } = shellEnvironmentCommand("/bin/zsh", "__M__");
    expect(command).toBe("/bin/zsh");
    expect(args[0]).toBe("-ilc");
    expect(args[1]).toContain("/usr/bin/env -0");
  });

  it("只在 Mac 且不是从终端启动时读", () => {
    expect(needsShellEnvironment("darwin", {})).toBe(true);
    expect(needsShellEnvironment("darwin", { TERM: "xterm-256color" })).toBe(false);
    expect(needsShellEnvironment("win32", {})).toBe(false);
  });
});

describe("交给本机服务的环境", () => {
  const settings = { platform: "darwin" as const, port: 8790, dataDir: "/d/data", pidFile: "/d/data/suduo.pid", instanceId: "i-1", codexBin: "/r/codex/bin/codex" };

  it("登录 shell 的 PATH 覆盖外壳自己的最小 PATH，外壳决定的 SUDUO_* 全部写好", () => {
    const env = buildServerEnvironment({
      ...settings,
      base: { PATH: "/usr/bin:/bin", HOME: "/Users/u" },
      shell: { PATH: "/Users/u/.local/share/mise/shims:/opt/homebrew/bin:/usr/bin", LANG: "zh_CN.UTF-8" },
    });
    expect(env["PATH"]).toBe("/Users/u/.local/share/mise/shims:/opt/homebrew/bin:/usr/bin");
    expect(env).toMatchObject({
      HOME: "/Users/u",
      LANG: "zh_CN.UTF-8",
      SUDUO_RUN_MODE: "desktop",
      SUDUO_INSTANCE_ID: "i-1",
      SUDUO_HOST: "127.0.0.1",
      SUDUO_PORT: "8790",
      SUDUO_DATA_DIR: "/d/data",
      SUDUO_PID_FILE: "/d/data/suduo.pid",
      SUDUO_IDLE_EXIT_MS: "0",
      SUDUO_CODEX_BIN: "/r/codex/bin/codex",
    });
  });

  it("去掉 pnpm / npm / Electron 注入的变量与 node_modules/.bin，使用者自己的 SUDUO_* 只保留 Codex 目录与语言", () => {
    const env = buildServerEnvironment({
      ...settings,
      base: {
        PATH: "/repo/client/node_modules/.bin:/repo/node_modules/.bin:/x/node-gyp-bin:/usr/bin",
        npm_config_user_agent: "pnpm",
        PNPM_HOME: "/p",
        INIT_CWD: "/repo",
        ELECTRON_RUN_AS_NODE: "1",
        SUDUO_DATA_DIR: "/somewhere/else",
        SUDUO_DB_PATH: "/somewhere/else/db.sqlite",
        SUDUO_CODEX_HOME: "/custom/codex",
        SUDUO_LOCALE: "en",
      },
      shell: null,
    });
    expect(env["PATH"]).toBe("/usr/bin:/opt/homebrew/bin:/usr/local/bin");
    expect(env).not.toHaveProperty("npm_config_user_agent");
    expect(env).not.toHaveProperty("PNPM_HOME");
    expect(env).not.toHaveProperty("INIT_CWD");
    expect(env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(env).not.toHaveProperty("SUDUO_DB_PATH");
    expect(env["SUDUO_DATA_DIR"]).toBe("/d/data");
    expect(env["SUDUO_CODEX_HOME"]).toBe("/custom/codex");
    expect(env["SUDUO_LOCALE"]).toBe("en");
  });

  it("Windows：沿用已有的 Path 键名，分号分隔，不补 Mac 的目录", () => {
    const env = buildServerEnvironment({
      ...settings,
      platform: "win32",
      codexBin: null,
      base: { Path: "C:\\repo\\client\\node_modules\\.bin;C:\\Windows\\System32;C:\\Program Files\\Git\\cmd" },
      shell: null,
    });
    expect(env["Path"]).toBe("C:\\Windows\\System32;C:\\Program Files\\Git\\cmd");
    expect(env).not.toHaveProperty("PATH");
    expect(env).not.toHaveProperty("SUDUO_CODEX_BIN");
  });
});

describe("端口", () => {
  it("顺序：上次用的 → 首选 → 依次备选，不重复", () => {
    expect(candidatePorts(null)).toEqual([8790, 8791, 8792, 8793, 8794, 8795, 8796, 8797, 8798, 8799]);
    expect(candidatePorts(8795).slice(0, 3)).toEqual([8795, 8790, 8791]);
    expect(candidatePorts(8795)).toHaveLength(10);
    expect(candidatePorts(9000)).toHaveLength(11);
  });

  it("跳过被别的程序占用的端口；遇到自己留下的服务就用它（先停掉再拉起）", async () => {
    const states: Record<number, PortState> = { 8790: "busy", 8791: "ours", 8792: "free" };
    const inspect = async (port: number) => states[port] ?? "busy";
    expect(await choosePort({ remembered: null, inspect })).toEqual({ port: 8791, orphan: true });
    expect(await choosePort({ remembered: 8792, inspect })).toEqual({ port: 8792, orphan: false });
  });

  it("全被占用返回 null", async () => {
    expect(await choosePort({ remembered: null, inspect: async () => "busy" })).toBeNull();
    expect(PREFERRED_PORT).toBe(8790);
  });

  it("只认同一实例标识的桌面版服务；源码运行的、别的安装的都不是自己的", () => {
    expect(isOwnServer({ product: "suduo", status: "ok", runMode: "desktop", instanceId: "a" }, "a")).toBe(true);
    expect(isOwnServer({ product: "suduo", status: "ok", runMode: "desktop", instanceId: "b" }, "a")).toBe(false);
    expect(isOwnServer({ product: "suduo", status: "ok", runMode: "source" }, "a")).toBe(false);
    expect(isOwnServer({ product: "suduo", status: "ok" }, "a")).toBe(false);
    expect(isOwnServer(null, "a")).toBe(false);
  });
});

describe("导航与权限", () => {
  const base = "http://127.0.0.1:8790/";
  const startup = "file:///Applications/SuDuo.app/Contents/Resources/app.asar/dist/startup/startup.html";

  it("同源才算本机服务页面", () => {
    expect(isAppUrl("http://127.0.0.1:8790/p/1/requirements?x=1", base)).toBe(true);
    expect(isAppUrl("http://127.0.0.1:8787/", base)).toBe(false);
    expect(isAppUrl("http://localhost:8790/", base)).toBe(false);
    expect(isAppUrl("http://127.0.0.1:8790", base)).toBe(true);
    expect(isAppUrl("not a url", base)).toBe(false);
    expect(isAppUrl("http://127.0.0.1:8790/", null)).toBe(false);
  });

  it("启动页按文件路径认，忽略查询串与锚点", () => {
    expect(isStartupUrl(startup + "?a=1#b", startup, "darwin")).toBe(true);
    expect(isStartupUrl("file:///etc/passwd", startup, "darwin")).toBe(false);
    expect(isStartupUrl("http://127.0.0.1:8790/dist/startup/startup.html", startup, "darwin")).toBe(false);
  });

  it("Windows：盘符大小写与转义不同也认得出；带主机名的 file 地址不算", () => {
    const node = "file:///c:/Users/Jo%20Smith/AppData/Local/Programs/SuDuo/resources/app.asar/dist/startup/startup.html";
    const chromium = "file:///C:/Users/Jo Smith/AppData/Local/Programs/SuDuo/resources/app.asar/dist/startup/startup.html";
    expect(isStartupUrl(chromium, node, "win32")).toBe(true);
    expect(isStartupUrl(chromium, node, "darwin")).toBe(false);
    expect(isStartupUrl("file://server/c:/Users/Jo%20Smith/AppData/Local/Programs/SuDuo/resources/app.asar/dist/startup/startup.html", node, "win32")).toBe(false);
  });

  it("能用桥的只是本机服务的页面，接口响应（例如原样返回的项目 .html）不算", () => {
    expect(isAppPageUrl("http://127.0.0.1:8790/sessions", base)).toBe(true);
    expect(isAppPageUrl("http://127.0.0.1:8790/api/v1/projects/p/files/raw?path=a.html", base)).toBe(false);
    expect(isAppPageUrl("http://127.0.0.1:8787/sessions", base)).toBe(false);
  });

  it("只把网页与邮件交给系统打开", () => {
    expect(isExternalOpenable("https://suduo.dev")).toBe(true);
    expect(isExternalOpenable("mailto:hello@suduo.dev")).toBe(true);
    expect(isExternalOpenable("file:///etc/passwd")).toBe(false);
    expect(isExternalOpenable("javascript:alert(1)")).toBe(false);
    expect(isExternalOpenable("vscode://file/x")).toBe(false);
  });

  it("网页权限只放行通知、剪贴板写入与全屏", () => {
    expect(isAllowedPermission("notifications")).toBe(true);
    expect(isAllowedPermission("clipboard-sanitized-write")).toBe(true);
    expect(isAllowedPermission("media")).toBe(false);
    expect(isAllowedPermission("geolocation")).toBe(false);
  });
});

describe("意外退出后的自动重启", () => {
  it("5 分钟内最多 3 次，依次隔 1、5、15 秒；更早的不算", () => {
    const now = 1_000_000;
    expect(nextRestartDelay([], now)).toBe(1_000);
    expect(nextRestartDelay([now - 1_000], now)).toBe(5_000);
    expect(nextRestartDelay([now - 2_000, now - 1_000], now)).toBe(15_000);
    expect(nextRestartDelay([now - 3_000, now - 2_000, now - 1_000], now)).toBeNull();
    expect(nextRestartDelay([now - 6 * 60_000, now - 5 * 60_000 - 1, now - 1_000], now)).toBe(5_000);
  });
});

describe("启动页与资源", () => {
  it("启动页不内联脚本（CSP 只放行同目录的脚本与样式）", () => {
    const html = readFileSync(new URL("../src/startup/startup.html", import.meta.url), "utf8");
    expect(html).toContain("script-src 'self'");
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
  });
});
