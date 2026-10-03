import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const SEED_FILES = ["config.toml", "auth.json"] as const;

export interface CodexHomeSeedResult {
  seeded: string[];
  kept: string[];
}

/**
 * 启动时把缺失的 Codex 配置从 defaults 目录补进 CODEX_HOME。
 * 已存在的文件永不覆盖：登录态与用户改动在升级后保留。
 * （旧版还会种两个「搬数据」skill；需求信息改由会话工具提供后已不再种，见 ADR-0008。）
 */
export function seedCodexHome(
  defaultsDir: string,
  codexHome: string,
): CodexHomeSeedResult {
  const seeded: string[] = [];
  const kept: string[] = [];
  mkdirSync(codexHome, { recursive: true });
  for (const name of SEED_FILES) {
    const source = resolve(defaultsDir, name);
    const target = resolve(codexHome, name);
    if (existsSync(target)) {
      kept.push(name);
      continue;
    }
    if (!existsSync(source)) {
      continue;
    }
    copyFileSync(source, target);
    seeded.push(name);
  }
  return { seeded, kept };
}
