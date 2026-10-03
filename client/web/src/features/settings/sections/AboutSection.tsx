import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, FileCogIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "../../../api/client.js";
import { settingsQuery } from "../../../app/queries.js";
import { reportFailure } from "../../../feedback/report.js";
import { useLocale, useT } from "../../../i18n/provider.js";
import { showMessage } from "../../../ui/message.js";
import { SettingsRow, SettingsSection } from "../components/kit.js";
import { LICENSE_NAME, licenseLinks } from "../license.js";
import { doctorQuery, serviceHealthQuery } from "../queries.js";
import { appVersion, builtVersion, compareWithCloud } from "../version.js";

const LINK_CLASS =
  "rounded-xs text-primary-text underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";

/** 关于：版本、Codex 命令行版本、许可、高级入口（直接编辑 Codex 配置文件、本机诊断页）。 */
export function AboutSection() {
  const t = useT();
  const text = t.settings.about;
  const links = licenseLinks(useLocale());
  const doctor = useQuery(doctorQuery);
  const cli = doctor.data?.checks.find((check) => check.name === "Codex CLI");
  const [opening, setOpening] = useState(false);
  const settings = useQuery(settingsQuery);
  const baseUrl = settings.data?.configured === true ? (settings.data.baseUrl ?? "") : "";
  const service = useQuery({ ...serviceHealthQuery(baseUrl), enabled: baseUrl !== "" });
  const cloudVersion = service.data?.version;
  const match = compareWithCloud(builtVersion(), cloudVersion);

  return (
    <SettingsSection id="about" description={text.description}>
      <SettingsRow anchor="version" title={text.versionTitle}>
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-small">
          <dt className="text-muted-foreground">SuDuo</dt>
          <dd className="m-0 font-mono text-foreground" data-testid="settings-app-version">
            {appVersion(t)}
          </dd>
          <dt className="text-muted-foreground">{text.codexCli}</dt>
          <dd className="m-0 font-mono text-foreground">
            {doctor.isPending ? (
              <Skeleton className="h-4 w-24" />
            ) : cli === undefined ? (
              <span className="font-sans text-subtle-foreground">{text.unreadable}</span>
            ) : (
              // 依赖本机服务的中文文字（去掉全角括号里的说明），S5 改为读结构化字段；正则字面量不触发 i18n 规则。
              cli.message.replace(/^codex-cli\s*/i, "").replace(/（.*?）/g, "")
            )}
          </dd>
          <dt className="text-muted-foreground">{text.cloud}</dt>
          <dd className="m-0 font-mono text-foreground" data-testid="settings-cloud-version">
            {settings.isPending || (baseUrl !== "" && service.isPending) ? (
              <Skeleton className="h-4 w-24" />
            ) : settings.isError ? (
              <span className="font-sans text-subtle-foreground">{text.unreadable}</span>
            ) : baseUrl === "" ? (
              <span className="font-sans text-subtle-foreground">{text.serviceNotConfigured}</span>
            ) : service.isError ? (
              <span className="font-sans text-subtle-foreground">{text.unreachable}</span>
            ) : cloudVersion === null || cloudVersion === undefined ? (
              <span className="font-sans text-subtle-foreground">{text.cloudVersionUnknown}</span>
            ) : (
              cloudVersion
            )}
          </dd>
        </dl>
        {match === "different" ? (
          <p role="status" className="m-0 mt-2 text-caption text-warning" data-testid="settings-version-mismatch">
            {text.versionMismatch(builtVersion() ?? "", cloudVersion ?? "")}
          </p>
        ) : null}
      </SettingsRow>

      <SettingsRow
        anchor="license"
        title={text.licenseTitle}
        description={text.licenseDescription}
      >
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-small" data-testid="settings-license">
          <dt className="text-muted-foreground">{text.license}</dt>
          <dd className="m-0 flex flex-wrap gap-x-4">
            <ExternalLink href={links.license}>{LICENSE_NAME}</ExternalLink>
            <ExternalLink href={links.licenseTranslation}>{text.licenseTranslation}</ExternalLink>
          </dd>
          <dt className="text-muted-foreground">{text.commercial}</dt>
          <dd className="m-0">
            <ExternalLink href={links.commercial}>{text.commercialLink}</ExternalLink>
          </dd>
          <dt className="text-muted-foreground">{text.thirdParty}</dt>
          <dd className="m-0">
            <ExternalLink href={links.thirdParty}>{text.thirdPartyLink}</ExternalLink>
          </dd>
        </dl>
      </SettingsRow>

      <SettingsRow
        anchor="config-file"
        title={text.configFileTitle}
        description={text.configFileDescription}
      >
        <div>
          <Button
            type="button"
            loading={opening}
            data-testid="settings-open-config-file"
            onClick={() => {
              void (async () => {
                setOpening(true);
                try {
                  const result = await api.openCodexConfigFile();
                  showMessage(text.configFileOpened(result.path), "success");
                } catch (cause) {
                  reportFailure(cause, { surface: "action", title: text.configFileOpenFailed });
                } finally {
                  setOpening(false);
                }
              })();
            }}
          >
            <FileCogIcon />
            {text.openInEditor}
          </Button>
        </div>
      </SettingsRow>

      <SettingsRow anchor="doctor-page" title={text.doctorPageTitle} description={text.doctorPageDescription}>
        <div>
          <Button asChild>
            <a href="/doctor" target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              {text.openDoctorPage}
            </a>
          </Button>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

/** 新标签页打开的外链：屏幕阅读器会听到「在新标签页打开」，视觉上用图标提示。 */
function ExternalLink({ href, children }: { href: string; children: string }) {
  const text = useT().settings.about;
  return (
    <a className={LINK_CLASS} href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLinkIcon aria-hidden className="ml-0.5 inline size-3 align-[-1px]" />
      <span className="sr-only">{text.opensInNewTab}</span>
    </a>
  );
}
