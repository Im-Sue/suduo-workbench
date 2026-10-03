import { describe, expect, it } from "vitest";
import { buildOpenCommand } from "../src/infrastructure/platform/system-open.js";

describe("buildOpenCommand", () => {
  it("win32 直开与定位", () => {
    expect(
      buildOpenCommand({
        platform: "win32",
        wsl: false,
        mode: "open",
        path: "C:\\Projects\\a.docx",
      }),
    ).toEqual({ command: "explorer.exe", args: ["C:\\Projects\\a.docx"] });
    expect(
      buildOpenCommand({
        platform: "win32",
        wsl: false,
        mode: "reveal",
        path: "C:\\Projects\\a.docx",
      }),
    ).toEqual({
      command: "explorer.exe",
      args: ["/select,C:\\Projects\\a.docx"],
    });
  });

  it("WSL 走 explorer.exe（路径已由调用方转换为 Windows 形式）", () => {
    expect(
      buildOpenCommand({
        platform: "linux",
        wsl: true,
        mode: "open",
        path: "\\\\wsl.localhost\\Ubuntu\\home\\a.md",
      }).command,
    ).toBe("explorer.exe");
  });

  it("linux 桌面 xdg-open，reveal 退化为所在目录", () => {
    expect(
      buildOpenCommand({
        platform: "linux",
        wsl: false,
        mode: "open",
        path: "/home/user/a.md",
      }),
    ).toEqual({ command: "xdg-open", args: ["/home/user/a.md"] });
    expect(
      buildOpenCommand({
        platform: "linux",
        wsl: false,
        mode: "reveal",
        path: "/home/user/docs/a.md",
      }),
    ).toEqual({ command: "xdg-open", args: ["/home/user/docs"] });
  });

  it("darwin open 与 open -R", () => {
    expect(
      buildOpenCommand({
        platform: "darwin",
        wsl: false,
        mode: "reveal",
        path: "/Users/a/b.md",
      }),
    ).toEqual({ command: "open", args: ["-R", "/Users/a/b.md"] });
  });

  it("vscode：win32 经 cmd /c，linux 直接 code", () => {
    expect(
      buildOpenCommand({
        platform: "win32",
        wsl: false,
        mode: "vscode",
        path: "C:\\P\\a.md",
      }),
    ).toEqual({ command: "cmd", args: ["/c", "code", "C:\\P\\a.md"] });
    expect(
      buildOpenCommand({
        platform: "linux",
        wsl: true,
        mode: "vscode",
        path: "/home/a/p",
      }),
    ).toEqual({ command: "code", args: ["/home/a/p"] });
  });

  it("terminal：win32 用 start 继承 cwd；WSL 用 wt.exe；linux 终端仿真器", () => {
    expect(
      buildOpenCommand({
        platform: "win32",
        wsl: false,
        mode: "terminal",
        path: "C:\\P\\a.md",
        directory: "C:\\P",
      }),
    ).toEqual({ command: "cmd", args: ["/c", "start", "", "cmd"], cwd: "C:\\P" });
    expect(
      buildOpenCommand({
        platform: "linux",
        wsl: true,
        mode: "terminal",
        path: "X:\\p",
        directory: "\\\\wsl.localhost\\U\\home",
      }),
    ).toEqual({ command: "wt.exe", args: ["-d", "\\\\wsl.localhost\\U\\home"] });
    expect(
      buildOpenCommand({
        platform: "linux",
        wsl: false,
        mode: "terminal",
        path: "/home/a/p/f.md",
        directory: "/home/a/p",
        linuxTerminal: "gnome-terminal",
      }),
    ).toEqual({
      command: "gnome-terminal",
      args: ["--working-directory=/home/a/p"],
    });
  });
});
