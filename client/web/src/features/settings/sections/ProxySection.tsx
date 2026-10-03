import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SettingsDto } from "@suduo/client-contracts";
import { AlertTriangleIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Banner } from "@/components/ui/banner";
import { Input } from "@/components/ui/input";
import { api } from "../../../api/client.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { ConfirmDialog, RegionError } from "../../../feedback/components/index.js";
import { reportFailure } from "../../../feedback/report.js";
import { showMessage } from "../../../ui/message.js";
import { SaveBar, useUnsavedChanges } from "../components/frame.js";
import { rowDescId, SectionSkeleton, SettingsRow, SettingsSection } from "../components/kit.js";
import { formatMs, TestConnection, timed, type TestOutcome } from "../components/TestConnection.js";
import { humanizeProxyMessage } from "../format.js";
import { localSettingsQuery, settingsKeys } from "../queries.js";
import { useQueryFailure } from "../use-query-failure.js";

type ProxyField = "httpProxy" | "httpsProxy" | "allProxy" | "noProxy";
type ProxyDraft = Record<ProxyField, string>;

const FIELDS: readonly {
  field: ProxyField;
  anchor: string;
  title: string;
  description: string;
  placeholder: string;
}[] = [
  { field: "httpProxy", anchor: "proxy-http", title: "HTTP 代理", description: "访问 http:// 地址时使用。", placeholder: "http://127.0.0.1:7890" },
  { field: "httpsProxy", anchor: "proxy-https", title: "HTTPS 代理", description: "访问 https:// 地址时使用，模型服务通常走这一项。", placeholder: "http://127.0.0.1:7890" },
  { field: "allProxy", anchor: "proxy-all", title: "其他连接的代理", description: "上面两项没填时的兜底，也用于其他协议，支持 SOCKS。", placeholder: "socks5://127.0.0.1:7891" },
  { field: "noProxy", anchor: "no-proxy", title: "不走代理的地址", description: "多个用逗号分隔，例如内网域名、localhost。", placeholder: "localhost,127.0.0.1,.corp.example.com" },
];

function draftOf(settings: SettingsDto): ProxyDraft {
  return {
    httpProxy: settings.httpProxy,
    httpsProxy: settings.httpsProxy,
    allProxy: settings.allProxy,
    noProxy: settings.noProxy,
  };
}

/** 与服务端同一套规则：http / https / socks5 / socks5h，要有主机，不带账号密码和路径。 */
export function validateProxyUrl(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "这不是一个有效的代理地址，例如 http://127.0.0.1:7890";
  }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)) return "只支持 http、https、socks5 代理";
  if (url.hostname === "") return "代理地址里要有主机名或 IP";
  if (url.username !== "" || url.password !== "") return "暂不支持带账号密码的代理";
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") return "代理地址只写到端口，不带路径";
  return null;
}

function validate(draft: ProxyDraft): Partial<Record<ProxyField, string>> {
  const errors: Partial<Record<ProxyField, string>> = {};
  for (const field of ["httpProxy", "httpsProxy", "allProxy"] as const) {
    const problem = validateProxyUrl(draft[field]);
    if (problem !== null) errors[field] = problem;
  }
  if (/[\r\n]/.test(draft.noProxy)) errors.noProxy = "不能换行，多个地址用逗号分隔";
  return errors;
}

/** 网络代理：Codex 连模型服务时用的出网代理。多字段一起改，用保存条保存；可以先用草稿测试。 */
export function ProxySection() {
  const local = useQuery(localSettingsQuery);
  const failure = useQueryFailure(local);
  if (local.isPending) {
    return (
      <SettingsSection id="proxy" description="Codex 连接模型服务时使用的代理。">
        <SectionSkeleton rows={4} label="正在读取代理设置" />
      </SettingsSection>
    );
  }
  if (local.isError) {
    return (
      <SettingsSection id="proxy" description="Codex 连接模型服务时使用的代理。">
        <RegionError
          kind={failure?.kind ?? "unknown"}
          message={`没能读取代理设置：${failure?.message ?? ""}`}
          busy={local.isFetching}
          onRetry={() => void local.refetch()}
        />
      </SettingsSection>
    );
  }
  return <ProxyForm settings={local.data} />;
}

