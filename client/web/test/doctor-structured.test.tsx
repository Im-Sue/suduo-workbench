// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DoctorCheckDto } from "@suduo/client-contracts";

const apiMocks = vi.hoisted(() => ({
  runDoctor: vi.fn(),
  openCodexConfigFile: vi.fn(),
  requirementsSettings: vi.fn(),
  testRequirementsSettings: vi.fn(),
}));

vi.mock("../src/api/client.js", () => ({ api: apiMocks }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { summarizeDoctor } from "../src/app/pages/doctor-summary.js";
import { AboutSection } from "../src/features/settings/sections/AboutSection.js";
import { messagesFor } from "../src/i18n/messages/index.js";

/**
 * 自检按检查项的 id 认项、直接读 Codex 版本（S5）：本机服务按请求语言生成名称与说明后，
 * 前端的分组与版本显示不能再依赖中文名称或全角括注。
 */

const check = (fields: Partial<DoctorCheckDto> & Pick<DoctorCheckDto, "id" | "status">): DoctorCheckDto => ({
  name: fields.id,
  message: "",
  ...fields,
});

describe("自检摘要按 id 认项", () => {
  it("英文名称的检查项照样归到沙箱与本机运行环境", () => {
    const summary = summarizeDoctor(
      [
        check({ id: "suduo.codex-cli", name: "Codex CLI", status: "pass", message: "codex-cli 0.159.2 (pinned in the workspace)", version: "0.159.2" }),
        check({ id: "suduo.linux-sandbox", name: "Codex sandbox (Linux)", status: "warn", message: "Codex's sandbox can't start on this machine" }),
        check({ id: "suduo.port", name: "Listening port", status: "fail", message: "127.0.0.1:8787 is in use by another program" }),
      ],
      messagesFor("en"),
    );
    expect(summary.find((item) => item.key === "codex")?.detail).toBe("Installed, version 0.159.2");
    expect(summary.find((item) => item.key === "sandbox")).toMatchObject({
      status: "warn",
      detail: "Codex's sandbox can't start on this machine",
    });
    expect(summary.find((item) => item.key === "runtime")).toMatchObject({
      status: "warn",
      detail: "Listening port: 127.0.0.1:8787 is in use by another program",
    });
  });

  it("中文结论与改造前一致；名称相同但不带 id 的项不再被认出", () => {
    const summary = summarizeDoctor(
      [
        check({ id: "suduo.codex-cli", name: "Codex CLI", status: "pass", message: "codex-cli 0.159.2（workspace 锁定版本）", version: "0.159.2" }),
        check({ id: "suduo.port", name: "监听端口", status: "fail", message: "127.0.0.1:8787 已被其他程序占用" }),
        // 官方检查项里恰好叫 better-sqlite3 的不是 SuDuo 的数据库检查。
        check({ id: "fixture.other", name: "better-sqlite3", status: "fail", message: "unrelated" }),
      ],
      messagesFor("zh-CN"),
    );
    expect(summary.find((item) => item.key === "codex")?.detail).toBe("已安装，版本 0.159.2");
    expect(summary.find((item) => item.key === "runtime")?.detail).toBe("监听端口：127.0.0.1:8787 已被其他程序占用");
  });

  it("Codex CLI 没报版本时显示本机服务的说明", () => {
    const summary = summarizeDoctor(
      [check({ id: "suduo.codex-cli", name: "Codex CLI", status: "pass", message: "codex-cli", version: null })],
      messagesFor("zh-CN"),
    );
    expect(summary.find((item) => item.key === "codex")?.detail).toBe("codex-cli");
  });
});

let root: Root | null = null;
let node: HTMLDivElement | null = null;

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  node?.remove();
  root = null;
  node = null;
  vi.clearAllMocks();
});

async function renderAbout(checks: DoctorCheckDto[]): Promise<HTMLDivElement> {
  apiMocks.runDoctor.mockResolvedValue({ status: "PASS", checks });
  apiMocks.requirementsSettings.mockResolvedValue({ configured: false, baseUrl: null, session: null, mappingCount: 0 });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={queryClient}>
        <AboutSection />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => {
    expect(apiMocks.runDoctor).toHaveBeenCalled();
    expect(node?.querySelector("dd .animate-pulse, dd [data-slot='skeleton']")).toBeNull();
  });
  await act(async () => {});
  return node;
}

function codexCliCell(container: HTMLElement): string | null | undefined {
  const terms = [...container.querySelectorAll("dt")];
  const term = terms.find((item) => item.textContent === "Codex 命令行");
  return term?.nextElementSibling?.textContent;
}

describe("设置 · 关于 · Codex 命令行版本", () => {
  it("通过时直接显示结构化的版本号", async () => {
    const container = await renderAbout([
      check({ id: "suduo.codex-cli", name: "Codex CLI", status: "pass", message: "codex-cli 0.159.2（workspace 锁定版本）", version: "0.159.2" }),
    ]);
    expect(codexCliCell(container)).toBe("0.159.2");
  });

  it("版本不对时显示本机服务的说明（与改造前相同）", async () => {
    const container = await renderAbout([
      check({ id: "suduo.codex-cli", name: "Codex CLI", status: "fail", message: "需要 codex-cli 0.159.2，当前为 0.150.0", version: "0.150.0" }),
    ]);
    expect(codexCliCell(container)).toBe("需要 codex-cli 0.159.2，当前为 0.150.0");
  });

  it("诊断页链接带上界面语言", async () => {
    const container = await renderAbout([]);
    const link = [...container.querySelectorAll("a")].find((item) => item.getAttribute("href")?.startsWith("/doctor"));
    expect(link?.getAttribute("href")).toBe("/doctor?lang=zh-CN");
    expect(codexCliCell(container)).toBe("没能读取");
  });
});
