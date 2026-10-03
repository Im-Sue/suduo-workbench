import { useState } from "react";
import { RadioGroup, RadioTile } from "@/components/ui/radio-group";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { applyDensityPreference, loadDensityPreference, type DensityPreference } from "../../../ui/density.js";
import { applyThemePreference, useThemePreference, type ThemePreference } from "../../../ui/theme.js";
import { rowDescId, rowLabelId, SaveStatus, SettingsRow, SettingsSection, useSaveIndicator } from "../components/kit.js";

/** 外观：主题三选一（带预览缩略图）、密度两档。只存在这台电脑的浏览器里，改完立即生效。 */
export function AppearanceSection() {
  const theme = useThemePreference();
  const [density, setDensity] = useState<DensityPreference>(() => loadDensityPreference());
  const [themeSaved, trackTheme] = useSaveIndicator();
  const [densitySaved, trackDensity] = useSaveIndicator();

  return (
    <SettingsSection id="appearance" description="改动立即生效，只影响这台电脑。">
      <SettingsRow
        anchor="theme"
        title="主题"
        description="跟随系统时，会随电脑的深浅色设置自动切换。"
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
          <RadioTile value="light" className="w-[152px]" aria-label="浅色">
            <ThemeThumb scope="light" />
            <span className="px-1">浅色</span>
          </RadioTile>
          <RadioTile value="dark" className="w-[152px]" aria-label="深色">
            <ThemeThumb scope="dark" />
            <span className="px-1">深色</span>
          </RadioTile>
          <RadioTile value="system" className="w-[152px]" aria-label="跟随系统（推荐）">
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
              跟随系统
              <span className="text-caption font-normal text-subtle-foreground">推荐</span>
            </span>
          </RadioTile>
        </RadioGroup>
      </SettingsRow>

      <SettingsRow
        anchor="density"
        title="界面密度"
        description="紧凑时列表和控件更矮，一屏能看到更多内容。"
        status={<SaveStatus state={densitySaved} />}
      >
        <div>
          <SegmentedControl
            aria-labelledby={rowLabelId("density")}
            data-testid="settings-density"
            value={density}
            options={[
              { value: "comfortable", label: "舒适" },
              { value: "compact", label: "紧凑" },
            ]}
            onValueChange={(next) => {
              trackDensity(() => applyDensityPreference(next));
              setDensity(next);
            }}
          />
        </div>
      </SettingsRow>
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
