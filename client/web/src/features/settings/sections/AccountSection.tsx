import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogOutIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { settingsQuery } from "../../../app/queries.js";
import { useLogout } from "../../../app/shell/use-logout.js";
import { ConfirmDialog } from "../../../feedback/components/index.js";
import { needsConfirm } from "../../../feedback/confirm-policy.js";
import { SettingsRow, SettingsSection } from "../components/kit.js";
import { formatDay } from "../format.js";

/** 账号：当前登录的是谁、登录到什么时候、退出登录。 */
export function AccountSection() {
  const settings = useQuery(settingsQuery).data;
  const session = settings?.session ?? null;
  const logout = useLogout();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const logoutRef = useRef<HTMLButtonElement>(null);

  const runLogout = async () => {
    setLeaving(true);
    try {
      await logout();
    } finally {
      setLeaving(false);
    }
  };

  return (
    <SettingsSection id="account" description="登录信息只保存在这台电脑上。">
      <SettingsRow anchor="current-user" title="当前账号" description="在团队的需求服务上使用的身份。">
        {session === null ? (
          <div className="flex items-center gap-3">
            <span className="text-small text-muted-foreground">未登录</span>
            <Button size="sm" variant="primary" type="button" onClick={() => void navigate({ to: "/login" })}>
              去登录
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Avatar size="lg">
              <AvatarFallback name={session.user.displayName} />
            </Avatar>
            <span className="flex min-w-0 flex-col leading-5">
              <span className="truncate text-body font-medium text-foreground" data-testid="settings-current-user">
                {session.user.displayName}
              </span>
              <span className="truncate text-caption text-subtle-foreground">{session.user.loginName}</span>
            </span>
            <span className="ml-auto text-caption text-subtle-foreground">登录有效期至 {formatDay(session.expiresAt)}</span>
          </div>
        )}
      </SettingsRow>

      {session === null ? null : (
        <SettingsRow anchor="logout" title="退出登录" description="退出后需要重新输入账号和密码。本机的会话和代码不受影响。">
          <div>
            <Button
              ref={logoutRef}
              variant="danger-ghost"
              type="button"
              loading={leaving}
              data-testid="settings-logout"
              onClick={() => {
                if (needsConfirm("logout-requirements")) setConfirming(true);
                else void runLogout();
              }}
            >
              <LogOutIcon />
              退出登录
            </Button>
          </div>
        </SettingsRow>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        triggerRef={logoutRef}
        title="退出登录？"
        description="退出后需要重新登录才能查看和修改需求。"
        confirmLabel="退出登录"
        onConfirm={() => void runLogout()}
      />
    </SettingsSection>
  );
}
