import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { guardExistingPath } from "../infrastructure/workspace/path-guard.js";
import type { ServerMessages } from "../i18n/messages/index.js";
import type { FolderPermission } from "../i18n/messages/zh-CN/workspace.js";

export interface WorkspaceMappingPathVerification {
  exists: boolean;
  readable: boolean;
  writable: boolean;
  executable: boolean;
  available: boolean;
  message: string;
}

/**
 * `t` 是给人看的结论用的字典：由路由按请求语言传入。
 */
export async function verifyWorkspaceMappingPath(
  rootPath: string,
  t: ServerMessages,
): Promise<WorkspaceMappingPathVerification> {
  const text = t.workspace.mappingCheck;
  const exists = await hasFilesystemAccess(rootPath, constants.F_OK);
  if (!exists) {
    return unavailableWorkspacePath(text.notFound);
  }

  let absolutePath: string;
  try {
    // 复用现有 path-guard 的 realpath/包含关系处理；不会创建或修改任何路径。
    absolutePath = (await guardExistingPath(rootPath)).absolutePath;
  } catch {
    return unavailableWorkspacePath(text.unresolvable);
  }

  try {
    if (!(await stat(absolutePath)).isDirectory()) {
      return unavailableWorkspacePath(text.notDirectory, true);
    }
  } catch {
    return unavailableWorkspacePath(text.statFailed, true);
  }

  const [readable, writable, executable] = await Promise.all([
    hasFilesystemAccess(absolutePath, constants.R_OK),
    hasFilesystemAccess(absolutePath, constants.W_OK),
    hasFilesystemAccess(absolutePath, constants.X_OK),
  ]);
  const available = readable && writable && executable;
  if (available) {
    return {
      exists: true,
      readable,
      writable,
      executable,
      available,
      message: text.available,
    };
  }
  const missing: FolderPermission[] = [
    ...(readable ? [] : (["read"] as const)),
    ...(writable ? [] : (["write"] as const)),
    ...(executable ? [] : (["execute"] as const)),
  ];
  return {
    exists: true,
    readable,
    writable,
    executable,
    available,
    message: text.missingPermissions(missing),
  };
}

async function hasFilesystemAccess(path: string, mode: number): Promise<boolean> {
  return access(path, mode).then(() => true).catch(() => false);
}

function unavailableWorkspacePath(
  message: string,
  exists = false,
): WorkspaceMappingPathVerification {
  return {
    exists,
    readable: false,
    writable: false,
    executable: false,
    available: false,
    message,
  };
}
