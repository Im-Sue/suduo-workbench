import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { ApiError } from "../../application/api-error.js";

export interface GuardedPath {
  root: string;
  absolutePath: string;
  relativePath: string;
}

export async function guardExistingPath(
  projectRoot: string,
  requestedPath = "",
): Promise<GuardedPath> {
  validateRelativePath(requestedPath);
  try {
    const root = await realpath(projectRoot);
    const absolutePath = await realpath(resolve(root, requestedPath));
    assertContained(root, absolutePath);
    return {
      root,
      absolutePath,
      relativePath: toPosix(relative(root, absolutePath)),
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(
      404,
      "NOT_FOUND",
      "文件或目录不存在",
      { path: requestedPath },
      { cause: error },
    );
  }
}

export async function guardWritableDirectory(
  projectRoot: string,
  directoryPath: string,
): Promise<GuardedPath> {
  validateRelativePath(directoryPath);
  const root = await realpath(projectRoot);
  const absolutePath = resolve(root, directoryPath);
  assertContained(root, absolutePath);
  let ancestor = absolutePath;
  while (ancestor !== root) {
    try {
      const resolvedAncestor = await realpath(ancestor);
      assertContained(root, resolvedAncestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      ancestor = resolve(ancestor, "..");
    }
  }
  return {
    root,
    absolutePath,
    relativePath: toPosix(relative(root, absolutePath)),
  };
}

export async function requireFile(path: GuardedPath): Promise<void> {
  if (!(await stat(path.absolutePath)).isFile()) {
    throw new ApiError(400, "VALIDATION_ERROR", "目标不是文件");
  }
}

export async function requireDirectory(path: GuardedPath): Promise<void> {
  if (!(await stat(path.absolutePath)).isDirectory()) {
    throw new ApiError(400, "VALIDATION_ERROR", "目标不是目录");
  }
}

export function assertContained(root: string, candidate: string): void {
  if (!isContainedPath(root, candidate, { relative, isAbsolute, sep })) {
    throw new ApiError(403, "VALIDATION_ERROR", "路径越过项目根目录");
  }
}

export function isContainedPath(
  root: string,
  candidate: string,
  pathApi: {
    relative(from: string, to: string): string;
    isAbsolute(path: string): boolean;
    sep: string;
  },
): boolean {
  const rel = pathApi.relative(root, candidate);
  if (rel === "") {
    return true;
  }
  return !(
    rel === ".." ||
    rel.startsWith(".." + pathApi.sep) ||
    pathApi.isAbsolute(rel)
  );
}

export function validateRelativePath(path: string): void {
  if (
    typeof path !== "string" ||
    path.includes("\0") ||
    isAbsolute(path) ||
    win32.isAbsolute(path)
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", "路径必须是项目内相对路径");
  }
  const segments = path.replaceAll("\\", "/").split("/");
  if (segments.includes("..")) {
    throw new ApiError(403, "VALIDATION_ERROR", "路径不允许包含 ..");
  }
}

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}
