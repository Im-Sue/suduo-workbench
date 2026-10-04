import { cliLocale as contractsCliLocale } from "@suduo/client-contracts";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { cliLocale, scriptMessages, type ScriptMessages } from "../../scripts/i18n/index.mjs";
import { messagesFor } from "../src/i18n/messages/index.js";

/**
 * 命令行与脚本的语言（中英双语 S8）：构建前就要跑的脚本（pnpm start、install:m1、uninstall:m1）自带一份
 * 语言判定与消息表（scripts/i18n/），`pnpm run doctor` 用本机服务字典的 `doctor.cli`。
 * 这里守住：两份语言判定逐条一致、中英消息表同键同参数、英文表没有中文、中文与迁移前逐字相同。
 */

const CLIENT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function render(messages: ScriptMessages, section: string, key: string, ...args: (string | number | null)[]): string {
  const message = messages[section]?.[key];
  if (message === undefined) throw new Error(`消息表里没有 ${section}.${key}`);
  return typeof message === "function" ? message(...args) : message;
}

/** 子进程只带这里给的语言变量，不继承跑测试那台机器的 LANG / LC_*。 */
function run(args: string[], locale: Record<string, string>) {
  const env: Record<string, string> = { ...locale };
  for (const name of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return spawnSync(process.execPath, args, { cwd: CLIENT_ROOT, env, encoding: "utf8" });
}

describe("命令行语言判定", () => {
  const ENVIRONMENTS: Record<string, string>[] = [
    {},
    { SUDUO_LOCALE: "en", LANG: "zh_CN.UTF-8" },
    { SUDUO_LOCALE: "zh-CN", LANG: "en_US.UTF-8" },
    { SUDUO_LOCALE: "fr", LANG: "zh_CN.UTF-8" },
    { SUDUO_LOCALE: "", LC_ALL: "zh_TW" },
    { LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" },
    { LC_ALL: "", LC_MESSAGES: "zh_CN.GB2312", LANG: "en_US" },
    { LC_ALL: "  ", LANG: "zh" },
    { LANG: "C" },
    { LANG: "C.UTF-8" },
    { LANG: "POSIX" },
    { LANG: "zh_HK.Big5" },
    { LANG: "ZH_cn.utf8" },
    { LANG: "zhx" },
    { LANG: ".UTF-8" },
    { LANG: "en_US.UTF-8" },
    { LC_MESSAGES: "fr_FR" },
  ];
  const SYSTEM_LOCALES = ["zh-CN", "zh-Hans-CN", "en-US", "fr-FR", "", undefined];

  it("scripts/i18n 的 cliLocale 与契约包的 cliLocale 逐条一致", () => {
    for (const env of ENVIRONMENTS) {
      for (const system of SYSTEM_LOCALES) {
        const expected = contractsCliLocale(env, () => system);
        expect(cliLocale(env, () => system), JSON.stringify({ env, system })).toBe(expected);
      }
    }
  });

  it("SUDUO_LOCALE 优先；LC_ALL → LC_MESSAGES → LANG；都没设时看系统区域，取不到为英文", () => {
    expect(cliLocale({ SUDUO_LOCALE: "en", LANG: "zh_CN.UTF-8" }, () => "zh-CN")).toBe("en");
    expect(cliLocale({ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" }, () => "zh-CN")).toBe("en");
    expect(cliLocale({ LANG: "zh_CN.UTF-8" }, () => "en-US")).toBe("zh-CN");
    expect(cliLocale({ LANG: "C.UTF-8" }, () => "zh-CN")).toBe("en");
    expect(cliLocale({}, () => "zh-Hans-CN")).toBe("zh-CN");
    expect(cliLocale({}, () => undefined)).toBe("en");
  });
});

describe("脚本消息表", () => {
  const shape = (messages: ScriptMessages) =>
    Object.fromEntries(
      Object.entries(messages).map(([section, entries]) => [
        section,
        Object.fromEntries(
          Object.entries(entries).map(([key, value]) => [key, typeof value === "function" ? `function/${String(value.length)}` : typeof value]),
        ),
      ]),
    );

  it("英文表与中文表同分区、同键、同参数个数", () => {
    expect(shape(scriptMessages("en"))).toEqual(shape(scriptMessages("zh-CN")));
  });

  it("英文表的文字里没有中文", () => {
    const path = join(CLIENT_ROOT, "scripts", "i18n", "messages", "en.mjs");
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        CJK.test(node.text)
      ) {
        found.push(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(found).toEqual([]);
  });

  it("pnpm start 的中文与迁移前逐字相同", () => {
    const zh = scriptMessages("zh-CN");
    const start = (key: string, ...args: (string | number | null)[]) => render(zh, "start", key, ...args);
    expect(start("alreadyRunning", "http://127.0.0.1:8787/")).toBe("SuDuo 已在运行：http://127.0.0.1:8787/");
    expect(start("portInUse", 8787)).toBe("端口 8787 被其他程序占用。换一个端口：pnpm start --port <端口>");
    expect(start("unknownOption", "--x")).toBe("不认识的参数：--x（pnpm start --help 查看用法）");
    expect(start("invalidPort")).toBe("端口必须是 1–65535 之间的整数。");
    expect(start("help")).toBe(
      [
        "用法：pnpm start [参数]",
        "",
        "  --port <端口>   本机服务端口（默认 8787，也认环境变量 SUDUO_PORT）",
        "  --no-open       不自动打开浏览器",
        "  --rebuild       强制重新构建",
        "",
        "其他环境变量（SUDUO_DATA_DIR、SUDUO_REQUIREMENTS_SERVICE_URL 等）原样传给本机服务，见 server/.env.example。",
      ].join("\n"),
    );
    expect(start("nodeTooOld", "24.10.0", "22.1.0")).toBe(
      "需要 Node 24.10.0 或更新，当前是 22.1.0。请从 https://nodejs.org 安装 24.x（LTS），或用 mise / nvm / winget 切换版本。",
    );
    expect(start("notInstalled")).toBe("还没有安装依赖：先在 client/ 下执行 pnpm install。");
    expect(start("sqliteFailed")).toBe(
      "SQLite 原生模块加载失败。先试 pnpm rebuild better-sqlite3；仍不行时需要编译工具：macOS 执行 xcode-select --install，Windows 安装 Visual Studio Build Tools（勾选「使用 C++ 的桌面开发」）后再 pnpm install。",
    );
    expect(start("codexMissing")).toBe("找不到锁定版本的 Codex CLI：在 client/ 下重新执行 pnpm install。");
    expect(start("codexNotConfigured", "/h/.codex")).toBe(
      "Codex 还没有配置模型账号（/h/.codex）。可以在 SuDuo 的「设置 → 模型服务」里配置，或在 client/ 下执行 pnpm exec codex login。",
    );
    expect(start("firstBuild")).toBe("首次运行，正在构建（约 1–2 分钟）…");
    expect(start("rebuilding")).toBe("源码有更新，正在重新构建…");
    expect(start("buildFailed")).toBe("构建失败，见上方输出。");
    expect(start("buildComplete")).toBe("构建完成");
    expect(start("startFailed", "/d/logs/suduo.log")).toBe("本机服务没有启动成功。日志：/d/logs/suduo.log\n  排查：pnpm run doctor");
    expect(start("started", "http://127.0.0.1:8787/")).toBe("本机服务已启动：http://127.0.0.1:8787/");
    expect("  " + start("dataDir", "/d")).toBe("  数据目录：/d");
    expect("  " + start("log", "/d/logs/suduo.log")).toBe("  日志：/d/logs/suduo.log");
    expect(start("opened")).toBe("已在浏览器中打开");
    expect(start("stopHint")).toBe("按 Ctrl+C 停止。");
    expect(start("stopping")).toBe("正在停止…");
    expect(start("stopped")).toBe("SuDuo 已停止。");
    expect(start("exitedUnexpectedly", start("exitCode", 3), "/d/l.log")).toBe("本机服务意外退出（退出码 3）。日志：/d/l.log");
    expect(start("exitedUnexpectedly", start("exitCode", null), "/d/l.log")).toBe("本机服务意外退出（退出码 null）。日志：/d/l.log");
    expect(start("exitedUnexpectedly", "SIGKILL", "/d/l.log")).toBe("本机服务意外退出（SIGKILL）。日志：/d/l.log");
    expect(start("legacyDataDir", "/old", "/new")).toBe(
      '在旧位置 /old 发现了以前的本机数据，现在的默认位置是 /new。要继续用以前的数据：先按 Ctrl+C 停止，把旧目录移动过来，或用 SUDUO_DATA_DIR="/old" pnpm start。',
    );
    expect(start("openManually", "http://127.0.0.1:8787/")).toBe("请在浏览器中打开 http://127.0.0.1:8787/");
    expect(render(zh, "installer", "invalidServiceName")).toBe("--service-name 无效");
  });

  it("pnpm run doctor 的中文与迁移前逐字相同", () => {
    const cli = messagesFor("zh-CN").doctor.cli;
    expect(cli.passed).toBe("自检通过，可以启动 SuDuo。");
    expect(cli.failed).toBe("自检未通过。请先修复上述问题；不会带病启动服务。");
    expect(cli.invalidPort).toBe("--port 必须是 1 到 65535 的整数");
  });
});

// install:m1 / uninstall:m1 会装卸 systemd 服务、删目录，这里不真跑，只由上面的消息表测试覆盖它们的报错文字。
describe("脚本按系统语言输出", () => {
  const chinese = { LANG: "zh_CN.UTF-8" };
  const english = { LANG: "en_US.UTF-8" };

  it("pnpm start：参数报错与帮助", () => {
    const zhError = run(["scripts/start.mjs", "--bogus"], chinese);
    expect(zhError.status).toBe(1);
    expect(zhError.stderr).toBe("  ✗ 不认识的参数：--bogus（pnpm start --help 查看用法）\n");

    const enError = run(["scripts/start.mjs", "--bogus"], english);
    expect(enError.status).toBe(1);
    expect(enError.stderr).toBe("  ✗ Unknown option: --bogus (see pnpm start --help)\n");

    // SUDUO_LOCALE 显式指定时压过 LANG。
    const forced = run(["scripts/start.mjs", "--port", "0"], { ...chinese, SUDUO_LOCALE: "en" });
    expect(forced.status).toBe(1);
    expect(forced.stderr).toBe("  ✗ The port must be an integer between 1 and 65535.\n");

    const help = run(["scripts/start.mjs", "--help"], chinese);
    expect(help.status).toBe(0);
    expect(help.stdout).toBe(render(scriptMessages("zh-CN"), "start", "help") + "\n");
  });

  it("pnpm run doctor：参数报错按语言", () => {
    const tsx = join(CLIENT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const zh = run([tsx, "scripts/doctor.ts", "--port", "0"], chinese);
    expect(zh.status).toBe(1);
    expect(zh.stderr).toContain("--port 必须是 1 到 65535 的整数");
    const en = run([tsx, "scripts/doctor.ts", "--port", "0"], english);
    expect(en.status).toBe(1);
    expect(en.stderr).toContain("--port must be an integer between 1 and 65535");
  });
});
