import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { settingsQuery } from "../queries.js";
import { LoginForm } from "./LoginForm.js";

/** 登录页：居中聚焦布局，不显示侧栏。 */
export function LoginPage() {
  const baseUrl = useQuery(settingsQuery).data?.baseUrl ?? null;
  return (
    <main
      aria-label="登录远程需求服务"
      className="flex min-h-dvh w-full items-center justify-center bg-background p-6"
    >
      <div className="flex w-[min(400px,100%)] flex-col gap-6">
        <div className="flex flex-col items-start gap-4">
          <span className="flex size-10 items-center justify-center rounded-[10px] bg-foreground text-body font-semibold text-background">
            SD
          </span>
          <div className="flex flex-col gap-1">
            <h1 className="m-0 text-display font-semibold text-foreground">登录 SuDuo</h1>
            <p className="m-0 text-body text-muted-foreground">登录后即可查看和协作团队的需求。</p>
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-6 shadow-raised">
          {/* 登录成功后设置刷新出会话，根路由会用 replace 跳回原先要去的页面。 */}
          <LoginForm onAuthenticated={() => undefined} />
        </div>
        <p className="m-0 text-caption text-subtle-foreground">
          需求服务：<span className="font-mono">{baseUrl ?? "未配置"}</span>
          <Link to="/setup" search={{ step: 1 }} className="ml-2 text-primary-text no-underline hover:underline">
            更换
          </Link>
        </p>
      </div>
    </main>
  );
}
