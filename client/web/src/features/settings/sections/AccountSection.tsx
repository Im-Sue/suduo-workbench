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
import { useT } from "../../../i18n/provider.js";
import { SettingsRow, SettingsSection } from "../components/kit.js";
import { formatDay } from "../format.js";

/** 账号：当前登录的是谁、登录到什么时候、退出登录。 */
export function AccountSection() {
  const text = useT().settings.account;
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
    <SettingsSection id="account" description={text.description}>
      <SettingsRow anchor="current-user" title={text.currentTitle} description={text.currentDescription}>
        {session === null ? (
          <div className="flex items-center gap-3">
            <span className="text-small text-muted-foreground">{text.signedOut}</span>
            <Button size="sm" variant="primary" type="button" onClick={() => void navigate({ to: "/login" })}>
              {text.signIn}
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
            <span className="ml-auto text-caption text-subtle-foreground">{text.expiresOn(formatDay(session.expiresAt))}</span>
          </div>
        )}
      </SettingsRow>

      {session === null ? null : (
        <SettingsRow anchor="logout" title={text.logoutTitle} description={text.logoutDescription}>
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
              {text.logout}
            </Button>
          </div>
        </SettingsRow>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        triggerRef={logoutRef}
        title={text.logoutConfirm.title}
        description={text.logoutConfirm.description}
        confirmLabel={text.logoutConfirm.confirm}
        onConfirm={() => void runLogout()}
      />
    </SettingsSection>
  );
}
