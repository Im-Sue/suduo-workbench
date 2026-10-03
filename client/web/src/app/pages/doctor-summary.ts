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

export function summarizeDoctor(checks: readonly DoctorCheck[]): DoctorSummaryItem[] {
  const items: DoctorSummaryItem[] = [];

  const cli = find(checks, (name) => name === "Codex CLI");
  items.push(
    cli === undefined
      ? { key: "codex", title: "Codex 命令行", status: "warn", detail: "没有拿到检查结果" }
      : cli.status === "pass"
        ? { key: "codex", title: "Codex 命令行", status: "ok", detail: cli.message.replace(/（.*?）/g, "").replace(/^codex-cli\s*/i, "已安装，版本 ") }
        : { key: "codex", title: "Codex 命令行", status: "fail", detail: "没有找到可用的 Codex 命令行，请重新安装 SuDuo" },
  );

  const auth = find(checks, (name) => name.endsWith("auth.credentials"));
  items.push(
    auth === undefined || auth.status === "pass"
      ? { key: "model", title: "模型服务", status: "ok", detail: "凭据可用" }
      : {
          key: "model",
          title: "模型服务",
          status: "warn",
          detail: "还没有配置模型服务地址或 API Key，开始会话前需要补上",
          settingsSection: "model",
        },
  );

  const reach = find(checks, (name) => name.endsWith("network.provider_reachability"));
  const socket = find(checks, (name) => name.endsWith("network.websocket_reachability"));
  // 只有 fail 才是连不上模型服务：新版 Codex 在这一项里还会以 warning 报「桌面端更新 CDN 不可达」，与模型服务无关。
  if (reach !== undefined && reach.status === "fail") {
    items.push({
      key: "network",
      title: "网络",
      status: "fail",
      detail: "连不上模型服务。检查网络，或在设置里配置代理",
      settingsSection: "proxy",
    });
  } else if (socket !== undefined && socket.status !== "pass") {
    items.push({ key: "network", title: "网络", status: "ok", detail: "可以连上模型服务（将使用 HTTPS 通道）" });
  } else {
    items.push({ key: "network", title: "网络", status: "ok", detail: "可以直连模型服务" });
  }

  // 只有 Linux 上有这一项：沙箱起不来时需要审批或受限执行的命令都会失败，不能只藏在自检明细里。
  const sandbox = find(checks, (name) => name === "Codex 沙箱（Linux）");
  if (sandbox !== undefined) {
    items.push(
      sandbox.status === "pass"
        ? { key: "sandbox", title: "命令沙箱", status: "ok", detail: "可用" }
        : { key: "sandbox", title: "命令沙箱", status: "warn", detail: sandbox.message },
    );
  }

  const runtimeNames = new Set(["Node.js", "pnpm", "better-sqlite3", "监听端口"]);
  const runtimeFailures = checks.filter((check) => runtimeNames.has(check.name) && check.status === "fail");
  items.push(
    runtimeFailures.length === 0
      ? { key: "runtime", title: "本机运行环境", status: "ok", detail: "正常" }
      : {
          key: "runtime",
          title: "本机运行环境",
          status: "warn",
          detail: runtimeFailures.map((check) => `${check.name}：${check.message}`).join("；"),
        },
  );

  return items;
}
