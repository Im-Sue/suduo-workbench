import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { guardExistingPath } from "../infrastructure/workspace/path-guard.js";

export interface WorkspaceMappingPathVerification {
  exists: boolean;
  readable: boolean;
  writable: boolean;
  executable: boolean;
  available: boolean;
  message: string;
}

export async function verifyWorkspaceMappingPath(
  rootPath: string,
): Promise<WorkspaceMappingPathVerification> {
  const exists = await hasFilesystemAccess(rootPath, constants.F_OK);
  if (!exists) {
    return unavailableWorkspacePath("本机工作目录不存在或无法访问");
  }

  let absolutePath: string;
  try {
    // 复用现有 path-guard 的 realpath/包含关系处理；不会创建或修改任何路径。
    absolutePath = (await guardExistingPath(rootPath)).absolutePath;
  } catch {
    return unavailableWorkspacePath("本机工作目录无法解析或访问");
  }

  try {
    if (!(await stat(absolutePath)).isDirectory()) {
      return unavailableWorkspacePath("本机工作目录不是目录", true);
    }
  } catch {
    return unavailableWorkspacePath("本机工作目录无法读取状态", true);
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
      message: "本机工作目录可用",
    };
  }
  const missing = [
    ...(readable ? [] : ["读取"]),
    ...(writable ? [] : ["写入"]),
    ...(executable ? [] : ["执行"]),
  ];
  return {
    exists: true,
    readable,
    writable,
    executable,
    available,
    message: `本机工作目录缺少${missing.join("、")}权限`,
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
