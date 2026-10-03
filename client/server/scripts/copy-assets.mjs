import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 整目录复制：新增 migration 无需再改本脚本（曾漏拷 002 导致打包冒烟失败）。
const source = resolve(root, "src", "infrastructure", "db", "migrations");
const target = resolve(root, "dist", "infrastructure", "db", "migrations");

mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
