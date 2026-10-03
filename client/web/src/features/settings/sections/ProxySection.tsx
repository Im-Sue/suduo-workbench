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
import type { ProxyConnectivityDto } from "@suduo/client-contracts";
import { currentLocale } from "../../../i18n/locale.js";
import { messagesFor, type Messages } from "../../../i18n/messages/index.js";
import { useT } from "../../../i18n/provider.js";

type ProxyField = "httpProxy" | "httpsProxy" | "allProxy" | "noProxy";
type ProxyDraft = Record<ProxyField, string>;

/** 各字段的标题与说明在字典 settingsConnection.proxy.fields 里，按渲染时的语言取。 */
const FIELDS: readonly {
  field: ProxyField;
  anchor: string;
  placeholder: string;
}[] = [
  { field: "httpProxy", anchor: "proxy-http", placeholder: "http://127.0.0.1:7890" },
  { field: "httpsProxy", anchor: "proxy-https", placeholder: "http://127.0.0.1:7890" },
  { field: "allProxy", anchor: "proxy-all", placeholder: "socks5://127.0.0.1:7891" },
  { field: "noProxy", anchor: "no-proxy", placeholder: "localhost,127.0.0.1,.corp.example.com" },
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
export function validateProxyUrl(raw: string, t: Messages = messagesFor(currentLocale())): string | null {
  const text = t.settingsConnection.proxy.validation;
  const value = raw.trim();
  if (value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return text.invalid;
  }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)) return text.protocol;
  if (url.hostname === "") return text.host;
  if (url.username !== "" || url.password !== "") return text.credentials;
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") return text.path;
  return null;
}

function validate(draft: ProxyDraft, t: Messages): Partial<Record<ProxyField, string>> {
  const errors: Partial<Record<ProxyField, string>> = {};
  for (const field of ["httpProxy", "httpsProxy", "allProxy"] as const) {
    const problem = validateProxyUrl(draft[field], t);
    if (problem !== null) errors[field] = problem;
  }
  if (/[\r\n]/.test(draft.noProxy)) errors.noProxy = t.settingsConnection.proxy.validation.noProxyNewline;
  return errors;
}

/** 网络代理：Codex 连模型服务时用的出网代理。多字段一起改，用保存条保存；可以先用草稿测试。 */
export function ProxySection() {
  const text = useT().settingsConnection.proxy;
  const local = useQuery(localSettingsQuery);
  const failure = useQueryFailure(local);
  if (local.isPending) {
    return (
      <SettingsSection id="proxy" description={text.intro}>
        <SectionSkeleton rows={4} label={text.loading} />
      </SettingsSection>
    );
  }
  if (local.isError) {
    return (
      <SettingsSection id="proxy" description={text.intro}>
        <RegionError
          kind={failure?.kind ?? "unknown"}
          message={text.loadFailed(failure?.message ?? "")}
          busy={local.isFetching}
          onRetry={() => void local.refetch()}
        />
      </SettingsSection>
    );
  }
  return <ProxyForm settings={local.data} />;
}

function ProxyForm({ settings }: { settings: SettingsDto }) {
  const t = useT();
  const text = t.settingsConnection.proxy;
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
  useUnsavedChanges("proxy", dirty, text.groupName);

  const errors = validate(draft, t);
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
      showMessage(text.saved, "success");
    } catch (cause) {
      const reported = reportFailure(cause, { surface: "region" });
      if (reported.route.outlet === "region") setSaveError(humanizeProxyMessage(reported.failure.message));
    } finally {
      setSaving(false);
    }
  };

  const test = async (): Promise<TestOutcome> => {
    if (problemCount > 0) return { ok: false, reason: text.test.fixFirst };
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
          reason: text.test.noTarget,
          suggestion: text.test.noTargetSuggestion,
        };
      }
      const route = value.usingProxy ? text.test.viaProxy : text.test.direct;
      if (value.reachable) {
        return { ok: true, text: text.test.ok(route, formatMs(ms), value.targetOrigin) };
      }
      return {
        ok: false,
        reason: text.test.unreachable(route, networkReason(value, t)),
        suggestion: value.usingProxy ? text.test.suggestionProxy : text.test.suggestionDirect,
      };
    } catch (cause) {
      return { ok: false, reason: humanizeProxyMessage(classifyFailure(cause).message) };
    }
  };

  return (
    <SettingsSection
      id="proxy"
      description={text.description}
    >
      {saveError === null ? null : (
        <Banner tone="danger" title={text.saveFailedTitle} className="mb-2">
          {saveError}
        </Banner>
      )}
      {FIELDS.map((item) => {
        const inputId = `settings-${item.anchor}`;
        const error = shown[item.field];
        const label = text.fields[item.field];
        return (
          <SettingsRow key={item.field} anchor={item.anchor} title={label.label} htmlFor={inputId} description={label.description}>
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
        title={text.test.label}
        description={dirty ? text.test.descriptionDraft : empty ? text.test.descriptionEnv : text.test.descriptionSaved}
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
            ? text.interrupt.titleUnknown
            : text.interrupt.titleBusy(interruptPrompt.busy)
        }
        description={
          interruptPrompt?.busy === null ? text.interrupt.descriptionUnknown : text.interrupt.descriptionBusy
        }
        confirmLabel={text.interrupt.confirm}
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

/**
 * 试连失败的原因：按本机服务给出的类型与网络错误码，用当前语言说明（不改写服务端写的文字）。
 * 常见网络错误码译成人话，原码留在括号里便于排查。
 */
export function networkReason(result: ProxyConnectivityDto, t: Messages = messagesFor(currentLocale())): string {
  const text = t.settingsConnection.network;
  const failure = result.failure;
  if (failure === undefined) return result.message;
  if (failure.reason === "invalid-base-url") return text.invalidBaseUrl;
  if (failure.reason === "invalid-proxy") return text.invalidProxy;
  const code = failure.networkCode;
  if (code === null) return text.connectionFailed;
  return Object.hasOwn(text.codes, code) ? text.withCode(text.codes[code as keyof typeof text.codes], code) : code;
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
