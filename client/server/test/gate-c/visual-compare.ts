/**
 * 比对两次视觉基线采集（`visual-closeout` / `en-visual` 写下的清单 `<标签>.json`）。
 *
 *   tsx server/test/gate-c/visual-compare.ts <基线清单.json> <本次清单.json>
 *
 * 逐页按 sha256 判断像素是否完全一致；不一致或缺页时列出来并以 1 退出——差异要对着两张图逐处解释
 * （pr13 的判定法），确认是预期的改动后，用本次那一组替换保存的基线即可。
 */
import { readFileSync } from "node:fs";
import { compareVisualSets, type VisualShot } from "./visual-baseline.js";

const [baselinePath, currentPath] = process.argv.slice(2);
if (baselinePath === undefined || currentPath === undefined) {
  console.error("用法：tsx server/test/gate-c/visual-compare.ts <基线清单.json> <本次清单.json>");
  process.exit(2);
}

const baseline = readShots(baselinePath);
const current = readShots(currentPath);
const rows = compareVisualSets(baseline, current);
const extra = current.filter((shot) => !baseline.some((item) => item.name === shot.name)).map((shot) => shot.name);
const changed = rows.filter((row) => !row.identical);
for (const row of rows) {
  console.info(`${row.identical ? "相同" : "不同"}  ${row.name}  ${row.before} → ${row.after}`);
}
for (const name of extra) console.info(`新增  ${name}`);
console.info(`共 ${String(rows.length)} 页：相同 ${String(rows.length - changed.length)}，不同或缺失 ${String(changed.length)}，新增 ${String(extra.length)}`);
process.exit(changed.length === 0 && extra.length === 0 ? 0 : 1);

function readShots(path: string): VisualShot[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${path} 不是视觉基线清单（应为截图数组）`);
  return parsed as VisualShot[];
}
