import type { LocalePreference } from "@suduo/client-contracts";
import { useEffect, useRef, useState } from "react";
import { RadioGroup, RadioTile } from "@/components/ui/radio-group";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ConfirmDialog } from "../../../feedback/components/index.js";
import { switchWouldLoseWork } from "../../../i18n/carry.js";
import { applyLocalePreference, resolveUiLocale, UI_LOCALES } from "../../../i18n/locale.js";
import { useCarried, useCarrySource, useLocalePreference, useT } from "../../../i18n/provider.js";
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
  /** 切换会丢东西时先问：记下选了哪一项，确认后再切。 */
  const [confirmLocale, setConfirmLocale] = useState<LocalePreference | null>(null);
  /**
   * 切换后整棵界面重建，焦点会落回页面开头：从这里切的（点选、键盘、确认框），重建后把焦点放回语言控件当前选中的一项。
   * 有的浏览器点按钮不给它焦点，所以切之前显式记一笔；焦点本来就在控件里时也算。
   */
  const localeControl = useRef<HTMLDivElement>(null);
  const switchingHere = useRef(false);
  const refocusLocale = useCarried<boolean>("settings-locale-focus") === true;
  useCarrySource(
    "settings-locale-focus",
    () => switchingHere.current || (localeControl.current?.contains(document.activeElement) ?? false),
  );
  useEffect(() => {
    if (refocusLocale) localeControl.current?.querySelector<HTMLElement>('[data-state="on"]')?.focus();
  }, [refocusLocale]);
  const switchTo = (next: LocalePreference) => {
    switchingHere.current = true;
    applyLocalePreference(next);
    switchingHere.current = false;
  };
  const chooseLocale = (next: LocalePreference) => {
    // 界面语言不变（如系统是中文时在「跟随系统」与「简体中文」之间换）就不会重建，不用问。
    if (resolveUiLocale(next) !== resolveUiLocale(localePreference) && switchWouldLoseWork()) {
      setConfirmLocale(next);
      return;
    }
    switchTo(next);
  };
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
        语言：「跟随系统」加上 UI_LOCALES 里做完的语言（S9 起中英两种都在）。可选的固定语言只有一种时不显示这一行；
        手动固定过一种还没做完的语言（如开发时把 suduo.locale 设成别的）时也要显示，让人能从界面切回来。
        切换后 LocaleBoundary 按新语言重建整棵界面：草稿与排队的消息会带过去（i18n/carry.ts），
        带不过去的（打开的对话框、没保存的编辑）先确认。设置搜索的索引里有这一行（sections.ts）。
      */}
      {localeChoices.length > 2 ? (
        <SettingsRow anchor="locale" title={text.locale.title} description={text.locale.description}>
          <div ref={localeControl}>
            <SegmentedControl
              aria-labelledby={rowLabelId("locale")}
              data-testid="settings-locale"
              value={localePreference}
              options={localeChoices.map((value) => ({ value, label: t.common.localeOption[value] }))}
              onValueChange={chooseLocale}
            />
          </div>
        </SettingsRow>
      ) : null}
      <ConfirmDialog
        open={confirmLocale !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmLocale(null);
        }}
        title={text.locale.confirm.title}
        description={text.locale.confirm.body}
        confirmLabel={text.locale.confirm.action}
        onConfirm={() => {
          if (confirmLocale !== null) switchTo(confirmLocale);
        }}
      />
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