function ProxyForm({ settings }: { settings: SettingsDto }) {
  const queryClient = useQueryClient();
  const saved = draftOf(settings);
  const [draft, setDraft] = useState<ProxyDraft>(saved);
  const [baseline, setBaseline] = useState(settings);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const refs = useRef<Partial<Record<ProxyField, HTMLInputElement | null>>>({});

  const dirty = (Object.keys(saved) as ProxyField[]).some((field) => draft[field].trim() !== saved[field]);
  // 没在编辑时跟随服务端的新值；正在编辑时不打断（以变化前的值判断有没有改过）。
  if (baseline !== settings) {
    const before = draftOf(baseline);
    const untouched = (Object.keys(before) as ProxyField[]).every((field) => draft[field] === before[field]);
    setBaseline(settings);
    if (untouched) setDraft(draftOf(settings));
  }
  useUnsavedChanges("proxy", dirty, "网络代理");

  const errors = validate(draft);
  const shown = attempted ? errors : pickChanged(errors, draft, saved);
  const problemCount = Object.keys(errors).length;
  const empty = (Object.keys(saved) as ProxyField[]).every((field) => saved[field] === "");

  // 保存代理会让 Codex 重新连接：正在跑的回合被中断、等你确认的操作被取消。
  // 不拦保存（ADR-0004），但先告诉你会影响几个会话，由你决定现在保存还是等它们结束。
  const [interruptPrompt, setInterruptPrompt] = useState<{ busy: number | null } | null>(null);

  const save = async () => {
    setAttempted(true);
    const first = (Object.keys(errors) as ProxyField[])[0];
    if (first !== undefined) {
      refs.current[first]?.focus();
      return;
    }
    const busy = await countBusySessions();
    if (busy !== 0) {
      setInterruptPrompt({ busy });
      return;
    }
    await commit();
  };

  const commit = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const next = await api.updateSettings({
        httpProxy: draft.httpProxy.trim(),
        httpsProxy: draft.httpsProxy.trim(),
        allProxy: draft.allProxy.trim(),
        noProxy: draft.noProxy.trim(),
      });
      setDraft(draftOf(next));
      setAttempted(false);
      queryClient.setQueryData(settingsKeys.local, next);
      void queryClient.invalidateQueries({ queryKey: settingsKeys.networkHealth });
      showMessage("代理已保存，Codex 已按新设置重新连接。", "success");
    } catch (cause) {
      const reported = reportFailure(cause, { surface: "region" });
      if (reported.route.outlet === "region") setSaveError(humanizeProxyMessage(reported.failure.message));
    } finally {
      setSaving(false);
    }
  };

  const test = async (): Promise<TestOutcome> => {
    if (problemCount > 0) return { ok: false, reason: "先改正上面标红的地址再测试。" };
    try {
      const { value, ms } = await timed(() =>
        api.testProxySettings({
          httpProxy: draft.httpProxy.trim(),
          httpsProxy: draft.httpsProxy.trim(),
          allProxy: draft.allProxy.trim(),
          noProxy: draft.noProxy.trim(),
        }),
      );
      if (!value.reachable && value.targetOrigin === "") {
        // 没有可测的地址（Codex 在用内置默认服务，或模型服务还没填地址），不是「连不上」。
        return {
          ok: false,
          reason: "还没有模型服务地址可以测：Codex 目前用的是内置的默认服务，或模型服务还没填地址。",
          suggestion: "在「模型服务」里填好地址后再来测代理。",
        };
      }
      const route = value.usingProxy ? "经代理" : "直连";
      if (value.reachable) {
        return { ok: true, text: `能连上模型服务 · ${route} · ${formatMs(ms)}${value.targetOrigin === "" ? "" : ` · ${value.targetOrigin}`}` };
      }
      return {
        ok: false,
        reason: `连不上模型服务（${route}）：${networkReason(value.message)}`,
        suggestion: value.usingProxy
          ? "检查代理地址和端口是否正确、代理软件是否在运行；内网地址可以加到「不走代理的地址」里。"
          : "如果公司网络需要代理才能访问模型服务，在上面填写代理地址后再试。",
      };
    } catch (cause) {
      return { ok: false, reason: humanizeProxyMessage(classifyFailure(cause).message) };
    }
  };

  return (
    <SettingsSection
      id="proxy"
      description="Codex 连接模型服务时使用的代理。都留空时沿用本机服务启动时的代理环境变量（HTTP_PROXY 等，没有就直连）。保存后 Codex 会重新连接一次，正在运行的回合会被中断。"
    >
      {saveError === null ? null : (
        <Banner tone="danger" title="没能保存" className="mb-2">
          {saveError}
        </Banner>
      )}
      {FIELDS.map((item) => {
        const inputId = `settings-${item.anchor}`;
        const error = shown[item.field];
        return (
          <SettingsRow key={item.field} anchor={item.anchor} title={item.title} htmlFor={inputId} description={item.description}>
            <Input
              ref={(node) => {
                refs.current[item.field] = node;
              }}
              id={inputId}
              className="font-mono"
              placeholder={item.placeholder}
              value={draft[item.field]}
              aria-invalid={error === undefined ? undefined : true}
              aria-describedby={error === undefined ? rowDescId(item.anchor) : `${rowDescId(item.anchor)} ${inputId}-error`}
              onChange={(event) => {
                const value = event.target.value;
                setDraft((current) => ({ ...current, [item.field]: value }));
                setSaveError(null);
              }}
            />
            {error === undefined ? null : (
              <p id={`${inputId}-error`} role="alert" className="m-0 flex items-center gap-1 text-caption text-danger">
                <AlertTriangleIcon aria-hidden="true" className="size-3.5" />
                {error}
              </p>
            )}
          </SettingsRow>
        );
      })}

      <SettingsRow
        anchor="proxy-test"
        title="连接测试"
        description={dirty ? "用当前填写的内容试连模型服务一次，不会保存。" : empty ? "按本机服务启动时的代理环境变量（没有就直连）试连模型服务。" : "用已保存的代理试连模型服务。"}
      >
        <TestConnection run={test} resetKey={JSON.stringify(draft)} />
      </SettingsRow>

      <SaveBar
        dirty={dirty}
        saving={saving}
        problems={attempted ? problemCount : 0}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft(saved);
          setAttempted(false);
          setSaveError(null);
        }}
      />
      <ConfirmDialog
        open={interruptPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setInterruptPrompt(null);
        }}
        title={
          interruptPrompt?.busy === null || interruptPrompt === null
            ? "保存后 Codex 会重新连接"
            : `有 ${interruptPrompt.busy} 个会话正在运行或等你确认`
        }
        description={
          interruptPrompt?.busy === null
            ? "没能确认有没有会话正在运行。保存后 Codex 会重新连接，正在进行的回合会被中断、等你确认的操作会被取消。"
            : "保存后 Codex 会重新连接，这些会话正在进行的回合会被中断、等你确认的操作会被取消。可以先等它们结束再保存。"
        }
        confirmLabel="仍然保存"
        onConfirm={() => {
          setInterruptPrompt(null);
          void commit();
        }}
      />
    </SettingsSection>
  );
}

