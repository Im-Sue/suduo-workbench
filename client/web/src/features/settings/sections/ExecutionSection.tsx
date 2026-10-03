import { useQuery } from "@tanstack/react-query";
import type { ApprovalMode } from "@suduo/client-contracts";
import { LockKeyholeIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { RadioCard, RadioGroup } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog, RegionError } from "../../../feedback/components/index.js";
import { needsConfirm } from "../../../feedback/confirm-policy.js";
import { useT } from "../../../i18n/provider.js";
import {
  LockNote,
  rowDescId,
  rowLabelId,
  SaveStatus,
  SectionSkeleton,
  SettingsRow,
  SettingsSection,
  useSaveIndicator,
} from "../components/kit.js";
import { localSettingsQuery, useUpdateLocalSettings } from "../queries.js";
import { useQueryFailure } from "../use-query-failure.js";

/** 审批档的名称、说明与实际权限见字典 settingsAgent.execution（需求 §5.1）。 */
const ORDER: readonly ApprovalMode[] = ["ask", "auto", "full"];

const FULL_APPROVAL_CONFIRMATION = {
  operation: "set-default-full-approval-mode",
  irreversible: false,
  impact: "account",
  // 改回默认值不能收回已在完全访问下启动的会话，恢复需要逐个处理。
  recovery: "costly",
} as const;

/** 执行与安全：新会话默认怎么确认 Codex 的操作、回合前是否自动存档。 */
export function ExecutionSection() {
  const text = useT().settingsAgent.execution;
  const local = useQuery(localSettingsQuery);
  const failure = useQueryFailure(local);
  const update = useUpdateLocalSettings();
  const [approvalSaved, trackApproval] = useSaveIndicator();
  const [checkpointSaved, trackCheckpoint] = useSaveIndicator();
  const [confirmFull, setConfirmFull] = useState(false);

  if (local.isPending) {
    return (
      <SettingsSection id="execution" description={text.description}>
        <SectionSkeleton rows={3} label={text.loading} />
      </SettingsSection>
    );
  }
  if (local.isError) {
    return (
      <SettingsSection id="execution" description={text.description}>
        <RegionError
          kind={failure?.kind ?? "unknown"}
          message={text.loadFailed(failure?.message ?? "")}
          busy={local.isFetching}
          onRetry={() => void local.refetch()}
        />
      </SettingsSection>
    );
  }

  const settings = local.data;
  const maxMode = settings.approvalModeLocked ? settings.maxApprovalMode : undefined;
  const blocked = (mode: ApprovalMode) => maxMode !== undefined && ORDER.indexOf(mode) > ORDER.indexOf(maxMode);
  const lockReason = maxMode === undefined ? null : text.approval.lockReason(text.modes[maxMode].label);

  const setMode = (mode: ApprovalMode) => {
    trackApproval(update.mutateAsync({ defaultApprovalMode: mode }));
  };

  return (
    <SettingsSection id="execution" description={text.descriptionWithSessionNote}>
      <SettingsRow
        anchor="approval"
        title={text.approval.title}
        status={<SaveStatus state={approvalSaved} />}
        stacked
      >
        <RadioGroup
          aria-labelledby={rowLabelId("approval")}
          value={settings.defaultApprovalMode}
          onValueChange={(value) => {
            const mode = value as ApprovalMode;
            if (mode === "full" && needsConfirm(FULL_APPROVAL_CONFIRMATION)) {
              setConfirmFull(true);
              return;
            }
            setMode(mode);
          }}
          className="gap-2"
        >
          {ORDER.map((mode) => (
            <RadioCard
              key={mode}
              value={mode}
              disabled={blocked(mode)}
              title={text.modes[mode].label}
              description={blocked(mode) ? text.approval.blocked : text.modes[mode].description}
              badge={
                blocked(mode) ? (
                  <Badge variant="warning">
                    <LockKeyholeIcon />
                    {text.approval.blockedBadge}
                  </Badge>
                ) : mode === "auto" ? (
                  <span className="text-caption font-normal text-subtle-foreground">{text.approval.recommended}</span>
                ) : undefined
              }
              data-testid={`settings-approval-${mode}`}
            />
          ))}
        </RadioGroup>
        {lockReason === null ? null : <LockNote>{lockReason}</LockNote>}
        <table className="w-full border-collapse text-small" aria-label={text.matrix.label}>
          <thead>
            <tr className="text-left text-caption text-subtle-foreground">
              <th className="py-1.5 pr-3 font-normal">{text.matrix.mode}</th>
              <th className="py-1.5 pr-3 font-normal">{text.matrix.files}</th>
              <th className="py-1.5 font-normal">{text.matrix.network}</th>
            </tr>
          </thead>
          <tbody>
            {ORDER.map((mode) => (
              <tr key={mode} className="border-t border-border">
                <td className="py-1.5 pr-3 text-foreground">{text.modes[mode].label}</td>
                <td className="py-1.5 pr-3 text-muted-foreground">{text.matrix.rows[mode].files}</td>
                <td className="py-1.5 text-muted-foreground">{text.matrix.rows[mode].network}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SettingsRow>

      <SettingsRow
        anchor="full-access"
        title={text.fullAccess.title}
        description={text.fullAccess.description}
      >
        <span className="text-small text-muted-foreground" data-testid="settings-full-allowed">
          {blocked("full") ? text.fullAccess.blocked : text.fullAccess.allowed}
        </span>
      </SettingsRow>

      <SettingsRow
        anchor="checkpoint"
        title={text.checkpoint.title}
        description={text.checkpoint.description}
        status={<SaveStatus state={checkpointSaved} />}
      >
        <div>
          <Switch
            aria-labelledby={rowLabelId("checkpoint")}
            aria-describedby={rowDescId("checkpoint")}
            checked={settings.gitAutoCheckpointDefault}
            data-testid="settings-git-checkpoint"
            onCheckedChange={(checked) => trackCheckpoint(update.mutateAsync({ gitAutoCheckpointDefault: checked }))}
          />
        </div>
      </SettingsRow>

      <ConfirmDialog
        open={confirmFull}
        onOpenChange={setConfirmFull}
        title={text.fullConfirm.title}
        description={text.fullConfirm.description}
        confirmLabel={text.fullConfirm.confirm}
        onConfirm={() => setMode("full")}
      />
    </SettingsSection>
  );
}
