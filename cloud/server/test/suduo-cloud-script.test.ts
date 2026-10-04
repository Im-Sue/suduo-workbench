import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 私有化部署脚本 scripts/suduo-cloud.sh 的输出语言（中英双语 S8）。
 * 只跑帮助、参数错误、还没安装就退出这类分支，不碰 Docker 与系统。
 * 脚本复制到临时目录里跑：那里没有 server/.env，status 之类在检查 Docker 之前就退出，也不会读到开发机上的配置。
 */
const SOURCE = fileURLToPath(new URL("../../scripts/suduo-cloud.sh", import.meta.url));

let root = "";
let script = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "suduo-cloud-sh-"));
  mkdirSync(join(root, "scripts"));
  script = join(root, "scripts", "suduo-cloud.sh");
  copyFileSync(SOURCE, script);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

type Env = Record<string, string>;

/** 只带 PATH 与给定的语言变量运行，不受跑测试那台机器的 LANG 影响。 */
function run(env: Env, ...args: string[]) {
  const result = spawnSync("bash", [script, ...args], {
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** stderr 可能夹着 bash 的 setlocale 警告（机器上没装这个区域时），只看脚本自己的那一行。 */
function lines(text: string): string[] {
  return text.split("\n");
}

const ZH: Env = { LANG: "zh_CN.UTF-8" };
const EN: Env = { LANG: "en_US.UTF-8" };

describe.skipIf(process.platform === "win32")("suduo-cloud.sh 输出语言", () => {
  // 与 client/contracts/test/cli-locale.test.ts 的 cliLocale 用例一一对应，外加 shell 版自己的边界。
  const cases: Array<[Env, "zh" | "en"]> = [
    [{ SUDUO_LOCALE: "en", LANG: "zh_CN.UTF-8" }, "en"],
    [{ SUDUO_LOCALE: "zh-CN", LANG: "en_US.UTF-8" }, "zh"],
    [{ SUDUO_LOCALE: "fr", LANG: "zh_CN.UTF-8" }, "zh"],
    [{ SUDUO_LOCALE: "zh", LANG: "en_US.UTF-8" }, "en"],
    [{ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" }, "en"],
    [{ LC_MESSAGES: "zh_TW.UTF-8", LANG: "en_US.UTF-8" }, "zh"],
    [{ LC_ALL: " ", LC_MESSAGES: "", LANG: "zh_CN.UTF-8" }, "zh"],
    [{ LANG: "zh_CN.UTF-8" }, "zh"],
    [{ LANG: "ZH_cn.utf8" }, "zh"],
    [{ LANG: "zh" }, "zh"],
    [{ LANG: "zh-Hans" }, "zh"],
    [{ LANG: "zhx_YY.UTF-8" }, "en"],
    [{ LANG: "C.UTF-8" }, "en"],
    [{ LANG: "POSIX" }, "en"],
    [{ LANG: "  " }, "en"],
    // 与 TS 版的差异：都没设时 TS 版看系统区域，shell 版直接用英文。
    [{}, "en"],
  ];

  it.each(cases)("%j → %s", (env, expected) => {
    const { status, stdout } = run(env, "help");
    expect(status).toBe(0);
    expect(lines(stdout)[0]).toBe(
      expected === "zh"
        ? "用法：./scripts/suduo-cloud.sh <命令> [参数]"
        : "Usage: ./scripts/suduo-cloud.sh <command> [options]",
    );
  });

  it("帮助两种语言各自完整", () => {
    const zh = run(ZH, "help").stdout;
    expect(zh).toContain(
      "  restore <备份目录> [--no-pre-backup]   先自动备份当前数据，再用备份替换全部数据，并按当前检出的版本启动\n" +
        "                                         （需要输入 restore 确认）\n",
    );
    expect(zh).toContain("无终端的自动化场景用 SUDUO_ASSUME_YES=1 跳过输入确认。\n");
    const en = run(EN, "help").stdout;
    expect(en).toContain('then start the checked-out version (type "restore" to confirm)\n');
    expect(en).toContain("For automation without a terminal, SUDUO_ASSUME_YES=1 skips the typed confirmations.\n");
    expect(en).not.toMatch(/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/);
  });

  it("不认识的命令：打印帮助并以 1 退出", () => {
    const zh = run(ZH, "bogus");
    expect(zh.status).toBe(1);
    expect(lines(zh.stdout)[0]).toBe("用法：./scripts/suduo-cloud.sh <命令> [参数]");
    const en = run({ SUDUO_LOCALE: "en", LANG: "zh_CN.UTF-8" }, "bogus");
    expect(en.status).toBe(1);
    expect(lines(en.stdout)[0]).toBe("Usage: ./scripts/suduo-cloud.sh <command> [options]");
  });

  // [参数, 中文报错, 英文报错]：都在检查 Docker 之前退出。
  const errors: Array<[string[], string, string]> = [
    [["install", "--bogus"], "  ✗ 不认识的参数：--bogus", "  ✗ Unknown option: --bogus"],
    [["install", "--port"], "  ✗ --port 后面需要一个值。", "  ✗ --port needs a value."],
    [
      ["install", "--port", "70000"],
      "  ✗ 端口必须是 1–65535 之间的整数。",
      "  ✗ The port must be an integer between 1 and 65535.",
    ],
    [["upgrade", "--bogus"], "  ✗ 不认识的参数：--bogus", "  ✗ Unknown option: --bogus"],
    [["backup", "--to"], "  ✗ --to 后面需要一个值。", "  ✗ --to needs a value."],
    [
      ["restore"],
      "  ✗ 用法：restore <备份目录> [--no-pre-backup]",
      "  ✗ Usage: restore <backup directory> [--no-pre-backup]",
    ],
    [
      ["status"],
      "  ✗ 还没有安装（找不到 server/.env）。先运行 install。",
      "  ✗ Not installed yet (server/.env not found). Run install first.",
    ],
    [
      ["start"],
      "  ✗ 还没有安装（找不到 server/.env）。先运行 install。",
      "  ✗ Not installed yet (server/.env not found). Run install first.",
    ],
  ];

  it.each(errors)("%j 两种语言的报错", (args, zhLine, enLine) => {
    const zh = run(ZH, ...args);
    expect(zh.status).toBe(1);
    expect(lines(zh.stderr)).toContain(zhLine);
    const en = run(EN, ...args);
    expect(en.status).toBe(1);
    expect(lines(en.stderr)).toContain(enLine);
  });

  it("恢复源不是完整备份：报错里带上原样的路径", () => {
    const missing = join(root, "no-such-backup");
    expect(lines(run(ZH, "restore", missing).stderr)).toContain(
      `  ✗ ${missing} 不是完整的备份（需要 database.pgdump 与 files.tar.gz）。`,
    );
    expect(lines(run(EN, "restore", missing).stderr)).toContain(
      `  ✗ ${missing} is not a complete backup (expected database.pgdump and files.tar.gz).`,
    );
  });
});
