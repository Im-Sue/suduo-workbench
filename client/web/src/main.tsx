import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import { AppErrorBoundary } from "./app/AppErrorBoundary.js";
import { AppRoot } from "./app/AppRoot.js";
import { applyLocalePreference, loadLocalePreference } from "./i18n/locale.js";
import { applyDensityPreference, loadDensityPreference } from "./ui/density.js";
import { applyThemePreference, loadThemePreference } from "./ui/theme.js";
import "./styles.css";

applyThemePreference(loadThemePreference());
applyLocalePreference(loadLocalePreference());
applyDensityPreference(loadDensityPreference());

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("missing #root element");
}

const root = createRoot(rootElement);

const render = (application: ReactNode) => {
  root.render(
    <StrictMode>
      <AppErrorBoundary>{application}</AppErrorBoundary>
    </StrictMode>,
  );
};

if (import.meta.env.DEV && window.location.pathname === "/__design") {
  void import("./dev/DesignSystemPage.js").then(({ DesignSystemPage }) =>
    render(<DesignSystemPage />),
  );
} else {
  render(<AppRoot />);
}
