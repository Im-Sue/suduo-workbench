import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CodexAccountDto, CodexLoginStartDto } from "@suduo/client-contracts";
import { ExternalLinkIcon, LogInIcon, LogOutIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, ApiClientError } from "../../../api/client.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { reportFailure } from "../../../feedback/report.js";
import { useT } from "../../../i18n/provider.js";
import { showMessage } from "../../../ui/message.js";
import { SettingsRow } from "../components/kit.js";
import { codexAccountQuery, settingsKeys } from "../queries.js";

/** 登录进行中时每隔这么久问一次结果。 */
const POLL_MS = 2_000;

/**
 * 用 ChatGPT 账号登录 Codex（桌面应用 D2，需求 4.5）：走 Codex 自己的登录流程，授权页在系统浏览器里打开
 * （桌面应用里新窗口一律交给系统浏览器；浏览器里是新标签页，被拦了就点「重新打开授权页」），完成后自动更新状态。
 * 登录凭据由 Codex 自己保存，SuDuo 只拿到授权地址和结果（R4）。这一行即点即生效，不进模型服务的保存表单。
 */
export function ChatGptAccountRow() {
  const t = useT();
  const text = t.settingsConnection.model.chatgpt;
  const queryClient = useQueryClient();
  const account = useQuery(codexAccountQuery);
  const [login, setLogin] = useState<CodexLoginStartDto | null>(null);
  const [busy, setBusy] = useState<"start" | "signOut" | "cancel" | null>(null);

  // 模型服务（含它下面的登录方式）一起重取：「密钥来源」也跟着登录方式变。只失效这一个前缀，免得起两个 Codex 进程。
  const refresh = () => void queryClient.invalidateQueries({ queryKey: settingsKeys.model });

  useEffect(() => {
    if (login === null) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void api
        .codexLoginStatus(login.loginId)
        .then((status) => {
          if (stopped || status.status === "pending") return;
          setLogin(null);
          refresh();
          if (status.status === "succeeded") showMessage(text.succeeded, "success");
          else if (status.status === "failed") showMessage(text.failed(failureReason(status.error, text)), "warning");
        })
        .catch((cause: unknown) => {
          // 本机服务重启过、这次登录已经不在了：收起等待，按现在的登录状态显示。
          if (stopped || !(cause instanceof ApiClientError) || cause.status !== 404) return;
          setLogin(null);
          refresh();
        });
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
    // text / refresh 随语言变，不影响轮询本身：只跟着这次登录走。
  }, [login]);

  const start = async () => {
    setBusy("start");
    try {
      const started = await api.startCodexLogin();
      setLogin(started);
      window.open(started.authUrl, "_blank", "noopener,noreferrer");
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: text.failures.start });
    } finally {
      setBusy(null);
    }
  };
  const cancel = async () => {
    if (login === null) return;
    setBusy("cancel");
    try {
      await api.cancelCodexLogin(login.loginId);
      showMessage(text.cancelled, "info");
    } catch {
      // 取消没回包也照样收起：登录 10 分钟后会自己失效。
    } finally {
      setLogin(null);
      setBusy(null);
    }
  };
  const signOut = async () => {
    setBusy("signOut");
    try {
      await api.codexLogout();
      refresh();
      showMessage(text.signedOut, "success");
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: text.failures.signOut });
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsRow anchor="model-chatgpt" title={text.label} description={text.description}>
      <div className="flex flex-col gap-2" data-testid="model-chatgpt">
        <span className="text-small text-foreground" data-testid="model-chatgpt-status">
          {account.isPending ? (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <Spinner />
              {text.loading}
            </span>
          ) : account.isError ? (
            <span className="text-muted-foreground">{text.unavailable(classifyFailure(account.error).message)}</span>
          ) : (
            accountLine(account.data, text)
          )}
        </span>
        {account.data !== undefined && !account.data.requiresOpenaiAuth ? <span className="text-caption text-muted-foreground">{text.customProvider}</span> : null}
        {login !== null ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="model-chatgpt-waiting">
            <span className="text-caption text-muted-foreground">{text.waiting}</span>
            <Button size="sm" variant="ghost" asChild>
              <a href={login.authUrl} target="_blank" rel="noreferrer noopener">
                {text.openAgain}
                <ExternalLinkIcon />
              </a>
            </Button>
            <Button size="sm" variant="secondary" loading={busy === "cancel"} onClick={() => void cancel()} data-testid="model-chatgpt-cancel">
              {text.cancel}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {account.data?.mode === "chatgpt" ? (
              <Button size="sm" variant="secondary" loading={busy === "signOut"} onClick={() => void signOut()} data-testid="model-chatgpt-sign-out">
                <LogOutIcon />
                {text.signOut}
              </Button>
            ) : (
              <>
                <Button size="sm" variant="secondary" loading={busy === "start"} disabled={account.isPending} onClick={() => void start()} data-testid="model-chatgpt-sign-in">
                  <LogInIcon />
                  {text.signIn}
                </Button>
                {account.data?.mode === "apiKey" ? <span className="text-caption text-muted-foreground">{text.replacesApiKey}</span> : null}
              </>
            )}
          </div>
        )}
      </div>
    </SettingsRow>
  );
}

function accountLine(account: CodexAccountDto, text: ReturnType<typeof useT>["settingsConnection"]["model"]["chatgpt"]): string {
  switch (account.mode) {
    case "chatgpt":
      return text.signedIn(account.email, account.plan);
    case "apiKey":
      return text.apiKey;
    case "other":
      return text.other;
    case "none":
      return text.none;
  }
}

/** 服务端给的失败原因：认得的换成界面文字，其余（Codex 的原话）照登。 */
function failureReason(error: string | null, text: ReturnType<typeof useT>["settingsConnection"]["model"]["chatgpt"]): string {
  if (error === "timeout") return text.reasons.timeout;
  if (error === "codex exited") return text.reasons.codexExited;
  return error ?? text.reasons.unknown;
}
