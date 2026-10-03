import { cp, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/** 旧版（快照 + 现状文件）在数据目录与项目目录里留下的、SuDuo 自己生成的副本。 */
const LEGACY_PROJECT_DIRECTORIES = [join(".suduo", "observations"), join(".suduo", "observed")];
/**
 * 旧版种子进 CODEX_HOME 的「搬数据」skill 与它们的公共脚本。
 * 目录名是当时的实际名字（品牌更名前，ADR-0010），不随品牌改。
 */
const LEGACY_SKILLS = [
  join("skills", "zjwork-publish-artifact-version"), // eslint-disable-line no-restricted-syntax -- 旧版实际目录名
  join("skills", "zjwork-fetch-artifact-version"), // eslint-disable-line no-restricted-syntax -- 旧版实际目录名
  "skill-support",
];

/**
 * 新版需求会话（ADR-0008）启动时的一次性清理：
 * - 删除数据目录下的 materials / observations 与项目内 .suduo/observations、.suduo/observed：
 *   都是 SuDuo 自己生成、可再生成的副本（ADR-0004 列为「不属红线」）。
 * - 旧 skill 不删，**移到** `retiredSkillsRoot`：ADR-0004 把删除 skill 目录列为红线，移动保留字节、可移回。
 * 全部尽力而为，失败只记日志，不影响启动。
 */
export async function retireLegacySessionContext(input: {
  v2DataDirectory: string;
  /** 旧版需求会话登记过的快照目录（v2_requirement_session_refs.material_path）。 */
  legacyMaterialPaths: readonly string[];
  /** 本机全部会话 ID：observations/<会话 ID> 只删这些。 */
  sessionIds: readonly string[];
  projectRoots: readonly string[];
  codexHome: string | undefined;
  retiredSkillsRoot: string;
  log?: (line: Record<string, unknown>) => void;
}): Promise<void> {
  const log = input.log ?? ((line) => console.info(JSON.stringify(line)));
  const removeIfPresent = async (path: string) => {
    if (!(await exists(path))) {
      return;
    }
    try {
      await rm(path, { recursive: true, force: true });
      log({ event: "suduo.legacy_context.removed", path });
    } catch (error) {
      log({ event: "suduo.legacy_context.remove_failed", path, message: messageOf(error) });
    }
  };
  // 数据目录可以配到任意位置：只删 SuDuo 自己登记过的路径，不整个删 materials/ observations/。
  const materialsRoot = resolve(input.v2DataDirectory, "materials");
  for (const path of input.legacyMaterialPaths) {
    const target = resolve(path);
    if (target.startsWith(materialsRoot + sep)) {
      await removeIfPresent(target);
      await removeEmptyParents(dirname(target), materialsRoot);
    }
  }
  const observationsRoot = join(input.v2DataDirectory, "observations");
  for (const sessionId of input.sessionIds) {
    await removeIfPresent(join(observationsRoot, sessionId));
  }
  await rmdir(observationsRoot).catch(() => undefined);
  await rmdir(materialsRoot).catch(() => undefined);
  for (const root of input.projectRoots) {
    for (const name of LEGACY_PROJECT_DIRECTORIES) {
      await removeIfPresent(join(root, name));
    }
  }
  if (input.codexHome === undefined) {
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  for (const name of LEGACY_SKILLS) {
    const source = join(input.codexHome, name);
    if (!(await exists(source))) {
      continue;
    }
    const target = join(input.retiredSkillsRoot, stamp, name);
    try {
      await moveDirectory(source, target);
      log({ event: "suduo.legacy_skill.retired", from: source, to: target });
    } catch (error) {
      log({ event: "suduo.legacy_skill.retire_failed", path: source, message: messageOf(error) });
    }
  }
}

/** 删掉空了的上级目录（到 stopAt 为止，含 stopAt 本身也只在空时删）。 */
async function removeEmptyParents(directory: string, stopAt: string): Promise<void> {
  let current = directory;
  while (current.startsWith(stopAt + sep) || current === stopAt) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    if (current === stopAt) return;
    current = dirname(current);
  }
}

async function moveDirectory(source: string, target: string): Promise<void> {
  await cp(source, target, { recursive: true, errorOnExist: true, force: false });
  await rm(source, { recursive: true, force: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
