import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  REASONING_EFFORTS,
  type CodexModelsResponse,
  type JsonValue,
  type ModelProviderConfigOrigin,
  type ModelProviderSettingsDto,
} from "@suduo/client-contracts";
import { AlertTriangleIcon, RotateCcwIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "../../../api/client.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { RegionError } from "../../../feedback/components/index.js";
import { reportFailure } from "../../../feedback/report.js";
import type { Failure } from "../../../feedback/types.js";
import { showMessage } from "../../../ui/message.js";
import { effortName, offeredEfforts } from "../../sessions/SessionModelSwitcher.js";
import { configWarningOf, useCodexStatus } from "../codex-status.js";
import { SaveBar, useUnsavedChanges } from "../components/frame.js";
import { rowDescId, rowLabelId, SectionSkeleton, SettingsRow, SettingsSection, StatusPill } from "../components/kit.js";
import { formatMs, TestConnection, timed, type TestOutcome } from "../components/TestConnection.js";
import { humanizeModelMessage } from "../format.js";
import { networkReason } from "./ProxySection.js";
import { codexModelsQuery, modelProviderQuery, settingsKeys } from "../queries.js";
import { useQueryFailure } from "../use-query-failure.js";
import type { ProxyConnectivityDto } from "@suduo/client-contracts";
import { currentLocale } from "../../../i18n/locale.js";
import { messagesFor, type Messages } from "../../../i18n/messages/index.js";
import { useT } from "../../../i18n/provider.js";

/** 拿不到模型声明的档位时（旧服务端 / 模型不在清单里）给的常见几档。 */
const FALLBACK_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/**
 * 默认推理强度的选项：按选中的模型（没选则按 Codex 的默认模型）在模型清单里声明的档位，
 * 例如 gpt-6-sol 是「快速」到「极致」、没有「最快」（「极致+」暂不提供，见 offeredEfforts）。
 * 已保存的值即使不在其中也保留，免得一打开就被改掉。
 */
export function effortOptions(models: CodexModelsResponse | undefined, model: string, current: string): string[] {
  const items = models?.items ?? [];
  const entry = model === "" ? items.find((item) => item.isDefault) : items.find((item) => item.id === model || item.model === model);
  const declared = entry !== undefined && entry.supportedReasoningEfforts.length > 0 ? entry.supportedReasoningEfforts : [...FALLBACK_EFFORTS];
  const rank = (effort: string) => {
    const index = (REASONING_EFFORTS as readonly string[]).indexOf(effort);
    return index === -1 ? REASONING_EFFORTS.length : index;
  };
  const ordered = offeredEfforts([...new Set(declared)]).sort((a, b) => rank(a) - rank(b));
  return current !== "" && !ordered.includes(current) ? [...ordered, current] : ordered;
}
const DEFAULT_MODEL = "__default__";

interface ModelDraft {
  baseUrl: string;
  apiKey: string;
  model: string;
  effort: string;
  contextWindow: string;
}

function draftOf(settings: ModelProviderSettingsDto): ModelDraft {
  return {
    baseUrl: settings.baseUrl,
    apiKey: "",
    model: settings.model ?? "",
    effort: settings.reasoningEffort ?? "",
    contextWindow: settings.contextWindow === null ? "" : String(settings.contextWindow),
  };
}

/** 上下文上限：留空表示不声明；否则必须是 4000 ~ 1 亿之间的整数（修复：非数字不再提交成 NaN）。 */
export function parseContextWindow(
  raw: string,
  t: Messages = messagesFor(currentLocale()),
): { ok: true; value: number | null } | { ok: false; message: string } {
  const text = t.settingsConnection.model.validation;
  const trimmed = raw.trim().replace(/[,_，\s]/g, "");
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: text.contextWindowInteger };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 4_000 || value > 100_000_000) {
    return { ok: false, message: text.contextWindowRange };
  }
  return { ok: true, value };
}

