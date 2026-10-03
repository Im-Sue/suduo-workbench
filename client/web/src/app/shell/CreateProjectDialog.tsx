import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../api/client.js";
import { classifyFailure } from "../../feedback/classify.js";
import { InlineError } from "../../feedback/components/index.js";
import type { Failure } from "../../feedback/types.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { rememberProjectId } from "../project-context.js";
import { queryKeys } from "../queries.js";

/** 新建项目：外壳级对话框，没有任何项目时也能用。创建后直接进入新项目的需求页。 */
export function CreateProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [error, setError] = useState<Failure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);
  const trimmed = name.trim();

  const submit = async () => {
    setTouched(true);
    if (trimmed === "" || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const project = await api.createRequirementsProject({ name: trimmed });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      rememberProjectId(project.id);
      onOpenChange(false);
      setName("");
      setTouched(false);
      await navigate({ to: "/p/$projectId/requirements", params: { projectId: project.id } });
    } catch (cause) {
      setError(classifyFailure(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setError(null);
          setTouched(false);
        }
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>新建项目</DialogTitle>
          <DialogDescription>项目是团队共享需求的容器，所有成员都能看到。</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field label="项目名称" error={touched && trimmed === "" ? "给项目起个名字" : undefined}>
            <Input
              autoFocus
              value={name}
              maxLength={100}
              placeholder="例如：订单中心"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          {error === null ? null : <InlineError kind={error.kind}>{error.message}</InlineError>}
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" variant="primary" loading={submitting}>
              创建项目<Kbd>⏎</Kbd>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
