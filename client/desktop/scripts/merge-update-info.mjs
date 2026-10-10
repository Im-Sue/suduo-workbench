// 把两台 Mac 构建机各自产出的 latest-mac-<arch>.yml 合成一份 latest-mac.yml（D3）：electron-updater 在 Mac 上
// 按文件名里的 arm64 挑自己那个包。只认 electron-builder 写出的固定格式，遇到认不出的行直接失败（别静默发错文件）。
// 用法：node merge-update-info.mjs <输出> <输入1> <输入2> …  不依赖任何包（发布那一步的机器上没装依赖）。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function parseUpdateInfo(text) {
  const info = { version: null, files: [], path: null, sha512: null, releaseDate: null };
  let inFiles = false;
  let current = null;
  for (const raw of text.split(/\r?\n/u)) {
    if (raw.trim() === "") continue;
    const item = /^ {2}- (\w+): (.*)$/u.exec(raw);
    const field = /^ {4}(\w+): (.*)$/u.exec(raw);
    const top = /^(\w+):(?: (.*))?$/u.exec(raw);
    if (inFiles && item !== null) {
      current = { [item[1]]: scalar(item[2]) };
      info.files.push(current);
    } else if (inFiles && field !== null && current !== null) {
      current[field[1]] = scalar(field[2]);
    } else if (top !== null) {
      inFiles = top[1] === "files" && top[2] === undefined;
      current = null;
      if (!inFiles) {
        if (!(top[1] in info) || top[1] === "files") throw new Error(`unexpected key: ${raw}`);
        info[top[1]] = scalar(top[2] ?? "");
      }
    } else {
      throw new Error(`unexpected line: ${raw}`);
    }
  }
  if (info.version === null || info.files.length === 0) throw new Error("update info without version or files");
  return info;
}

export function mergeUpdateInfo(infos) {
  const versions = new Set(infos.map((info) => info.version));
  if (versions.size !== 1) throw new Error(`versions differ: ${[...versions].join(", ")}`);
  const files = [];
  for (const info of infos) for (const file of info.files) if (!files.some((existing) => existing.url === file.url)) files.push(file);
  const first = infos[0];
  const latest = infos.map((info) => info.releaseDate ?? "").sort().at(-1) || first.releaseDate;
  return { version: first.version, files, path: first.path, sha512: first.sha512, releaseDate: latest };
}

export function formatUpdateInfo(info) {
  const lines = [`version: ${quote(info.version)}`, "files:"];
  for (const file of info.files) {
    const entries = Object.entries(file);
    entries.forEach(([key, value], index) => lines.push(`${index === 0 ? "  - " : "    "}${key}: ${quote(value)}`));
  }
  if (info.path !== null) lines.push(`path: ${quote(info.path)}`);
  if (info.sha512 !== null) lines.push(`sha512: ${quote(info.sha512)}`);
  if (info.releaseDate !== null) lines.push(`releaseDate: ${quote(info.releaseDate)}`);
  return lines.join("\n") + "\n";
}

function scalar(text) {
  const value = text.trim();
  if (/^'.*'$/u.test(value)) return value.slice(1, -1).replaceAll("''", "'");
  if (/^".*"$/u.test(value)) return JSON.parse(value);
  if (/^\d+$/u.test(value)) return Number(value);
  return value;
}

function quote(value) {
  return typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [output, ...inputs] = process.argv.slice(2);
  if (output === undefined || inputs.length === 0) throw new Error("usage: merge-update-info.mjs <output> <input>...");
  const merged = mergeUpdateInfo(inputs.map((file) => parseUpdateInfo(readFileSync(file, "utf8"))));
  writeFileSync(output, formatUpdateInfo(merged));
  console.log(`${output}: ${merged.files.map((file) => file.url).join(", ")}`);
}
