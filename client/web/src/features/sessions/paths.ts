/**
 * Codex 报回的文件路径是绝对路径（FileUpdateChange.path）；工作区接口要项目内的相对路径。
 * 不在项目目录内返回 null。已经是相对路径的原样返回（去掉开头的 ./）。
 */
export function toProjectPath(path: string, projectRoot: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.startsWith("/") && !/^[a-z]:\//i.test(normalized)) return normalized.replace(/^\.\//, "");
  const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root === "") return null;
  if (normalized === root) return ".";
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : null;
}

/** 显示用：项目内的显示相对路径，项目外的原样显示。 */
export function displayProjectPath(path: string, projectRoot: string): string {
  return toProjectPath(path, projectRoot) ?? path;
}
