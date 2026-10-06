// Renders the shell's PNG icons from the brand mark (the "relay S", same paths as client/web/public/favicon.svg)
// with Playwright's Chromium. Outputs are committed under client/desktop/assets; rerun after changing the mark.
//   trayTemplate.png / @2x  macOS menu bar template image (black + alpha; the system tints it)
//   tray.png / @2x          Windows notification area icon (full colour)
//   icon.png                window / app icon (512 px)
//   ../build/icon.png       full-bleed 1024 px master (Linux / docs)
//   ../build/icon-mac.png   macOS master, 1024 px on Apple's grid (824 px body, transparent margin)
//   ../build/icon.icns      macOS app icon, made by Apple's iconutil from a standard .iconset (macOS only)
//   ../build/icon.ico       Windows icon: PNG entries 16–256 px
// The .icns and .ico are made here rather than by electron-builder: its converter put a 64 px image in the 48 px
// `icp6` slot, which Finder drew as noise in the copy dialog.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  const render = async (svg, size) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">` +
        svg.replace("<svg ", `<svg width="${size.width}" height="${size.height}" style="display:block" `) +
        `</body></html>`,
    );
    return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size.width, height: size.height } });
  };
  for (const output of outputs) {
    const png = await render(output.svg, output);
    writeFileSync(output.file.startsWith("/") ? output.file : join(assets, output.file), png);
    console.log(`wrote ${output.file}`);
  }

  // Windows .ico: PNG-compressed entries (supported since Windows Vista).
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoImages = [];
  for (const size of icoSizes) icoImages.push({ size, png: await render(colour, { width: size, height: size }) });
  writeFileSync(join(buildDir, "icon.ico"), ico(icoImages));
  console.log("wrote build/icon.ico");

  // macOS .icns via iconutil from the standard iconset sizes.
  if (process.platform === "darwin") {
    const iconset = join(buildDir, "icon.iconset");
    rmSync(iconset, { recursive: true, force: true });
    mkdirSync(iconset);
    for (const base of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const size = base * scale;
        const name = scale === 1 ? `icon_${base}x${base}.png` : `icon_${base}x${base}@2x.png`;
        writeFileSync(join(iconset, name), await render(macIcon, { width: size, height: size }));
      }
    }
    const result = spawnSync("iconutil", ["-c", "icns", iconset, "-o", join(buildDir, "icon.icns")], { stdio: "inherit" });
    rmSync(iconset, { recursive: true, force: true });
    if (result.status !== 0) throw new Error("iconutil failed");
    console.log("wrote build/icon.icns");
  } else {
    console.log("skipped build/icon.icns (iconutil is macOS only; the committed file is used)");
  }
} finally {
  await browser.close();
}

function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    header[entry] = image.size >= 256 ? 0 : image.size;
    header[entry + 1] = image.size >= 256 ? 0 : image.size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}
