import { currentLocale } from "../../i18n/locale.js";
import { messagesFor, type Messages } from "../../i18n/messages/index.js";

/**
 * 把 /api/v1/doctor 的逐项检查（多为英文技术信息）汇总成用户能读懂的几条结论。
 * 原始检查仍可在「查看全部检查」里展开，供排障时复制。
 */
export interface DoctorCheck {
  name: string;
  status: string;
  message: string;
  remediation?: string | null;
}

export type SummaryStatus = "ok" | "warn" | "fail";

export interface DoctorSummaryItem {
  key: "codex" | "model" | "network" | "sandbox" | "runtime";
  title: string;
  status: SummaryStatus;
  detail: string;
  /** 需要用户去设置里处理时给出的分组锚点。 */
  settingsSection?: string;
}

const find = (checks: readonly DoctorCheck[], predicate: (name: string) => boolean) =>
  checks.find((check) => predicate(check.name));

/** 「codex-cli 0.159.2（workspace 锁定版本）」→「已安装，版本 0.159.2」；认不出格式时原样显示。 */
function codexVersionDetail(message: string, text: Messages["setup"]["doctor"]): string {
  // 依赖服务端中文文字（去掉全角括号里的说明），S5 改为读结构化字段；正则字面量不触发 i18n 规则，不必加 eslint-disable。
  const stripped = message.replace(/（.*?）/g, "");
  const prefix = /^codex-cli\s*/i.exec(stripped);
  return prefix === null ? stripped : text.codexInstalled(stripped.slice(prefix[0].length));
}

/** 文字按调用时的界面语言取；组件里可以传入 useT() 拿到的字典。 */
export function summarizeDoctor(checks: readonly DoctorCheck[], t: Messages = messagesFor(currentLocale())): DoctorSummaryItem[] {
  const text = t.setup.doctor;
  const titles = text.titles;
  const items: DoctorSummaryItem[] = [];

  const cli = find(checks, (name) => name === "Codex CLI");
  items.push(
    cli === undefined
      ? { key: "codex", title: titles.codex, status: "warn", detail: text.noResult }
      : cli.status === "pass"
        ? { key: "codex", title: titles.codex, status: "ok", detail: codexVersionDetail(cli.message, text) }
        : { key: "codex", title: titles.codex, status: "fail", detail: text.codexMissing },
  );

  const auth = find(checks, (name) => name.endsWith("auth.credentials"));
  items.push(
    auth === undefined || auth.status === "pass"
      ? { key: "model", title: titles.model, status: "ok", detail: text.modelReady }
      : {
          key: "model",
          title: titles.model,
          status: "warn",
          detail: text.modelMissing,
          settingsSection: "model",
        },
  );

  const reach = find(checks, (name) => name.endsWith("network.provider_reachability"));
  const socket = find(checks, (name) => name.endsWith("network.websocket_reachability"));
  // 只有 fail 才是连不上模型服务：新版 Codex 在这一项里还会以 warning 报「桌面端更新 CDN 不可达」，与模型服务无关。
  if (reach !== undefined && reach.status === "fail") {
    items.push({
      key: "network",
      title: titles.network,
      status: "fail",
      detail: text.networkUnreachable,
      settingsSection: "proxy",
    });
  } else if (socket !== undefined && socket.status !== "pass") {
    items.push({ key: "network", title: titles.network, status: "ok", detail: text.networkViaHttps });
  } else {
    items.push({ key: "network", title: titles.network, status: "ok", detail: text.networkDirect });
  }

  // 只有 Linux 上有这一项：沙箱起不来时需要审批或受限执行的命令都会失败，不能只藏在自检明细里。
  // eslint-disable-next-line no-restricted-syntax -- 依赖服务端中文文字，S5 改为读结构化字段
  const sandbox = find(checks, (name) => name === "Codex 沙箱（Linux）");
  if (sandbox !== undefined) {
    items.push(
      sandbox.status === "pass"
        ? { key: "sandbox", title: titles.sandbox, status: "ok", detail: text.sandboxReady }
        : { key: "sandbox", title: titles.sandbox, status: "warn", detail: sandbox.message },
    );
  }

  // eslint-disable-next-line no-restricted-syntax -- 依赖服务端中文文字，S5 改为读结构化字段
  const runtimeNames = new Set(["Node.js", "pnpm", "better-sqlite3", "监听端口"]);
  const runtimeFailures = checks.filter((check) => runtimeNames.has(check.name) && check.status === "fail");
  items.push(
    runtimeFailures.length === 0
      ? { key: "runtime", title: titles.runtime, status: "ok", detail: text.runtimeReady }
      : {
          key: "runtime",
          title: titles.runtime,
          status: "warn",
          detail: runtimeFailures.map((check) => text.runtimeFailure(check.name, check.message)).join(text.runtimeFailureSeparator),
        },
  );

  return items;
}
