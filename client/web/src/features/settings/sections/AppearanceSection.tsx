import type { LocalePreference } from "@suduo/client-contracts";
import { useState } from "react";
import { RadioGroup, RadioTile } from "@/components/ui/radio-group";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { applyLocalePreference, UI_LOCALES } from "../../../i18n/locale.js";
import { useLocalePreference, useT } from "../../../i18n/provider.js";
import { applyDensityPreference, loadDensityPreference, type DensityPreference } from "../../../ui/density.js";
import { applyThemePreference, useThemePreference, type ThemePreference } from "../../../ui/theme.js";
import { rowDescId, rowLabelId, SaveStatus, SettingsRow, SettingsSection, useSaveIndicator } from "../components/kit.js";

/** 外观：主题三选一（带预览缩略图）、密度两档、界面语言。只存在这台电脑的浏览器里，改完立即生效。 */
export function AppearanceSection() {
  const t = useT();
  const text = t.settingsAgent.appearance;
  const theme = useThemePreference();
  const localePreference = useLocalePreference();
  const localeChoices: LocalePreference[] = [
    "system",
    ...UI_LOCALES,
    ...(localePreference !== "system" && !UI_LOCALES.includes(localePreference) ? [localePreference] : []),
  ];
  const [density, setDensity] = useState<DensityPreference>(() => loadDensityPreference());
  const [themeSaved, trackTheme] = useSaveIndicator();
  const [densitySaved, trackDensity] = useSaveIndicator();

  return (
    <SettingsSection id="appearance" description={text.description}>
      <SettingsRow
        anchor="theme"
        title={text.theme.title}
        description={text.theme.description}
        status={<SaveStatus state={themeSaved} />}
        stacked
      >
        <RadioGroup
          aria-labelledby={rowLabelId("theme")}
          aria-describedby={rowDescId("theme")}
          value={theme}
          onValueChange={(value) => {
            const next = value as ThemePreference;
            trackTheme(() => applyThemePreference(next));
          }}
          className="flex flex-wrap gap-3"
          data-testid="settings-theme"
        >
          <RadioTile value="light" className="w-[152px]" aria-label={text.theme.light}>
            <ThemeThumb scope="light" />
            <span className="px-1">{text.theme.light}</span>
          </RadioTile>
          <RadioTile value="dark" className="w-[152px]" aria-label={text.theme.dark}>
            <ThemeThumb scope="dark" />
            <span className="px-1">{text.theme.dark}</span>
          </RadioTile>
          <RadioTile value="system" className="w-[152px]" aria-label={text.theme.systemRecommended}>
            {/* 左半边浅色、右半边深色：两张完整缩略图各露出一半。 */}
            <span className="relative flex h-[84px] overflow-hidden rounded-md border border-border">
              <span className="relative w-1/2 overflow-hidden">
                <span className="absolute inset-y-0 left-0 w-[138px]">
                  <ThemeThumb scope="light" bare />
                </span>
              </span>
              <span className="relative w-1/2 overflow-hidden">
                <span className="absolute inset-y-0 right-0 w-[138px]">
                  <ThemeThumb scope="dark" bare />
                </span>
              </span>
            </span>
            <span className="flex items-center gap-1.5 px-1">
              {text.theme.system}
              <span className="text-caption font-normal text-subtle-foreground">{text.theme.recommended}</span>
            </span>
          </RadioTile>
        </RadioGroup>
      </SettingsRow>

      <SettingsRow
        anchor="density"
        title={text.density.title}
        description={text.density.description}
        status={<SaveStatus state={densitySaved} />}
      >
        <div>
          <SegmentedControl
            aria-labelledby={rowLabelId("density")}
            data-testid="settings-density"
            value={density}
            options={[
              { value: "comfortable", label: text.density.comfortable },
              { value: "compact", label: text.density.compact },
            ]}
            onValueChange={(next) => {
              trackDensity(() => applyDensityPreference(next));
              setDensity(next);
            }}
          />
        </div>
      </SettingsRow>

      {/*
        语言：可选的固定语言只有一种时（迁移期 UI_LOCALES 只有中文）不显示这一行；
        但手动固定过一种还没做完的语言（如开发时把 suduo.locale 设成 en）时要显示，让人能从界面切回来。
        切换后 LocaleBoundary 按新语言重建整棵界面，所以说明里提醒未保存的内容可能丢失。
      */}
      {localeChoices.length > 2 ? (
        <SettingsRow anchor="locale" title={text.locale.title} description={text.locale.description}>
          <div>
            <SegmentedControl
              aria-labelledby={rowLabelId("locale")}
              data-testid="settings-locale"
              value={localePreference}
              options={localeChoices.map((value) => ({ value, label: t.common.localeOption[value] }))}
              onValueChange={(next) => applyLocalePreference(next)}
            />
          </div>
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}

/**
 * 主题缩略图：用 data-theme-scope 把这一小块按另一套令牌渲染，
 * 画的是真实的外壳结构（侧栏 + 内容卡片 + 一个主按钮），颜色永远与真实主题一致。
 */
function ThemeThumb({ scope, bare = false }: { scope: "light" | "dark"; bare?: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-theme-scope={scope}
      className={
        bare
          ? "flex h-full gap-1.5 bg-background p-2"
          : "flex h-[84px] gap-1.5 rounded-md border border-border bg-background p-2"
      }
    >
      <span className="flex w-[22px] shrink-0 flex-col gap-1 rounded-[3px] bg-muted-strong p-1">
        <span className="h-1 rounded-full bg-subtle-foreground/60" />
        <span className="h-1 rounded-full bg-subtle-foreground/40" />
        <span className="h-1 rounded-full bg-subtle-foreground/40" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[5px] rounded-sm border border-border bg-card p-[7px]">
        <span className="h-[5px] w-3/5 rounded-full bg-foreground/80" />
        <span className="h-1 w-4/5 rounded-full bg-muted-foreground/40" />
        <span className="h-1 w-1/2 rounded-full bg-muted-foreground/40" />
        <span className="mt-auto h-2 w-7 rounded-[3px] bg-primary" />
      </span>
    </span>
  );
}
