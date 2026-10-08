import type {
  CodexModelOptionDto,
  ModelProviderSettingsDto,
  SessionDto,
} from "@suduo/client-contracts";
import { REASONING_EFFORTS } from "@suduo/client-contracts";
import { ChevronDownIcon, CpuIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client.js";
import { currentLocale } from "../../i18n/locale.js";
import { messagesFor, type Messages } from "../../i18n/messages/index.js";
import { useT } from "../../i18n/provider.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";

/**
 * 会话级模型与推理强度（需求 §4.5：输入框底栏「模型与推理强度（本会话）」）。
 * 只改这个会话，下个回合生效；「跟随默认」回到设置页里的全局默认。
 * 推理强度只列所选模型声明支持的档位（model/list 的 supportedReasoningEfforts）。
 */
/** 推理强度档位的显示名（需求 §5.1：不显示档位原值）；不认识的档位显示原值。 */
export function effortName(value: string, t: Messages = messagesFor(currentLocale())): string {
  const names: Readonly<Record<string, string>> = t.sessions.effort;
  return Object.hasOwn(names, value) ? (names[value] ?? value) : value;
}

/** gpt-5.6-sol → 5.6 Sol；空值显示「默认模型」。 */
export function prettifyModel(id: string | null, t: Messages = messagesFor(currentLocale())): string {
  if (id === null || id === "") return t.conversation.model.defaultModel;
  const pretty = id
    .replace(/^(gpt|openai)[-_]/i, "")
    .split(/[-_]/)
    .filter((part) => part !== "")
    .map((part) => (/^[a-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
  return pretty === "" ? id : pretty;
}

const FOLLOW = "__follow_default__";

/**
 * 先不提供的档位：ultra（「极致+」）会让模型自动把任务分派给子代理，而子代理线程的审批与事件
 * SuDuo 还挂不回父会话（审批会没人处理、回合卡住）。实测支持之前不在选项里给出；已保存的值照样保留。
 */
const WITHHELD_EFFORTS = new Set(["ultra"]);

export function offeredEfforts(declared: readonly string[]): string[] {
  return declared.filter((effort) => !WITHHELD_EFFORTS.has(effort));
}

export function effortLabel(value: string | null, t: Messages = messagesFor(currentLocale())): string {
  if (value === null) return t.conversation.model.defaultEffort;
  return effortName(value, t);
}

export function SessionModelSwitcher({
  session,
  provider,
  onChanged,
  onOpenSettings,
  onError,
}: {
  session: SessionDto;
  /** 全局默认（设置页里的 Codex 配置），用于说明「跟随默认」是什么。 */
  provider: ModelProviderSettingsDto | null;
  onChanged(next: SessionDto): void;
  onOpenSettings(): void;
  onError(cause: unknown): void;
}) {
  const t = useT();
  const text = t.conversation.model;
  const [items, setItems] = useState<CodexModelOptionDto[] | null>(null);
  const [saving, setSaving] = useState(false);

  const load = (open: boolean) => {
    if (!open || items !== null) return;
    // Codex 用 model/list；其他 Agent 按自己的选项（多 Agent S5）。
    void (session.agentId === "codex" ? api.codexModels() : api.agentModels(session.agentId))
      .then((result) =>
        setItems(
          result.items ??
            result.models.map((id) => ({
              id,
              model: id,
              displayName: prettifyModel(id, t),
              isDefault: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: null,
            })),
        ),
      )
      .catch(() => setItems([]));
  };

  const apply = async (patch: { model?: string | null; reasoningEffort?: string | null }) => {
    setSaving(true);
    try {
      onChanged(await api.updateSession(session.id, patch));
    } catch (cause) {
      onError(cause);
    } finally {
      setSaving(false);
    }
  };

  // 旧服务端的会话没有这两个字段：按「跟随默认」处理。
  const sessionModel = session.model ?? null;
  const sessionEffort = session.reasoningEffort ?? null;
  // 设置页里的全局默认只对 Codex 有意义；其他 Agent 的「默认」由它自己决定。
  const defaultModel = (session.agentId === "codex" ? provider?.model : null) ?? items?.find((item) => item.isDefault)?.model ?? null;
  const effectiveModel = sessionModel ?? defaultModel;
  const selected = items?.find((item) => item.model === effectiveModel || item.id === effectiveModel);
  const efforts = offeredEfforts(
    selected !== undefined && selected.supportedReasoningEfforts.length > 0
      ? selected.supportedReasoningEfforts
      : REASONING_EFFORTS.filter((value) => value !== "none" && value !== "max"),
  );
  const modelOptions = items ?? [];

  return (
    <DropdownMenu modal={false} onOpenChange={load}>
      {/* 输入框底栏放不下时模型名截断（推理强度与图标保持完整），完整内容在菜单里。 */}
      <DropdownMenuTrigger
        className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-sm px-2 text-small text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-[state=open]:bg-muted [&>svg]:shrink-0"
        data-testid="model-chip"
        disabled={saving}
        title={text.chipTitle}
      >
        {saving ? <Spinner size="sm" /> : <CpuIcon className="size-3.5" aria-hidden="true" />}
        <span className="truncate">
          {sessionModel === null ? (defaultModel === null ? text.defaultModel : prettifyModel(defaultModel, t)) : prettifyModel(sessionModel, t)}
        </span>
        {sessionEffort !== null ? <span className="shrink-0 whitespace-nowrap text-subtle-foreground">{effortLabel(sessionEffort, t)}</span> : null}
        <ChevronDownIcon className="size-3 opacity-70" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-64" data-testid="model-menu">
        <DropdownMenuLabel>{text.menuLabel}</DropdownMenuLabel>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span>{text.model}</span>
            <span className="ml-auto pl-6 text-caption text-muted-foreground">
              {sessionModel === null ? text.followDefault : prettifyModel(sessionModel, t)}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">
            <DropdownMenuRadioGroup
              value={sessionModel ?? FOLLOW}
              onValueChange={(value) => {
                const model = value === FOLLOW ? null : value;
                // 换了模型而当前指定的推理强度它不支持：一起改回跟随默认，免得下一轮带着不支持的档位失败。
                const target = items?.find((item) => item.model === (model ?? defaultModel));
                const unsupported =
                  sessionEffort !== null &&
                  target !== undefined &&
                  target.supportedReasoningEfforts.length > 0 &&
                  !target.supportedReasoningEfforts.includes(sessionEffort);
                void apply(unsupported ? { model, reasoningEffort: null } : { model });
              }}
            >
              <DropdownMenuRadioItem value={FOLLOW} disabled={saving}>
                {text.followDefault}
                <span className="ml-auto pl-4 text-caption text-muted-foreground">{defaultModel === null ? "" : prettifyModel(defaultModel, t)}</span>
              </DropdownMenuRadioItem>
              {items === null ? <div className="px-2 py-1.5 text-caption text-subtle-foreground">{text.loading}</div> : null}
              {items !== null && modelOptions.length === 0 ? (
                <div className="px-2 py-1.5 text-caption text-subtle-foreground">{text.loadFailed}</div>
              ) : null}
              {modelOptions.map((item) => (
                <DropdownMenuRadioItem key={item.id} value={item.model} disabled={saving}>
                  <span className="truncate">{item.displayName || prettifyModel(item.model, t)}</span>
                  {item.isDefault ? <span className="ml-auto pl-3 text-caption text-muted-foreground">{text.isDefault}</span> : null}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span>{text.effort}</span>
            <span className="ml-auto pl-6 text-caption text-muted-foreground">
              {sessionEffort === null ? text.followDefault : effortLabel(sessionEffort, t)}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            <DropdownMenuRadioGroup
              value={sessionEffort ?? FOLLOW}
              onValueChange={(value) => void apply({ reasoningEffort: value === FOLLOW ? null : value })}
            >
              <DropdownMenuRadioItem value={FOLLOW} disabled={saving}>
                {text.followDefault}
                <span className="ml-auto pl-4 text-caption text-muted-foreground">
                  {provider?.reasoningEffort ? effortLabel(provider.reasoningEffort, t) : ""}
                </span>
              </DropdownMenuRadioItem>
              {efforts.map((value) => (
                <DropdownMenuRadioItem key={value} value={value} disabled={saving}>
                  {effortLabel(value, t)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenSettings}>
          <Settings2Icon />
          {text.openSettings}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
