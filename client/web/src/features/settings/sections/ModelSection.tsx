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
import { EFFORT_LABEL, offeredEfforts } from "../../sessions/SessionModelSwitcher.js";
import { configWarningOf, useCodexStatus } from "../codex-status.js";
import { SaveBar, useUnsavedChanges } from "../components/frame.js";
import { rowDescId, rowLabelId, SectionSkeleton, SettingsRow, SettingsSection, StatusPill } from "../components/kit.js";
import { formatMs, TestConnection, timed, type TestOutcome } from "../components/TestConnection.js";
import { humanizeModelMessage } from "../format.js";
import { networkReason } from "./ProxySection.js";
import { codexModelsQuery, modelProviderQuery, settingsKeys } from "../queries.js";
import { useQueryFailure } from "../use-query-failure.js";

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
export function parseContextWindow(raw: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const trimmed = raw.trim().replace(/[,_，\s]/g, "");
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: "请输入整数，例如 200000" };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 4_000 || value > 100_000_000) {
    return { ok: false, message: "请输入 4000 到 100000000 之间的整数" };
  }
  return { ok: true, value };
}

function validateDraft(draft: ModelDraft, saved: ModelDraft, firstTime = false): Partial<Record<keyof ModelDraft, string>> {
  const errors: Partial<Record<keyof ModelDraft, string>> = {};
  if (firstTime && draft.baseUrl.trim() === "") {
    errors.baseUrl = "先填写模型服务地址，例如 https://llm-gateway.example.com/v1";
  } else if (draft.baseUrl.trim() !== saved.baseUrl) {
    try {
      const url = new URL(draft.baseUrl.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") errors.baseUrl = "地址要以 http:// 或 https:// 开头";
    } catch {
      errors.baseUrl = "这不是一个有效的地址，例如 https://llm-gateway.example.com/v1";
    }
  }
  if (draft.apiKey !== "") {
    const key = draft.apiKey.trim();
    if (key.length < 8 || key.length > 512 || /[\r\n]/.test(key)) errors.apiKey = "API Key 看起来不完整，请整段粘贴";
  } else if (firstTime) {
    // 改用团队的模型服务要带上它的 Key：不然 Codex 可能拿着原来的登录凭据去请求团队的地址。
    errors.apiKey = "改用团队的模型服务需要填写它的 API Key";
  }
  if (draft.model.trim() !== "" && !/^[A-Za-z0-9._:/-]{1,128}$/.test(draft.model.trim())) {
    errors.model = "模型名称只能包含字母、数字和 . _ : / -";
  }
  const context = parseContextWindow(draft.contextWindow);
  if (!context.ok) errors.contextWindow = context.message;
  return errors;
}

/** Codex 配置层来源 → 人话；来自你自己的配置时不显示。 */
export function originLabel(origin: ModelProviderConfigOrigin | null): string | null {
  if (origin === null) return null;
  const raw: JsonValue = origin.name;
  const type =
    typeof raw === "string"
      ? raw
      : typeof raw === "object" && raw !== null && !Array.isArray(raw) && typeof raw["type"] === "string"
        ? raw["type"]
        : "";
  if (type === "" || type === "user") return null;
  if (type === "project") return "项目配置";
  if (type === "system") return "系统配置";
  if (type === "sessionFlags") return "启动参数";
  if (/mdm|managed|enterprise/i.test(type)) return "管理员配置";
  return "其他配置";
}

function OriginNote({ origin }: { origin: ModelProviderConfigOrigin | null }) {
  const label = originLabel(origin);
  if (label === null) return null;
  return (
    <Badge variant="warning" data-testid="model-origin-badge" title={`当前生效的值来自${label}，在这里修改可能不会生效`}>
      来自{label}
    </Badge>
  );
}

export function ModelSection() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const provider = useQuery(modelProviderQuery);
  const models = useQuery(codexModelsQuery);
  const warning = configWarningOf(useCodexStatus());
  const failure = useQueryFailure(provider);

  if (provider.isPending) {
    return (
      <SettingsSection id="model" description="Codex 通过这里调用模型。">
        <SectionSkeleton rows={5} label="正在读取模型服务配置" />
      </SettingsSection>
    );
  }
  if (provider.isError) {
    return (
      <SettingsSection id="model" description="Codex 通过这里调用模型。" badge={<StatusPill tone="danger">读不到配置</StatusPill>}>
        <RegionError
          kind={failure?.kind ?? "unknown"}
          message={`暂时读不到 Codex 的模型配置：${failure?.message ?? ""}`}
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

  useUnsavedChanges("model", dirty, "模型服务");

  // Codex 里还没有模型服务：这是第一次配置，保存时建立（地址必填）。
  const firstTime = settings.configured === false;
  // Key 由配置里的命令或环境变量提供：这里的「更换」写的是 Codex 登录，对这个服务不起作用，不给入口。
  const externalKey = settings.apiKeySource === "command" || settings.apiKeySource === "env";
  const errors = validateDraft(draft, saved, firstTime);
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
    const context = parseContextWindow(draft.contextWindow);
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
          showMessage(`模型服务已保存，但现在连不上这个地址：${networkReason(network.message)}。检查地址或网络代理后点「测试连接」再试。`, "warning");
        } else {
          showMessage("模型服务已保存，下一个回合开始生效。", "success");
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
      showMessage("已还原到保存前的配置", "success");
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: "没能还原" });
    } finally {
      setRestoring(false);
    }
  };

  const configured = settings.baseUrl !== "" && settings.apiKeyMasked !== null;
  const pill = !configured ? (
    <StatusPill tone="danger">未配置</StatusPill>
  ) : warning !== null ? (
    <StatusPill tone="warning">有提醒</StatusPill>
  ) : models.isError ? (
    <StatusPill tone="danger">连不上</StatusPill>
  ) : models.isSuccess ? (
    <StatusPill tone="success">已连接</StatusPill>
  ) : (
    <StatusPill tone="neutral">检查中</StatusPill>
  );

  const unreachable = (message: string): TestOutcome => ({
    ok: false,
    reason: `连不上模型服务：${networkReason(message)}`,
    suggestion: "检查服务地址是否正确；公司网络需要代理时，在「网络代理」里配置。",
    action: { label: "去设置网络代理", onClick: onOpenProxy },
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
      if (value.network !== null && !value.network.reachable) return unreachable(value.network.message);
      if (!probe) {
        return { ok: true, text: `Codex 能读取模型清单 · ${value.models.models.length} 个 · 用的是内置默认服务，没有地址可实连` };
      }
      return { ok: true, text: `连接正常 · 可用模型 ${value.models.models.length} 个 · ${formatMs(ms)}` };
    } catch (cause) {
      const failure = classifyFailure(cause);
      // 再试一次网络：分清是「连不上」还是「连上了但被拒绝」，给对应的建议。
      const network = await api.testProxySettings({}).catch(() => null);
      if (network !== null && !network.reachable) return unreachable(network.message);
      return {
        ok: false,
        reason: `模型服务没有返回可用的模型：${failure.message}`,
        suggestion: "确认 API Key 有效、没有过期；也可以在「诊断」里查看更多信息。",
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
      description="Codex 通过这里调用模型。API Key 只保存在这台电脑上。保存后从下一个回合开始生效。"
    >
      {warning === null ? null : (
        <Banner tone="warning" title="Codex 对当前配置有提醒" className="mb-2 items-start" data-testid="model-config-warning">
          {warning.summary ?? "配置中有 Codex 不认识的项，模型服务可能按默认方式运行。"}
          {warning.details === null ? null : (
            <Collapsible>
              <CollapsibleTrigger className="mt-1 text-caption text-muted-foreground underline-offset-2 hover:underline">
                查看详情
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
        <Banner tone="info" title="目前用的是 Codex 内置的默认模型服务" className="mb-2" data-testid="model-first-time">
          要改用团队的模型服务：填写它的地址和 API Key 后保存。保存只写入配置，之后会实际连一次地址告诉你结果；随时可以点「测试连接」再确认。
        </Banner>
      ) : models.isError ? (
        <Banner tone="warning" title="暂时取不到 Codex 的模型清单" className="mb-2" data-testid="model-degraded-banner">
          下面是已保存的配置，可以照常修改。
        </Banner>
      ) : null}
      {overridden === null ? null : (
        <Banner
          tone="warning"
          title="已保存，但没有生效"
          className="mb-2"
          data-testid="model-save-result"
          data-status="okOverridden"
          actions={
            // 第一次改用团队服务时，保存前没有可还原的地址（用的是内置默认），不给还原按钮。
            overridden.before.configured === false ? undefined : (
              <Button size="sm" type="button" loading={restoring} onClick={() => void restore()} data-testid="model-restore">
                <RotateCcwIcon />
                还原到保存前
              </Button>
            )
          }
        >
          {overridden.message}
        </Banner>
      )}
      {saveFailure === null ? null : (
        <Banner tone="danger" title="没能保存" className="mb-2" data-testid="model-save-failure">
          {humanizeModelMessage(saveFailure.message)}
        </Banner>
      )}

      <SettingsRow
        anchor="model-url"
        title="服务地址"
        htmlFor="model-base-url"
        description="兼容 OpenAI 接口的地址。"
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
        title="API Key"
        description="为安全起见不显示完整内容；保存后替换旧的。"
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
              placeholder="粘贴新的 API Key"
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
              取消更换
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span
              className="flex h-(--ctl-h) min-w-0 flex-1 items-center truncate rounded-sm bg-muted px-2.5 font-mono text-small text-muted-foreground"
              data-testid="model-api-key-masked"
              aria-labelledby={rowLabelId("api-key")}
            >
              {settings.apiKeyMasked ?? "未配置"}
            </span>
            {externalKey ? null : (
              <Button type="button" onClick={() => setReplacingKey(true)}>
                {settings.apiKeyMasked === null ? "填写" : "更换"}
              </Button>
            )}
          </div>
        )}
        {externalKey ? (
          <p className="m-0 text-caption text-muted-foreground" data-testid="model-api-key-external">
            {settings.apiKeySource === "command"
              ? "Key 由 Codex 配置里的取 Key 命令提供（例如从钥匙串读取），不经过这里；要换 Key，改那条命令读取的内容。"
              : "Key 从 Codex 配置指定的环境变量读取，不经过这里；要换 Key，改启动 SuDuo 时的这个环境变量。"}
          </p>
        ) : null}
        <FieldError id="model-api-key" message={visibleErrors.apiKey} />
        {replacingKey && settings.apiKeyMasked !== null ? (
          <p className="m-0 text-caption text-muted-foreground" data-testid="model-api-key-replace-note">
            保存后会用这个 Key 替换 Codex 当前的登录（包括用 ChatGPT 账号的登录）。
          </p>
        ) : null}
      </SettingsRow>

      <SettingsRow
        anchor="model-name"
        title="默认模型"
        description="新会话默认使用的模型，每个会话都可以单独切换。"
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
              placeholder={models.isPending ? "正在读取可用模型…" : "读不到模型清单，可以直接填写模型名称"}
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
              <SelectItem value={DEFAULT_MODEL}>跟随 Codex 默认</SelectItem>
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
        title="默认推理强度"
        description={saved.effort === "" ? "未设置时由 Codex 决定。每个会话都可以单独调整。" : "每个会话都可以单独调整。"}
        status={<OriginNote origin={settings.origins.reasoningEffort} />}
      >
        <div className="overflow-x-auto">
          <SegmentedControl
            aria-labelledby={rowLabelId("reasoning")}
            data-testid="model-effort"
            value={draft.effort}
            options={effortOptions(models.data, draft.model.trim(), draft.effort).map((effort) => ({ value: effort, label: EFFORT_LABEL[effort] ?? effort }))}
            onValueChange={(value) => set("effort", value)}
          />
        </div>
      </SettingsRow>

      <SettingsRow
        anchor="context-window"
        title="上下文上限"
        htmlFor="model-context"
        description="单位是 token。留空时用 Codex 对该模型的已知上限（它不认识的模型按约 27 万估算）；填写只能调小，模型实际上限更小时在这里填实际值。"
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
          placeholder="例如 200000"
          value={draft.contextWindow}
          aria-invalid={visibleErrors.contextWindow === undefined ? undefined : true}
          aria-describedby={describedBy("context-window", visibleErrors.contextWindow, "model-context")}
          onChange={(event) => set("contextWindow", event.target.value)}
        />
        <FieldError id="model-context" message={visibleErrors.contextWindow} />
      </SettingsRow>

      <SettingsRow anchor="model-test" title="连接测试" description="用已保存的配置试一次：Codex 能不能读到模型清单、服务地址连不连得上。">
        <TestConnection
          run={test}
          {...(dirty ? { disabledReason: "有未保存的更改：先保存，再测试" } : {})}
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