function validateDraft(draft: ModelDraft, saved: ModelDraft, firstTime: boolean, t: Messages): Partial<Record<keyof ModelDraft, string>> {
  const text = t.settingsConnection.model.validation;
  const errors: Partial<Record<keyof ModelDraft, string>> = {};
  if (firstTime && draft.baseUrl.trim() === "") {
    errors.baseUrl = text.baseUrlRequired;
  } else if (draft.baseUrl.trim() !== saved.baseUrl) {
    try {
      const url = new URL(draft.baseUrl.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") errors.baseUrl = text.baseUrlProtocol;
    } catch {
      errors.baseUrl = text.baseUrlInvalid;
    }
  }
  if (draft.apiKey !== "") {
    const key = draft.apiKey.trim();
    if (key.length < 8 || key.length > 512 || /[\r\n]/.test(key)) errors.apiKey = text.apiKeyIncomplete;
  } else if (firstTime) {
    // 改用团队的模型服务要带上它的 Key：不然 Codex 可能拿着原来的登录凭据去请求团队的地址。
    errors.apiKey = text.apiKeyRequired;
  }
  if (draft.model.trim() !== "" && !/^[A-Za-z0-9._:/-]{1,128}$/.test(draft.model.trim())) {
    errors.model = text.modelName;
  }
  const context = parseContextWindow(draft.contextWindow, t);
  if (!context.ok) errors.contextWindow = context.message;
  return errors;
}

/** Codex 配置层来源 → 人话；来自你自己的配置时不显示。 */
export function originLabel(origin: ModelProviderConfigOrigin | null, t: Messages = messagesFor(currentLocale())): string | null {
  if (origin === null) return null;
  const text = t.settingsConnection.model.origin;
  const raw: JsonValue = origin.name;
  const type =
    typeof raw === "string"
      ? raw
      : typeof raw === "object" && raw !== null && !Array.isArray(raw) && typeof raw["type"] === "string"
        ? raw["type"]
        : "";
  if (type === "" || type === "user") return null;
  if (type === "project") return text.project;
  if (type === "system") return text.system;
  if (type === "sessionFlags") return text.sessionFlags;
  if (/mdm|managed|enterprise/i.test(type)) return text.managed;
  return text.other;
}

function OriginNote({ origin }: { origin: ModelProviderConfigOrigin | null }) {
  const t = useT();
  const label = originLabel(origin, t);
  if (label === null) return null;
  const text = t.settingsConnection.model.origin;
  return (
    <Badge variant="warning" data-testid="model-origin-badge" title={text.badgeTitle(label)}>
      {text.badge(label)}
    </Badge>
  );
}

export function ModelSection() {
  const t = useT();
  const text = t.settingsConnection.model;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const provider = useQuery(modelProviderQuery);
  const models = useQuery(codexModelsQuery);
  const warning = configWarningOf(useCodexStatus());
  const failure = useQueryFailure(provider);

  if (provider.isPending) {
    return (
      <SettingsSection id="model" description={text.intro}>
        <SectionSkeleton rows={5} label={text.loading} />
      </SettingsSection>
    );
  }
  if (provider.isError) {
    return (
      <SettingsSection id="model" description={text.intro} badge={<StatusPill tone="danger">{text.loadFailedPill}</StatusPill>}>
        <RegionError
          kind={failure?.kind ?? "unknown"}
          message={text.loadFailed(failure?.message ?? "")}
          busy={provider.isFetching}
          onRetry={() => void provider.refetch()}
        />
      </SettingsSection>
    );
  }
  return (
    <ModelForm
      settings={provider.data}
      models={models}
      warning={warning}
      onSaved={(next) => {
        queryClient.setQueryData(settingsKeys.model, next);
        void queryClient.invalidateQueries({ queryKey: settingsKeys.codexModels });
      }}
      onOpenProxy={() => void navigate({ to: "/settings/$section", params: { section: "proxy" } })}
    />
  );
}

function ModelForm({
  settings,
  models,
  warning,
  onSaved,
  onOpenProxy,
}: {
  settings: ModelProviderSettingsDto;
  models: UseQueryResult<CodexModelsResponse>;
  warning: ReturnType<typeof configWarningOf>;
  onSaved(next: ModelProviderSettingsDto): void;
  onOpenProxy(): void;
}) {
  const t = useT();
  const text = t.settingsConnection.model;
  const queryClient = useQueryClient();
  const saved = draftOf(settings);
  const [draft, setDraft] = useState<ModelDraft>(saved);
  const [baseline, setBaseline] = useState(settings);
  const [replacingKey, setReplacingKey] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<Failure | null>(null);
  const [overridden, setOverridden] = useState<{ message: string; before: ModelProviderSettingsDto } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const fieldRefs = useRef<Partial<Record<keyof ModelDraft, HTMLInputElement | null>>>({});

  const dirty =
    draft.baseUrl.trim() !== saved.baseUrl ||
    draft.apiKey !== "" ||
    draft.model !== saved.model ||
    draft.effort !== saved.effort ||
    draft.contextWindow.trim() !== saved.contextWindow;

  // 没在编辑时跟随服务端的新值；正在编辑时不打断（以变化前的值判断有没有改过）。
  if (baseline !== settings) {
    const untouched = sameDraft(draft, draftOf(baseline));
    setBaseline(settings);
    if (untouched) setDraft(draftOf(settings));
  }

  useUnsavedChanges("model", dirty, text.groupName);

  // Codex 里还没有模型服务：这是第一次配置，保存时建立（地址必填）。
  const firstTime = settings.configured === false;
  // Key 由配置里的命令或环境变量提供：这里的「更换」写的是 Codex 登录，对这个服务不起作用，不给入口。
  const externalKey = settings.apiKeySource === "command" || settings.apiKeySource === "env";
  const errors = validateDraft(draft, saved, firstTime, t);
  const visibleErrors = attempted ? errors : pickTouched(errors, draft, saved);
  const problemCount = Object.keys(errors).length;
  const set = (field: keyof ModelDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setSaveFailure(null);
  };

  const discard = () => {
    setDraft(saved);
    setReplacingKey(false);
    setAttempted(false);
    setSaveFailure(null);
  };

  const save = async () => {
    setAttempted(true);
    const firstInvalid = (Object.keys(errors) as (keyof ModelDraft)[])[0];
    if (firstInvalid !== undefined) {
      // Key 输入框收起着时先展开（它自带聚焦）。
      if (firstInvalid === "apiKey" && !replacingKey) setReplacingKey(true);
      else fieldRefs.current[firstInvalid]?.focus();
      return;
    }
    const context = parseContextWindow(draft.contextWindow, t);
    if (!context.ok) return;
    setSaving(true);
    setSaveFailure(null);
    const before = settings;
    try {
      const result = await api.updateModelProvider({
        baseUrl: draft.baseUrl.trim(),
        ...(draft.apiKey === "" ? {} : { apiKey: draft.apiKey.trim() }),
        model: draft.model.trim(),
        // 推理强度只在改过时下发：已保存的值可能是 Codex 认得、但这里写不回去的档位。
        ...(draft.effort === "" || draft.effort === saved.effort ? {} : { reasoningEffort: draft.effort }),
        contextWindow: context.value,
      });
      setDraft(draftOf(result.settings));
      setReplacingKey(false);
      setAttempted(false);
      onSaved(result.settings);
      if (result.status === "okOverridden") {
        setOverridden({ message: result.message, before });
      } else {
        setOverridden(null);
        // 保存只写配置；顺手实际连一次地址，把结果告诉你（连不上也不撤销保存）。
        const network = result.settings.baseUrl === "" ? null : await api.testProxySettings({}).catch(() => null);
        if (network !== null && !network.reachable) {
          showMessage(text.save.savedUnreachable(networkReason(network, t)), "warning");
        } else {
          showMessage(text.save.saved, "success");
        }
      }
    } catch (cause) {
      const reported = reportFailure(cause, { surface: "region" });
      if (reported.route.outlet === "region") setSaveFailure(reported.failure);
    } finally {
      setSaving(false);
    }
  };

  const restore = async () => {
    if (overridden === null) return;
    const previous = overridden.before;
    setRestoring(true);
    try {
      const result = await api.updateModelProvider({
        baseUrl: previous.baseUrl,
        model: previous.model ?? "",
        ...(previous.reasoningEffort === null ? {} : { reasoningEffort: previous.reasoningEffort }),
        contextWindow: previous.contextWindow,
      });
      setDraft(draftOf(result.settings));
      onSaved(result.settings);
      setOverridden(null);
      showMessage(text.save.restored, "success");
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: text.save.restoreFailed });
    } finally {
      setRestoring(false);
    }
  };

  const configured = settings.baseUrl !== "" && settings.apiKeyMasked !== null;
  const pill = !configured ? (
    <StatusPill tone="danger">{text.status.notConfigured}</StatusPill>
  ) : warning !== null ? (
    <StatusPill tone="warning">{text.status.warning}</StatusPill>
  ) : models.isError ? (
    <StatusPill tone="danger">{text.status.unreachable}</StatusPill>
  ) : models.isSuccess ? (
    <StatusPill tone="success">{text.status.connected}</StatusPill>
  ) : (
    <StatusPill tone="neutral">{text.status.checking}</StatusPill>
  );

  const unreachable = (network: ProxyConnectivityDto): TestOutcome => ({
    ok: false,
    reason: text.test.unreachable(networkReason(network, t)),
    suggestion: text.test.unreachableSuggestion,
    action: { label: text.test.openProxy, onClick: onOpenProxy },
  });

  const test = async (): Promise<TestOutcome> => {
    try {
      // Codex 的模型清单可能来自它内置的目录、不经过网络，所以还要实际连一次服务地址，两样都通才算通。
      // 没有地址（用的是 Codex 内置的默认服务）时没有可实连的目标，只看清单。
      const probe = settings.baseUrl !== "";
      const { value, ms } = await timed(async () => ({
        models: await api.codexModels(),
        network: probe ? await api.testProxySettings({}).catch(() => null) : null,
      }));
      // 清单写回缓存：之前「连不上」的状态、横幅与导航提示点随之更新，不等缓存过期。
      queryClient.setQueryData(settingsKeys.codexModels, value.models);
      if (value.network !== null && !value.network.reachable) return unreachable(value.network);
      if (!probe) {
        return { ok: true, text: text.test.okBuiltin(value.models.models.length) };
      }
      return { ok: true, text: text.test.ok(value.models.models.length, formatMs(ms)) };
    } catch (cause) {
      const failure = classifyFailure(cause);
      // 再试一次网络：分清是「连不上」还是「连上了但被拒绝」，给对应的建议。
      const network = await api.testProxySettings({}).catch(() => null);
      if (network !== null && !network.reachable) return unreachable(network);
      return {
        ok: false,
        reason: text.test.noModels(failure.message),
        suggestion: text.test.noModelsSuggestion,
      };
    }
  };

  const modelItems: { id: string; displayName: string }[] | null =
    models.data === undefined
      ? null
      : (models.data.items?.map((item) => ({ id: item.id, displayName: item.displayName || item.id })) ??
        models.data.models.map((id) => ({ id, displayName: id })));
  const modelValue = draft.model === "" ? DEFAULT_MODEL : draft.model;

  return (
    <SettingsSection
      id="model"
      badge={pill}
      description={text.description}
    >
      {warning === null ? null : (
        <Banner tone="warning" title={text.banner.warningTitle} className="mb-2 items-start" data-testid="model-config-warning">
          {warning.summary ?? text.banner.warningFallback}
          {warning.details === null ? null : (
            <Collapsible>
              <CollapsibleTrigger className="mt-1 text-caption text-muted-foreground underline-offset-2 hover:underline">
                {text.banner.details}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="m-0 mt-1 max-h-40 overflow-auto rounded-sm bg-code-bg p-2 font-mono text-caption whitespace-pre-wrap text-muted-foreground">
                  {warning.details}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          )}
        </Banner>
      )}
      {firstTime ? (
        <Banner tone="info" title={text.banner.firstTimeTitle} className="mb-2" data-testid="model-first-time">
          {text.banner.firstTimeBody}
        </Banner>
      ) : models.isError ? (
        <Banner tone="warning" title={text.banner.degradedTitle} className="mb-2" data-testid="model-degraded-banner">
          {text.banner.degradedBody}
        </Banner>
      ) : null}
      {overridden === null ? null : (
        <Banner
          tone="warning"
          title={text.banner.overriddenTitle}
          className="mb-2"
          data-testid="model-save-result"
          data-status="okOverridden"
          actions={
            // 第一次改用团队服务时，保存前没有可还原的地址（用的是内置默认），不给还原按钮。
            overridden.before.configured === false ? undefined : (
              <Button size="sm" type="button" loading={restoring} onClick={() => void restore()} data-testid="model-restore">
                <RotateCcwIcon />
                {text.banner.restore}
              </Button>
            )
          }
        >
          {overridden.message}
        </Banner>
      )}
      {saveFailure === null ? null : (
        <Banner tone="danger" title={text.banner.saveFailedTitle} className="mb-2" data-testid="model-save-failure">
          {humanizeModelMessage(saveFailure.message)}
        </Banner>
      )}

      <SettingsRow
        anchor="model-url"
        title={text.baseUrl.label}
        htmlFor="model-base-url"
        description={text.baseUrl.description}
        status={<OriginNote origin={settings.origins.baseUrl} />}
      >
        <Input
          ref={(node) => {
            fieldRefs.current.baseUrl = node;
          }}
          id="model-base-url"
          data-testid="model-base-url"
          className="font-mono"
          placeholder="https://llm-gateway.example.com/v1"
          value={draft.baseUrl}
          aria-invalid={visibleErrors.baseUrl === undefined ? undefined : true}
          aria-describedby={describedBy("model-url", visibleErrors.baseUrl, "model-base-url")}
          onChange={(event) => set("baseUrl", event.target.value)}
        />
        <FieldError id="model-base-url" message={visibleErrors.baseUrl} />
      </SettingsRow>

      <SettingsRow
        anchor="api-key"
        title={text.apiKey.label}
        description={text.apiKey.description}
        {...(replacingKey ? { htmlFor: "model-api-key" } : {})}
      >
        {replacingKey ? (
          <div className="flex gap-2">
            <Input
              ref={(node) => {
                fieldRefs.current.apiKey = node;
              }}
              id="model-api-key"
              type="password"
              autoComplete="off"
              autoFocus
              data-testid="model-api-key-input"
              className="font-mono"
              placeholder={text.apiKey.placeholder}
              value={draft.apiKey}
              aria-invalid={visibleErrors.apiKey === undefined ? undefined : true}
              aria-describedby={describedBy("api-key", visibleErrors.apiKey, "model-api-key")}
              onChange={(event) => set("apiKey", event.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setReplacingKey(false);
                set("apiKey", "");
              }}
            >
              {text.apiKey.cancelReplace}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span
              className="flex h-(--ctl-h) min-w-0 flex-1 items-center truncate rounded-sm bg-muted px-2.5 font-mono text-small text-muted-foreground"
              data-testid="model-api-key-masked"
              aria-labelledby={rowLabelId("api-key")}
            >
              {settings.apiKeyMasked ?? text.apiKey.notConfigured}
            </span>
            {externalKey ? null : (
              <Button type="button" onClick={() => setReplacingKey(true)}>
                {settings.apiKeyMasked === null ? text.apiKey.add : text.apiKey.replace}
              </Button>
            )}
          </div>
        )}
        {externalKey ? (
          <p className="m-0 text-caption text-muted-foreground" data-testid="model-api-key-external">
            {settings.apiKeySource === "command" ? text.apiKey.fromCommand : text.apiKey.fromEnv}
          </p>
        ) : null}
        <FieldError id="model-api-key" message={visibleErrors.apiKey} />
        {replacingKey && settings.apiKeyMasked !== null ? (
          <p className="m-0 text-caption text-muted-foreground" data-testid="model-api-key-replace-note">
            {text.apiKey.replaceNote}
          </p>
        ) : null}
      </SettingsRow>

      <SettingsRow
        anchor="model-name"
        title={text.defaultModel.label}
        description={text.defaultModel.description}
        htmlFor="model-name"
        status={<OriginNote origin={settings.origins.model} />}
      >
        {modelItems === null ? (
          <>
            <Input
              ref={(node) => {
                fieldRefs.current.model = node;
              }}
              id="model-name"
              data-testid="model-name"
              className="font-mono"
              placeholder={models.isPending ? text.defaultModel.loadingPlaceholder : text.defaultModel.unavailablePlaceholder}
              value={draft.model}
              aria-invalid={visibleErrors.model === undefined ? undefined : true}
              onChange={(event) => set("model", event.target.value)}
            />
            <FieldError id="model-name" message={visibleErrors.model} />
          </>
        ) : (
          <Select value={modelValue} onValueChange={(value) => set("model", value === DEFAULT_MODEL ? "" : value)}>
            <SelectTrigger id="model-name" data-testid="model-name" aria-describedby={rowDescId("model-name")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_MODEL}>{text.defaultModel.followCodex}</SelectItem>
              {draft.model !== "" && !modelItems.some((item) => item.id === draft.model) ? (
                <SelectItem value={draft.model}>{draft.model}</SelectItem>
              ) : null}
              {modelItems.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </SettingsRow>

      <SettingsRow
        anchor="reasoning"
        title={text.effort.label}
        description={saved.effort === "" ? text.effort.descriptionUnset : text.effort.description}
        status={<OriginNote origin={settings.origins.reasoningEffort} />}
      >
        <div className="overflow-x-auto">
          <SegmentedControl
            aria-labelledby={rowLabelId("reasoning")}
            data-testid="model-effort"
            value={draft.effort}
            options={effortOptions(models.data, draft.model.trim(), draft.effort).map((effort) => ({ value: effort, label: effortName(effort) }))}
            onValueChange={(value) => set("effort", value)}
          />
        </div>
      </SettingsRow>

      <SettingsRow
        anchor="context-window"
        title={text.contextWindow.label}
        htmlFor="model-context"
        description={text.contextWindow.description}
        status={<OriginNote origin={settings.origins.contextWindow} />}
      >
        <Input
          ref={(node) => {
            fieldRefs.current.contextWindow = node;
          }}
          id="model-context"
          data-testid="model-context"
          inputMode="numeric"
          className="max-w-60 font-mono"
          placeholder={text.contextWindow.placeholder}
          value={draft.contextWindow}
          aria-invalid={visibleErrors.contextWindow === undefined ? undefined : true}
          aria-describedby={describedBy("context-window", visibleErrors.contextWindow, "model-context")}
          onChange={(event) => set("contextWindow", event.target.value)}
        />
        <FieldError id="model-context" message={visibleErrors.contextWindow} />
      </SettingsRow>

      <SettingsRow anchor="model-test" title={text.test.label} description={text.test.description}>
        <TestConnection
          run={test}
          {...(dirty ? { disabledReason: text.test.dirty } : {})}
        />
      </SettingsRow>

      <SaveBar dirty={dirty} saving={saving} problems={attempted ? problemCount : 0} onSave={() => void save()} onDiscard={discard} />
    </SettingsSection>
  );
}

function sameDraft(left: ModelDraft, right: ModelDraft): boolean {
  return (Object.keys(left) as (keyof ModelDraft)[]).every((field) => left[field] === right[field]);
}

/** 未点保存前，只提示用户改过的字段，不在一打开就满屏红字。 */
function pickTouched(
  errors: Partial<Record<keyof ModelDraft, string>>,
  draft: ModelDraft,
  saved: ModelDraft,
): Partial<Record<keyof ModelDraft, string>> {
  const result: Partial<Record<keyof ModelDraft, string>> = {};
  for (const field of Object.keys(errors) as (keyof ModelDraft)[]) {
    const changed = field === "apiKey" ? draft.apiKey !== "" : draft[field].trim() !== saved[field];
    if (changed && errors[field] !== undefined) result[field] = errors[field];
  }
  return result;
}

function describedBy(anchor: string, error: string | undefined, inputId: string): string {
  return error === undefined ? rowDescId(anchor) : `${rowDescId(anchor)} ${inputId}-error`;
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p id={`${id}-error`} role="alert" className="m-0 flex items-center gap-1 text-caption text-danger">
      <AlertTriangleIcon aria-hidden="true" className="size-3.5" />
      {message}
    </p>
  );
}
