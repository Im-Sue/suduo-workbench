import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { api } from "../../../api/client.js";
import { queryKeys, settingsQuery } from "../../../app/queries.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { ConfirmDialog, InlineError } from "../../../feedback/components/index.js";
import { needsConfirm } from "../../../feedback/confirm-policy.js";
import { reportFailure } from "../../../feedback/report.js";
import type { Failure } from "../../../feedback/types.js";
import { currentLocale } from "../../../i18n/locale.js";
import { messagesFor, type Messages } from "../../../i18n/messages/index.js";
import { useT } from "../../../i18n/provider.js";
import { SaveBar, useUnsavedChanges } from "../components/frame.js";
import { rowDescId, SettingsRow, SettingsSection, StatusPill } from "../components/kit.js";
import { formatMs, TestConnection, timed, type TestOutcome } from "../components/TestConnection.js";
import { builtVersion, compareWithCloud } from "../version.js";

const INPUT_ID = "settings-base-url";

/** 文字按调用时的界面语言取；组件里可以传入 useT() 拿到的字典。 */
export function validateServiceUrl(value: string, t: Messages = messagesFor(currentLocale())): string | null {
  const text = t.settings.service;
  const trimmed = value.trim();
  if (trimmed === "") return text.urlRequired;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return text.urlProtocol;
  } catch {
    return text.urlInvalid;
  }
  return null;
}

/** 需求服务：团队共享需求所在的地址。改地址会退出当前登录，所以保存前先确认。 */
export function ServiceSection() {
  const t = useT();
  const text = t.settings.service;
  const queryClient = useQueryClient();
  const settings = useQuery(settingsQuery).data;
  const saved = settings?.baseUrl ?? "";
  const [draft, setDraft] = useState(saved);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dirty = draft.trim() !== saved;
  const fieldError = touched || dirty ? validateServiceUrl(draft, t) : null;

  // 没在编辑时跟随服务端的值；正在编辑时不打断（只在服务端值变化时同步）。
  const lastSaved = useRef(saved);
  useEffect(() => {
    if (lastSaved.current === saved) return;
    setDraft((current) => (current.trim() === lastSaved.current ? saved : current));
    lastSaved.current = saved;
  }, [saved]);

  useUnsavedChanges("service", dirty, text.unsavedTitle);

  const save = async () => {
    const next = draft.trim();
    setSaving(true);
    setFailure(null);
    try {
      const result = await api.updateRequirementsSettings(next);
      // 先把草稿对齐到保存后的值，再刷新登录状态（换了服务会被带去登录页，不能被「未保存」拦下）。
      setDraft(result.baseUrl ?? next);
      queryClient.setQueryData(queryKeys.settings, result);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    } catch (cause) {
      const reported = reportFailure(cause, { surface: "field" });
      setFailure(reported.route.outlet === "field" ? reported.failure : null);
    } finally {
      setSaving(false);
    }
  };

  const requestSave = () => {
    setTouched(true);
    if (validateServiceUrl(draft, t) !== null) {
      inputRef.current?.focus();
      return;
    }
    if (settings?.session != null && needsConfirm("change-requirements-service")) {
      setConfirming(true);
      return;
    }
    void save();
  };

  const test = async (): Promise<TestOutcome> => {
    const problem = validateServiceUrl(draft, t);
    if (problem !== null) return { ok: false, reason: problem };
    try {
      const { value, ms } = await timed(() => api.testRequirementsSettings(draft.trim()));
      const parts = [text.testOk(formatMs(ms, t))];
      const cloudVersion = typeof value.version === "string" ? value.version : null;
      if (cloudVersion !== null) parts.push(text.testCloudVersion(cloudVersion));
      // 版本不一致只提示，不拦截（ADR-0004）。
      if (compareWithCloud(builtVersion(), cloudVersion) === "different") {
        parts.push(text.testVersionMismatch(builtVersion() ?? ""));
      }
      return { ok: true, text: parts.join(" · ") };
    } catch (cause) {
      const failure = classifyFailure(cause);
      return {
        ok: false,
        reason: failure.kind === "validation" ? failure.message : text.testUnreachable,
        suggestion: text.testSuggestion,
      };
    }
  };

  return (
    <SettingsSection
      id="service"
      description={text.description}
      badge={settings?.configured === true ? <StatusPill tone="success">{text.configured}</StatusPill> : <StatusPill tone="danger">{text.notConfigured}</StatusPill>}
    >
      <SettingsRow anchor="service-url" title={text.urlTitle} htmlFor={INPUT_ID} description={text.urlDescription}>
        <Input
          ref={inputRef}
          id={INPUT_ID}
          data-testid="settings-base-url"
          className="font-mono"
          placeholder={text.urlPlaceholder}
          value={draft}
          aria-invalid={fieldError !== null || undefined}
          aria-describedby={[rowDescId("service-url"), fieldError === null ? null : `${INPUT_ID}-error`].filter(Boolean).join(" ")}
          onChange={(event) => {
            setDraft(event.target.value);
            setFailure(null);
          }}
          onBlur={() => setTouched(true)}
        />
        {fieldError === null ? null : (
          <p id={`${INPUT_ID}-error`} role="alert" className="m-0 text-caption text-danger">
            {fieldError}
          </p>
        )}
        {failure === null ? null : <InlineError kind={failure.kind}>{failure.message}</InlineError>}
        <TestConnection run={test} resetKey={draft.trim()} />
      </SettingsRow>

      <SaveBar
        dirty={dirty}
        saving={saving}
        problems={fieldError === null ? 0 : 1}
        onSave={requestSave}
        onDiscard={() => {
          setDraft(saved);
          setTouched(false);
          setFailure(null);
        }}
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={text.changeConfirm.title}
        description={text.changeConfirm.description}
        confirmLabel={text.changeConfirm.confirm}
        onConfirm={() => void save()}
      />
    </SettingsSection>
  );
}