/** 正在运行或等你确认的会话数；读不到时返回 null（按「不确定」提醒）。 */
async function countBusySessions(): Promise<number | null> {
  try {
    // 按最后活动时间倒序：在跑的会话一定在最前面，取一页足够。
    const page = await api.listAllSessions({ state: "active", limit: 100 });
    return page.items.filter((item) => item.runStatus.running || item.runStatus.pendingApprovals > 0).length;
  } catch {
    return null;
  }
}

const NETWORK_CODE_TEXT: Readonly<Record<string, string>> = {
  ECONNREFUSED: "对方拒绝连接，端口上可能没有服务",
  ECONNRESET: "连接被中断",
  ETIMEDOUT: "连接超时",
  ENOTFOUND: "找不到这个地址",
  EAI_AGAIN: "暂时解析不了这个地址",
  EHOSTUNREACH: "网络不可达",
  ENETUNREACH: "网络不可达",
  CERT_HAS_EXPIRED: "对方的证书已过期",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "无法验证对方的证书",
  SELF_SIGNED_CERT_IN_CHAIN: "对方使用了自签名证书",
};

/** 本机服务的探测说明换成界面用语；网络错误码译成人话，原码留在括号里便于排查。 */
export function networkReason(message: string): string {
  const text = message
    .replace(/^无法连接模型网关：/, "")
    .replace(/模型网关/g, "模型服务")
    .replace(/代理环境变量/g, "启动环境里的代理变量");
  const known = NETWORK_CODE_TEXT[text];
  return known === undefined ? text : `${known}（${text}）`;
}

function pickChanged(
  errors: Partial<Record<ProxyField, string>>,
  draft: ProxyDraft,
  saved: ProxyDraft,
): Partial<Record<ProxyField, string>> {
  const result: Partial<Record<ProxyField, string>> = {};
  for (const field of Object.keys(errors) as ProxyField[]) {
    if (draft[field].trim() !== saved[field] && errors[field] !== undefined) result[field] = errors[field];
  }
  return result;
}
