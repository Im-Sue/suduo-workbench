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

/**
 * 登录 / 注册表单（登录页与首启向导共用）。
 * 用 <form> 承载：任一字段按回车都能提交（修复审计缺陷：旧版只有密码框能回车）。
 */
export function LoginForm({ onAuthenticated }: { onAuthenticated(): Promise<void> | void }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [loginName, setLoginName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
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
        aria-label="登录或注册"
        className="self-start"
        value={mode}
        options={[
          { value: "login", label: "登录" },
          { value: "register", label: "注册新账号" },
        ]}
        onValueChange={(next) => {
          setMode(next);
          setError(null);
          setTouched(false);
        }}
      />
      {error === null ? null : <InlineError kind={error.kind}>{error.message}</InlineError>}
      <Field label="登录名" error={touched && missingLogin ? "请输入登录名" : undefined}>
        <Input
          id="requirements-login-name"
          autoComplete="username"
          autoFocus
          value={loginName}
          onChange={(event) => setLoginName(event.target.value)}
          placeholder="例如 chensiyuan"
        />
      </Field>
      {mode === "register" ? (
        <Field label="显示名" hint="团队成员在需求和评论里看到的名字" error={touched && missingName ? "请输入显示名" : undefined}>
          <Input
            id="requirements-display-name"
            autoComplete="name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="例如：陈思远"
          />
        </Field>
      ) : null}
      <Field label="密码" error={touched && missingPassword ? "请输入密码" : undefined}>
        <Input
          id="requirements-password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <Button type="submit" size="lg" variant="primary" loading={submitting}>
        {mode === "login" ? "登录" : "注册并登录"}
      </Button>
    </form>
  );
}
