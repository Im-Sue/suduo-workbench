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
import { SaveBar, useUnsavedChanges } from "../components/frame.js";
import { rowDescId, SettingsRow, SettingsSection, StatusPill } from "../components/kit.js";
import { formatMs, TestConnection, timed, type TestOutcome } from "../components/TestConnection.js";

const INPUT_ID = "settings-base-url";

export function validateServiceUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "请填写服务地址";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "地址要以 http:// 或 https:// 开头";
  } catch {
    return "这不是一个有效的地址，例如 http://192.168.1.10:4100";
  }
  return null;
}

/** 需求服务：团队共享需求所在的地址。改地址会退出当前登录，所以保存前先确认。 */
export function ServiceSection() {
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
  const fieldError = touched || dirty ? validateServiceUrl(draft) : null;

  // 没在编辑时跟随服务端的值；正在编辑时不打断（只在服务端值变化时同步）。
  const lastSaved = useRef(saved);
  useEffect(() => {
    if (lastSaved.current === saved) return;
    setDraft((current) => (current.trim() === lastSaved.current ? saved : current));
    lastSaved.current = saved;
  }, [saved]);

  useUnsavedChanges("service", dirty, "需求服务地址");

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
    if (validateServiceUrl(draft) !== null) {
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
    const problem = validateServiceUrl(draft);
    if (problem !== null) return { ok: false, reason: problem };
    try {
      const { ms } = await timed(() => api.testRequirementsSettings(draft.trim()));
      return { ok: true, text: `连接正常 · ${formatMs(ms)}` };
    } catch (cause) {
      const failure = classifyFailure(cause);
      return {
        ok: false,
        reason: failure.kind === "validation" ? failure.message : "连不上这个地址。",
        suggestion: "检查地址和端口是否正确，或确认电脑已连上公司内网；地址可以向团队管理员要。",
      };
    }
  };

  return (
    <SettingsSection
      id="service"
      description="团队共享的需求都在这里。换地址会退出当前登录。"
      badge={settings?.configured === true ? <StatusPill tone="success">已配置</StatusPill> : <StatusPill tone="danger">未配置</StatusPill>}
    >
      <SettingsRow anchor="service-url" title="服务地址" htmlFor={INPUT_ID} description="向团队管理员获取。">
        <Input
          ref={inputRef}
          id={INPUT_ID}
          data-testid="settings-base-url"
          className="font-mono"
          placeholder="例如 http://192.168.1.10:4100"
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
        title="更换需求服务地址？"
        description="保存后会退出当前登录，需要用新服务上的账号重新登录。"
        confirmLabel="保存并重新登录"
        onConfirm={() => void save()}
      />
    </SettingsSection>
  );
}
