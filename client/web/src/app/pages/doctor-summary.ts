import { SUDUO_DOCTOR_CHECK_IDS, type DoctorCheckDto } from "@suduo/client-contracts";
import { currentLocale } from "../../i18n/locale.js";
import { messagesFor, type Messages } from "../../i18n/messages/index.js";

/**
 * 把 /api/v1/doctor 的逐项检查（多为英文技术信息）汇总成用户能读懂的几条结论。
 * 原始检查仍可在「查看全部检查」里展开，供排障时复制。
 * 按检查项的 id 认项（SuDuo 自己的项见 SUDUO_DOCTOR_CHECK_IDS，Codex 官方项是官方 id），不看按语言生成的名称。
 */
export type DoctorCheck = DoctorCheckDto;

export type SummaryStatus = "ok" | "warn" | "fail";

export interface DoctorSummaryItem {
  key: "codex" | "model" | "network" | "sandbox" | "runtime";
  title: string;
  status: SummaryStatus;
  detail: string;
  /** 需要用户去设置里处理时给出的分组锚点。 */
  settingsSection?: string;
}

const find = (checks: readonly DoctorCheck[], id: string) => checks.find((check) => check.id === id);

/** 通过时直接读版本：「已安装，版本 0.159.2」；没报版本时显示服务端的说明。 */
function codexVersionDetail(check: DoctorCheck, text: Messages["setup"]["doctor"]): string {
  return check.version ? text.codexInstalled(check.version) : check.message;
}

/** 算进「本机运行环境」的检查项。 */
const RUNTIME_CHECK_IDS: ReadonlySet<string> = new Set([
  SUDUO_DOCTOR_CHECK_IDS.node,
  SUDUO_DOCTOR_CHECK_IDS.pnpm,
  SUDUO_DOCTOR_CHECK_IDS.sqlite,
  SUDUO_DOCTOR_CHECK_IDS.port,
  SUDUO_DOCTOR_CHECK_IDS.toolServer,
  SUDUO_DOCTOR_CHECK_IDS.git,
]);

/** 文字按调用时的界面语言取；组件里可以传入 useT() 拿到的字典。 */
export function summarizeDoctor(checks: readonly DoctorCheck[], t: Messages = messagesFor(currentLocale())): DoctorSummaryItem[] {
  const text = t.setup.doctor;
  const titles = text.titles;
  const items: DoctorSummaryItem[] = [];

  const cli = find(checks, SUDUO_DOCTOR_CHECK_IDS.codexCli);
  items.push(
    cli === undefined
      ? { key: "codex", title: titles.codex, status: "warn", detail: text.noResult }
      : cli.status === "pass"
        ? { key: "codex", title: titles.codex, status: "ok", detail: codexVersionDetail(cli, text) }
        : { key: "codex", title: titles.codex, status: "fail", detail: text.codexMissing },
  );

  const auth = find(checks, "auth.credentials");
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

  const reach = find(checks, "network.provider_reachability");
  const socket = find(checks, "network.websocket_reachability");
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
  const sandbox = find(checks, SUDUO_DOCTOR_CHECK_IDS.linuxSandbox);
  if (sandbox !== undefined) {
    items.push(
      sandbox.status === "pass"
        ? { key: "sandbox", title: titles.sandbox, status: "ok", detail: text.sandboxReady }
        : { key: "sandbox", title: titles.sandbox, status: "warn", detail: sandbox.message },
    );
  }

  // 缺 Git 只是提醒（不拦启动），但检查点等功能用不了，也要在这里说出来。
  const runtimeFailures = checks.filter(
    (check) => RUNTIME_CHECK_IDS.has(check.id) && (check.status === "fail" || (check.id === SUDUO_DOCTOR_CHECK_IDS.git && check.status !== "pass")),
  );
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
