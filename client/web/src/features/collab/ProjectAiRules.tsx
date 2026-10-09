import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PROJECT_AI_RULES_MAX_BYTES } from "@suduo/cloud-contracts";
import { HistoryIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client.js";
import { reportFailure } from "../../feedback/report.js";
import { useT } from "../../i18n/provider.js";
import { formatRelativeTime } from "../../ui/format.js";
import { showMessage } from "../../ui/message.js";
import { useCloudFeature } from "../requirements/cloud-features.js";
import { requirementKeys } from "../requirements/keys.js";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

const encoder = new TextEncoder();

/**
 * 项目 AI 规范（多 Agent 协作 S11，需求 4.8）：项目成员都能编辑，保存即新版本。编辑期间有人存过时照常保存
 * （后写入的成为当前版本，不拒绝，ADR-0004），保存后说明这期间谁存过哪些版本，历史版本的内容可以取回再用。
 * 团队服务器不支持（没有 ai_collab_v1）时不显示。
 */
export function ProjectAiRulesSetting({ projectId }: { projectId: string }) {
  const enabled = useCloudFeature("ai_collab_v1");
  const t = useT();
  const text = t.collab.share.rules;
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: requirementKeys.aiRules(projectId), queryFn: () => api.getProjectAiRules(projectId), enabled });
  const versions = useQuery({
    queryKey: [...requirementKeys.aiRules(projectId), "versions"],
    queryFn: () => api.listProjectAiRulesVersions(projectId),
    enabled: enabled && rules.data !== undefined && rules.data.version > 0,
  });
  const [content, setContent] = useState<string | null>(null);
  /** 开始编辑时看到的版本：保存时带上，回包说明这期间别人存过哪些版本。 */
  const base = useRef<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  useEffect(() => {
    if (rules.data !== undefined && content === null) base.current = rules.data.version;
  }, [rules.data, content]);
  if (!enabled) return null;
  const value = content ?? rules.data?.content ?? "";
  const bytes = encoder.encode(value).length;
  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.saveProjectAiRules(projectId, value, base.current ?? undefined);
      if (saved.version === (rules.data?.version ?? 0) && saved.skippedVersions.length === 0) showMessage(text.unchanged, "info");
      else showMessage(text.saved(saved.version), "success");
      if (saved.skippedVersions.length > 0) showMessage(text.skipped(saved.skippedVersions.map((entry) => ({ version: entry.version, name: entry.updatedBy.displayName }))), "warning");
      setContent(null);
      base.current = saved.version;
      await queryClient.invalidateQueries({ queryKey: requirementKeys.aiRules(projectId) });
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: text.saveFailed });
    } finally {
      setSaving(false);
    }
  };
  const loadVersion = async (version: number) => {
    try {
      const detail = await api.getProjectAiRulesVersion(projectId, version);
      setContent(detail.content);
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: text.loadFailed });
    }
  };
  const current = rules.data;
  return (
    <>
      <Separator />
      <section className="flex flex-col gap-2" data-testid="project-ai-rules">
        <div className="flex flex-col gap-0.5">
          <h3 className="m-0 text-small font-semibold">{text.title}</h3>
          <p className="m-0 text-caption text-muted-foreground">{text.description}</p>
          <p className="m-0 text-caption text-subtle-foreground" data-testid="project-ai-rules-version">
            {current === undefined
              ? ""
              : current.version === 0 || current.updatedBy === null || current.updatedAt === null
                ? text.never
                : text.version(current.version, current.updatedBy.displayName, formatRelativeTime(current.updatedAt))}
          </p>
        </div>
        {rules.isError ? <p className="m-0 text-caption text-danger">{text.loadFailed}</p> : null}
        <Textarea
          rows={6}
          value={value}
          placeholder={text.placeholder}
          disabled={rules.isPending}
          onChange={(event) => setContent(event.target.value)}
          className="font-mono text-caption"
          data-testid="project-ai-rules-content"
        />
        <div className="flex items-center gap-2">
          <span className={bytes > PROJECT_AI_RULES_MAX_BYTES ? "text-caption text-danger" : "text-caption text-subtle-foreground"}>
            {bytes > PROJECT_AI_RULES_MAX_BYTES ? text.tooLarge : text.size(bytes, PROJECT_AI_RULES_MAX_BYTES)}
          </span>
          <span className="flex-1" />
          {current !== undefined && current.version > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setShowHistory((open) => !open)} data-testid="project-ai-rules-history">
              <HistoryIcon />
              {text.history}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            loading={saving}
            disabled={content === null || bytes > PROJECT_AI_RULES_MAX_BYTES}
            onClick={() => void save()}
            data-testid="project-ai-rules-save"
          >
            {text.save}
          </Button>
        </div>
        {showHistory && versions.data !== undefined ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {versions.data.items.map((entry) => (
              <li key={entry.version} className="flex items-center gap-2 text-caption text-muted-foreground">
                <span className="min-w-0 flex-1 truncate">{text.version(entry.version, entry.updatedBy.displayName, formatRelativeTime(entry.updatedAt))}</span>
                <Button size="sm" variant="ghost" onClick={() => void loadVersion(entry.version)}>
                  {text.useVersion}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}
