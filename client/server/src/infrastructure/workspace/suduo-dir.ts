import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { ApiError } from "../../application/api-error.js";

/** SuDuo 在用户项目目录里的唯一落盘位置（需求会话上下文重做 R9）。 */
export const SUDUO_DIR = ".suduo";

/**
 * `.suduo/.gitignore` 的内容：整个目录（含这个文件本身）都不进 git。
 * 它写进用户的仓库、可能被不同语言的人看到，所以是与界面语言无关的固定英文。
 * 只在文件不存在时写入；已有的（含旧版写的中文注释头）原样保留，没有任何地方按内容识别它。
 */
const GITIGNORE_CONTENT = "# SuDuo local files, not tracked by git\n*\n";

/**
 * 确保 `<项目目录>/.suduo/` 存在且带忽略全部内容的 `.gitignore`，返回目录绝对路径。
 * 已有 `.gitignore` 时不覆盖（用户可能改过）。
 */
export async function ensureSuDuoDir(projectRoot: string): Promise<string> {
  const directory = join(projectRoot, SUDUO_DIR);
  await assertWritableInsideProject(projectRoot, directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, ".gitignore"), GITIGNORE_CONTENT, {
    flag: "wx",
    mode: 0o644,
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  });
  return directory;
}

/**
 * 写之前确认目标仍在项目目录里：`.suduo` 或其子目录可能是仓库里提交的、指向项目外的
 * 符号链接，`mkdir -p` 与写文件都会顺着走过去。取目标最近的已存在祖先求真实路径来判断，
 * 在创建任何东西之前完成。
 */
export async function assertWritableInsideProject(projectRoot: string, target: string): Promise<void> {
  const root = await realpath(projectRoot);
  let existing = target;
  for (;;) {
    const found = await stat(existing).then(() => true, () => false);
    if (found) break;
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const actual = await realpath(existing);
  if (actual !== root && !actual.startsWith(root + sep)) {
    // 按字典生成：回给 Codex 时按会话语言（toolFormat().reasonOf），走 HTTP 时按请求语言。
    const path = relative(projectRoot, target);
    throw new ApiError(500, "RUNTIME_REQUEST_FAILED", (t) => t.workspace.files.storageDirOutsideProject(path));
  }
}
