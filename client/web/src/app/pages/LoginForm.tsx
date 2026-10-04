import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client.js";
import { classifyFailure } from "../../feedback/classify.js";
import { InlineError } from "../../feedback/components/index.js";
import { clearPageFeedback } from "../../feedback/page-store.js";
import type { Failure } from "../../feedback/types.js";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { queryKeys } from "../queries.js";
import { useCarried, useCarrySource, useT } from "../../i18n/provider.js";

/**
 * 登录 / 注册表单（登录页与首启向导共用）。
 * 用 <form> 承载：任一字段按回车都能提交（修复审计缺陷：旧版只有密码框能回车）。
 */
export function LoginForm({ onAuthenticated }: { onAuthenticated(): Promise<void> | void }) {
  const t = useT();
  const text = t.setup.loginForm;
  const queryClient = useQueryClient();
  // 已填的字段带过语言切换的重建（i18n/carry.ts；快照只在内存里，读回或重建结束即丢）。
  const carried = useCarried<{ mode: "login" | "register"; loginName: string; displayName: string; password: string }>("login-form");
  const [mode, setMode] = useState<"login" | "register">(carried?.mode ?? "login");
  const [loginName, setLoginName] = useState(carried?.loginName ?? "");
  const [displayName, setDisplayName] = useState(carried?.displayName ?? "");
  const [password, setPassword] = useState(carried?.password ?? "");
  useCarrySource("login-form", () => ({ mode, loginName, displayName, password }));
  const [error, setError] = useState<Failure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);

  const missingLogin = loginName.trim() === "";
  const missingName = mode === "register" && displayName.trim() === "";
  const missingPassword = password === "";

  const submit = async () => {
    setTouched(true);
    if (missingLogin || missingName || missingPassword || submitting) return;
    setSubmitting(true);
    try {
      if (mode === "login") {
        await api.loginRequirements({ loginName: loginName.trim(), password });
      } else {
        await api.registerRequirements({ loginName: loginName.trim(), displayName: displayName.trim(), password });
      }
      setPassword("");
      setError(null);
      // 登录成功显式清除页面级失败，否则失败页会残留覆盖新会话。
      clearPageFeedback();
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      await onAuthenticated();
    } catch (cause) {
      setError(classifyFailure(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <SegmentedControl
        aria-label={text.modeLabel}
        className="self-start"
        value={mode}
        options={[
          { value: "login", label: text.modeLogin },
          { value: "register", label: text.modeRegister },
        ]}
        onValueChange={(next) => {
          setMode(next);
          setError(null);
          setTouched(false);
        }}
      />
      {error === null ? null : <InlineError kind={error.kind}>{error.message}</InlineError>}
      <Field label={text.loginName} error={touched && missingLogin ? text.loginNameRequired : undefined}>
        <Input
          id="requirements-login-name"
          autoComplete="username"
          autoFocus
          value={loginName}
          onChange={(event) => setLoginName(event.target.value)}
          placeholder={text.loginNamePlaceholder}
        />
      </Field>
      {mode === "register" ? (
        <Field label={text.displayName} hint={text.displayNameHint} error={touched && missingName ? text.displayNameRequired : undefined}>
          <Input
            id="requirements-display-name"
            autoComplete="name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder={text.displayNamePlaceholder}
          />
        </Field>
      ) : null}
      <Field label={text.password} error={touched && missingPassword ? text.passwordRequired : undefined}>
        <Input
          id="requirements-password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <Button type="submit" size="lg" variant="primary" loading={submitting}>
        {mode === "login" ? text.submitLogin : text.submitRegister}
      </Button>
    </form>
  );
}
