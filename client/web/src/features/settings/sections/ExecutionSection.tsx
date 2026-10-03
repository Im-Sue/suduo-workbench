import { useQuery } from "@tanstack/react-query";
import type { ApprovalMode } from "@suduo/client-contracts";
import { LockKeyholeIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { RadioCard, RadioGroup } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog, RegionError } from "../../../feedback/components/index.js";
import { needsConfirm } from "../../../feedback/confirm-policy.js";
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

/** 审批档的用户词表（需求 §5.1）。 */
export const APPROVAL_LABEL: Readonly<Record<ApprovalMode, string>> = {
  ask: "每步确认",
  auto: "越界时确认",
  full: "完全访问",
};

const APPROVAL_DESCRIPTION: Readonly<Record<ApprovalMode, string>> = {
  ask: "运行命令、修改文件前都先问你。最稳妥，也最常被打断。",
  auto: "在代码目录内读写、运行常规命令时直接执行；联网、访问目录外的文件时问你。",
  full: "不再询问，命令与网络全部放行。只在你完全信任当前任务时使用，切换时会再确认一次。",
};

/** 三种方式的实际权限：让人看清「选了会发生什么」。 */
const APPROVAL_MATRIX: readonly { mode: ApprovalMode; files: string; network: string }[] = [
  { mode: "ask", files: "只读，写入前问你", network: "不允许" },
  { mode: "auto", files: "代码目录内可写", network: "不允许" },
  { mode: "full", files: "不受限制", network: "允许" },
];

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
  const local = useQuery(localSettingsQuery);
  const failure = useQueryFailure(local);
  const update = useUpdateLocalSettings();
  const [approvalSaved, trackApproval] = useSaveIndicator();
  const [checkpointSaved, trackCheckpoint] = useSaveIndicator();
  const [confirmFull, setConfirmFull] = useState(false);

  if (local.isPending) {
    return (
      <SettingsSection id="execution" description="新会话默认用哪种方式确认 Codex 的操作。">
        <SectionSkeleton rows={3} label="正在读取执行与安全设置" />
      </SettingsSection>
    );
  }
  if (local.isError) {
    return (
      <SettingsSection id="execution" description="新会话默认用哪种方式确认 Codex 的操作。">
        <RegionError
          kind={failure?.kind ?? "unknown"}
          message={`没能读取本机设置：${failure?.message ?? ""}`}
          busy={local.isFetching}
          onRetry={() => void local.refetch()}
        />
      </SettingsSection>
    );
  }

  const settings = local.data;
  const maxMode = settings.approvalModeLocked ? settings.maxApprovalMode : undefined;
  const blocked = (mode: ApprovalMode) => maxMode !== undefined && ORDER.indexOf(mode) > ORDER.indexOf(maxMode);
  const lockReason =
    maxMode === undefined ? null : `管理员已限制最高权限为「${APPROVAL_LABEL[maxMode]}」，更高的选项不可用。需要时请联系管理员。`;

  const setMode = (mode: ApprovalMode) => {
    trackApproval(update.mutateAsync({ defaultApprovalMode: mode }));
  };

  return (
    <SettingsSection id="execution" description="新会话默认用哪种方式确认 Codex 的操作。每个会话都可以在输入框下方单独调整。">
      <SettingsRow
        anchor="approval"
        title="新会话默认确认方式"
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
              title={APPROVAL_LABEL[mode]}
              description={blocked(mode) ? "管理员已限制，不可选" : APPROVAL_DESCRIPTION[mode]}
              badge={
                blocked(mode) ? (
                  <Badge variant="warning">
                    <LockKeyholeIcon />
                    已限制
                  </Badge>
                ) : mode === "auto" ? (
                  <span className="text-caption font-normal text-subtle-foreground">推荐</span>
                ) : undefined
              }
              data-testid={`settings-approval-${mode}`}
            />
          ))}
        </RadioGroup>
        {lockReason === null ? null : <LockNote>{lockReason}</LockNote>}
        <table className="w-full border-collapse text-small" aria-label="三种方式的实际权限">
          <thead>
            <tr className="text-left text-caption text-subtle-foreground">
              <th className="py-1.5 pr-3 font-normal">方式</th>
              <th className="py-1.5 pr-3 font-normal">文件</th>
              <th className="py-1.5 font-normal">联网</th>
            </tr>
          </thead>
          <tbody>
            {APPROVAL_MATRIX.map((row) => (
              <tr key={row.mode} className="border-t border-border">
                <td className="py-1.5 pr-3 text-foreground">{APPROVAL_LABEL[row.mode]}</td>
                <td className="py-1.5 pr-3 text-muted-foreground">{row.files}</td>
                <td className="py-1.5 text-muted-foreground">{row.network}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SettingsRow>

      <SettingsRow
        anchor="full-access"
        title="会话可切换到完全访问"
        description="决定会话里能不能把确认方式切到「完全访问」。"
      >
        <span className="text-small text-muted-foreground" data-testid="settings-full-allowed">
          {blocked("full") ? "不可以（管理员已限制）" : "可以"}
        </span>
      </SettingsRow>

      <SettingsRow
        anchor="checkpoint"
        title="回合前自动存档"
        description="项目启用版本管理时，默认在每个回合开始前存一个检查点，改坏了可以回到开始前。"
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
        title="默认使用完全访问？"
        description="新会话将不再询问，命令与网络全部放行。只在完全信任的代码目录里使用。"
        confirmLabel="设为完全访问"
        onConfirm={() => setMode("full")}
      />
    </SettingsSection>
  );
}
