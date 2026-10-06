// Renders the shell's PNG icons from the brand mark (the "relay S", same paths as client/web/public/favicon.svg)
// with Playwright's Chromium. Outputs are committed under client/desktop/assets; rerun after changing the mark.
//   trayTemplate.png / @2x  macOS menu bar template image (black + alpha; the system tints it)
//   tray.png / @2x          Windows notification area icon (full colour)
//   icon.png                window / app icon (512 px)
//   ../build/icon.png       packaging icon for Windows (1024 px, full bleed; electron-builder makes the .ico)
//   ../build/icon-mac.png   packaging icon for macOS (1024 px on Apple's grid: 824 px body, transparent margin;
//                           electron-builder makes the .icns)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "assets");
const buildDir = join(root, "build");
mkdirSync(assets, { recursive: true });
mkdirSync(buildDir, { recursive: true });

const STROKES = (top, bottom) =>
  `<path d="M39.6 15.4A10.5 10.5 0 1 0 27 31" fill="none" stroke="${top}" stroke-width="10" stroke-linecap="round"/>` +
  `<path d="M37 33A10.5 10.5 0 1 1 24.4 48.6" fill="none" stroke="${bottom}" stroke-width="10" stroke-linecap="round"/>`;

// The mark alone spans roughly x 13–51, y 4–60 of the 64 box; crop to it so it fills the small menu bar slot.
const template = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 2 48 60">${STROKES("#000", "#000")}</svg>`;
const colour =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14.5" fill="#3451D1"/>` +
  `<g transform="translate(6.4 6.4) scale(0.8)">${STROKES("#FFFFFF", "#3FD4B8")}</g></svg>`;

// macOS app icon grid: 1024 canvas, 824 body (100 px margin), corner radius ≈ 185.
const macIcon =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect x="100" y="100" width="824" height="824" rx="185" fill="#3451D1"/>` +
  `<g transform="translate(100 100) scale(12.875) translate(6.4 6.4) scale(0.8)">${STROKES("#FFFFFF", "#3FD4B8")}</g></svg>`;

const outputs = [
  { file: "trayTemplate.png", svg: template, width: 13, height: 16 },
  { file: "trayTemplate@2x.png", svg: template, width: 26, height: 32 },
  { file: "tray.png", svg: colour, width: 16, height: 16 },
  { file: "tray@2x.png", svg: colour, width: 32, height: 32 },
  { file: "icon.png", svg: colour, width: 512, height: 512 },
  { file: join(buildDir, "icon.png"), svg: colour, width: 1024, height: 1024 },
  { file: join(buildDir, "icon-mac.png"), svg: macIcon, width: 1024, height: 1024 },
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const output of outputs) {
    await page.setViewportSize({ width: output.width, height: output.height });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">` +
        output.svg.replace("<svg ", `<svg width="${output.width}" height="${output.height}" style="display:block" `) +
        `</body></html>`,
    );
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: output.width, height: output.height } });
    writeFileSync(output.file.startsWith("/") ? output.file : join(assets, output.file), png);
    console.log(`wrote ${output.file}`);
  }
} finally {
  await browser.close();
}
