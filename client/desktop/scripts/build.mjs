// Builds the desktop shell into client/desktop/dist: main process and preload (CommonJS, Electron external),
// the startup page script (browser IIFE) and its static files. Only the shell; the local service and the web
// app are built by `pnpm build` in client/ as usual.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "startup"), { recursive: true });

const node = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  sourcemap: "linked",
  logLevel: "warning",
};

await Promise.all([
  build({ ...node, entryPoints: [join(root, "src", "main", "index.ts")], outfile: join(dist, "main.cjs") }),
  build({ ...node, entryPoints: [join(root, "src", "preload", "index.ts")], outfile: join(dist, "preload.cjs") }),
  build({
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome140",
    entryPoints: [join(root, "src", "startup", "startup.ts")],
    outfile: join(dist, "startup", "startup.js"),
    logLevel: "warning",
  }),
]);

for (const file of ["startup.html", "startup.css"]) {
  copyFileSync(join(root, "src", "startup", file), join(dist, "startup", file));
}
