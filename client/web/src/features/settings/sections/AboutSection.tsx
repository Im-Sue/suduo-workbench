import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, FileCogIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "../../../api/client.js";
import { settingsQuery } from "../../../app/queries.js";
import { reportFailure } from "../../../feedback/report.js";
import { showMessage } from "../../../ui/message.js";
import { SettingsRow, SettingsSection } from "../components/kit.js";
import { LICENSE_LINKS, LICENSE_NAME } from "../license.js";
import { doctorQuery, serviceHealthQuery } from "../queries.js";
import { appVersion, builtVersion, compareWithCloud } from "../version.js";

const LINK_CLASS =
  "rounded-xs text-primary-text underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";

/** 关于：版本、Codex 命令行版本、许可、高级入口（直接编辑 Codex 配置文件、本机诊断页）。 */
export function AboutSection() {
  const doctor = useQuery(doctorQuery);
  const cli = doctor.data?.checks.find((check) => check.name === "Codex CLI");
  const [opening, setOpening] = useState(false);
  const settings = useQuery(settingsQuery);
  const baseUrl = settings.data?.configured === true ? (settings.data.baseUrl ?? "") : "";
  const service = useQuery({ ...serviceHealthQuery(baseUrl), enabled: baseUrl !== "" });
  const cloudVersion = service.data?.version;
  const match = compareWithCloud(builtVersion(), cloudVersion);

  return (
    <SettingsSection id="about" description="速舵 SuDuo：团队共享需求，本机 Codex 写代码。代码和对话只留在你的电脑上。">
      <SettingsRow anchor="version" title="版本">
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-small">
          <dt className="text-muted-foreground">SuDuo</dt>
          <dd className="m-0 font-mono text-foreground" data-testid="settings-app-version">
            {appVersion()}
          </dd>
          <dt className="text-muted-foreground">Codex 命令行</dt>
          <dd className="m-0 font-mono text-foreground">
            {doctor.isPending ? (
              <Skeleton className="h-4 w-24" />
            ) : cli === undefined ? (
              <span className="font-sans text-subtle-foreground">没能读取</span>
            ) : (
              cli.message.replace(/^codex-cli\s*/i, "").replace(/（.*?）/g, "")
            )}
          </dd>
          <dt className="text-muted-foreground">云端</dt>
          <dd className="m-0 font-mono text-foreground" data-testid="settings-cloud-version">
            {settings.isPending || (baseUrl !== "" && service.isPending) ? (
              <Skeleton className="h-4 w-24" />
            ) : baseUrl === "" ? (
              <span className="font-sans text-subtle-foreground">还没有配置需求服务</span>
            ) : service.isError ? (
              <span className="font-sans text-subtle-foreground">连不上</span>
            ) : cloudVersion === null || cloudVersion === undefined ? (
              <span className="font-sans text-subtle-foreground">未知（较早的云端不报告版本）</span>
            ) : (
              cloudVersion
            )}
          </dd>
        </dl>
        {match === "different" ? (
          <p role="status" className="m-0 mt-2 text-caption text-warning" data-testid="settings-version-mismatch">
            本机 {builtVersion()} 与云端 {cloudVersion} 版本不同，建议使用相同版本：请管理员升级云端，或把本机切换到对应的发布版本。
          </p>
        ) : null}
      </SettingsRow>

      <SettingsRow
        anchor="license"
        title="许可"
        description="源码公开。个人非商业使用，以及教育、公益与政府机构免费；企业使用请在开始使用后 30 天内登记，目前免费。"
      >
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-small" data-testid="settings-license">
          <dt className="text-muted-foreground">许可证</dt>
          <dd className="m-0 flex flex-wrap gap-x-4">
            <ExternalLink href={LICENSE_LINKS.license}>{LICENSE_NAME}</ExternalLink>
            <ExternalLink href={LICENSE_LINKS.licenseTranslation}>中文参考译文</ExternalLink>
          </dd>
          <dt className="text-muted-foreground">商用登记</dt>
          <dd className="m-0">
            <ExternalLink href={LICENSE_LINKS.commercial}>查看登记说明</ExternalLink>
          </dd>
          <dt className="text-muted-foreground">第三方组件</dt>
          <dd className="m-0">
            <ExternalLink href={LICENSE_LINKS.thirdParty}>查看许可清单</ExternalLink>
          </dd>
        </dl>
      </SettingsRow>

      <SettingsRow
        anchor="config-file"
        title="直接编辑 Codex 配置文件"
        description="高级：绕过本页的检查直接改配置，改错可能导致会话无法启动。改完后到「诊断」确认一遍。"
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
                  showMessage(`已用系统编辑器打开：${result.path}`, "success");
                } catch (cause) {
                  reportFailure(cause, { surface: "action", title: "没能打开配置文件" });
                } finally {
                  setOpening(false);
                }
              })();
            }}
          >
            <FileCogIcon />
            用编辑器打开
          </Button>
        </div>
      </SettingsRow>

      <SettingsRow anchor="doctor-page" title="本机诊断页" description="不依赖本界面的纯文本诊断页，界面打不开时也能用。">
        <div>
          <Button asChild>
            <a href="/doctor" target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              打开诊断页
            </a>
          </Button>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

/** 新标签页打开的外链：屏幕阅读器会听到「在新标签页打开」，视觉上用图标提示。 */
function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a className={LINK_CLASS} href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLinkIcon aria-hidden className="ml-0.5 inline size-3 align-[-1px]" />
      <span className="sr-only">（在新标签页打开）</span>
    </a>
  );
}
