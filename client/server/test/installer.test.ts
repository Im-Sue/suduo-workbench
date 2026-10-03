import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendInstallLog,
  formatBufferedOutput,
} from "../../scripts/dist-win/runtime-support.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const distWin = resolve(root, "scripts", "dist-win");
const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function readInstaller(): string {
  return readFileSync(resolve(distWin, "installer.nsi"), "utf8");
}

function readTemplate(name: string): string {
  return readFileSync(resolve(distWin, "templates", name), "utf8");
}

describe("Windows 安装器（放文件 + 按需启动器形态）", () => {
  it("安装只放文件：不做 ACL 手术、不注册计划任务、不写剪贴板", () => {
    const installer = readInstaller();
    expect(installer).not.toContain("icacls");
    expect(installer).not.toContain("schtasks");
    expect(installer).not.toContain("clip.exe");
    expect(installer).not.toContain("MessageBox MB_ICONSTOP");
    expect(installer.toLowerCase()).not.toContain("powershell");
    expect(installer.toLowerCase()).not.toContain("cmd.exe");
    expect(installer.toLowerCase()).not.toContain("wscript");
  });

  it("升级前先用临时目录里的停服脚本停掉旧服务，再覆盖文件", () => {
    const installer = readInstaller();
    expect(installer).toContain('File "/oname=stop-suduo.mjs"');
    expect(installer).toContain("$PLUGINSDIR\\stop-suduo.mjs");
    const stopIndex = installer.indexOf("stop-suduo.mjs");
    const payloadIndex = installer.indexOf('SetOutPath "$INSTDIR"');
    expect(stopIndex).toBeGreaterThan(0);
    expect(payloadIndex).toBeGreaterThan(stopIndex);
  });

  it("清理迁移失败只警告不 Abort，安装继续", () => {
    const installer = readInstaller();
    expect(installer).toContain("install-runtime.mjs");
    expect(installer).toContain("安装继续");
    expect(installer).not.toMatch(/^\s*Abort\s*$/m);
  });

  it("快捷方式直指捆绑 node.exe + 启动器，零 shell 包装", () => {
    const installer = readInstaller();
    expect(installer).toContain(
      'CreateShortCut "$DESKTOP\\SuDuo.lnk" "$INSTDIR\\runtime\\node.exe"',
    );
    expect(installer).toContain("launcher.mjs");
    expect(installer).toContain('--doctor');
    expect(installer.match(/CreateShortCut/g)).toHaveLength(4);
    expect(installer).toContain("卸载 SuDuo.lnk");
  });

  it("模板清单只含启动/停止/清理脚本，零 PowerShell、零计划任务 XML", () => {
    const templates = readdirSync(resolve(distWin, "templates")).sort();
    expect(templates).toEqual([
      "install-runtime.mjs",
      "launcher.mjs",
      "stop-suduo.mjs",
      "uninstall-runtime.mjs",
    ]);
    for (const name of templates) {
      const content = readTemplate(name).toLowerCase();
      expect(content).not.toContain("powershell");
      expect(content).not.toContain("wscript");
      expect(content).not.toContain("cmd.exe");
    }
  });

  it("迁移脚本只做 icacls /reset 恢复继承，不再收权，且永不阻断", () => {
    const installRuntime = readTemplate("install-runtime.mjs");
    expect(installRuntime).toContain('"/reset"');
    expect(installRuntime).not.toContain("/inheritance:r");
    expect(installRuntime).not.toContain("/grant");
    expect(installRuntime).not.toContain("/Create");
    expect(installRuntime).toContain("process.exitCode = 0");
    expect(installRuntime).toContain("data");
  });

  it("启动器按需拉起服务并直接打开工作台", () => {
    const launcher = readTemplate("launcher.mjs");
    expect(launcher).toContain("healthz");
    expect(launcher).toContain('"--app=" + url');
    expect(launcher).toContain("--runtime-config");
    expect(launcher).toContain("--doctor");
    expect(launcher).not.toContain("?token=");
    expect(launcher).not.toContain("access-token");
    expect(launcher).not.toContain("SUDUO_ACCESS_TOKEN_FILE");
    expect(launcher).not.toContain("clip.exe");
  });

  it("停服脚本先优雅退出再按 pid 兜底，并清理旧版计划任务", () => {
    const stop = readTemplate("stop-suduo.mjs");
    expect(stop).toContain("api/v1/admin/shutdown");
    expect(stop).toContain("taskkill.exe");
    expect(stop).toContain('"/Delete", "/TN", "SuDuo"');
    expect(stop).toContain("process.exitCode = 0");
    const uninstall = readTemplate("uninstall-runtime.mjs");
    expect(uninstall).toContain("api/v1/admin/shutdown");
    expect(uninstall).toContain("taskkill.exe");
  });

  it("应用窗口带标题与图标", () => {
    const index = readFileSync(resolve(root, "web", "index.html"), "utf8");
    const favicon = readFileSync(
      resolve(root, "web", "public", "favicon.svg"),
      "utf8",
    );
    expect(index).toContain("<title>SuDuo</title>");
    expect(index).toContain('href="/favicon.svg"');
    expect(favicon).toContain("<svg");
    expect(favicon).toContain("Z");
  });

  it("安装日志逐条带时间戳并保留 UTF-8/GBK 双视图", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "suduo-install-log-"));
    temporaryPaths.push(directory);
    const logPath = resolve(directory, "install.log");
    const output = formatBufferedOutput(
      "stdout",
      Buffer.from([0xb2, 0xe2, 0xca, 0xd4]),
    );
    appendInstallLog(logPath, output, new Date("2026-07-13T12:00:00.000Z"));
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("[2026-07-13T12:00:00.000Z]");
    expect(log).toContain("stdout.base64=suLK1A==");
    expect(log).toContain('stdout.gbk="测试"');
    expect(log).toContain("stdout.utf8=");
    const installer = readInstaller();
    expect(installer).toContain("$INSTDIR\\data\\install.log");
  });
});
