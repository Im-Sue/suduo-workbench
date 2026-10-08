/** 本机目录缺少的权限（目录映射复验）。 */
export type FolderPermission = "read" | "write" | "execute";

const PERMISSION_NAMES: Record<FolderPermission, string> = { read: "读取", write: "写入", execute: "执行" };

/** 项目、本机代码目录映射、路径校验、附件、本机目录浏览、版本管理（git）的报错与提示。 */
export const workspace = {
  /** 本机项目（/api/v1/projects）。 */
  project: {
    rootPathInvalid: "rootPath 无效",
    rootPathNotReadable: "rootPath 必须是存在且可读的本机目录",
    removed: "项目已被软移除，请通过 PATCH 显式恢复",
    nameNotString: "项目名称必须是字符串",
    stateActiveOnly: "项目 state 仅允许 active",
    patchEmpty: "PATCH 至少提供一个字段",
    hasActiveSessions: "项目仍有活动会话，需先归档或删除会话",
    notFound: "项目不存在",
    nameLength: "项目名称长度必须为 1 到 200",
    versionConflict: "项目版本冲突",
    /** 项目不存在或已移除。 */
    activeNotFound: "活动项目不存在",
  },
  /** 远程项目与本机代码目录的映射。 */
  mapping: {
    rootPathNotString: "rootPath 必须是字符串",
    rootPathNotAbsolute: "rootPath 必须是无 NUL 的绝对路径",
    rootPathNotAccessible: "rootPath 必须是存在且具备读取、写入与执行权限的本机目录",
    projectRemoved: "本机工作目录对应的项目已被移除",
    missing: "该远程项目尚未配置本机工作目录",
    invalid: "本机工作目录映射已失效，请重新配置",
    changed: "本机工作目录映射已变化，请重新配置",
    unsupportedQuery: "不支持的 V2 查询参数",
    verifyInvalid: "verify 仅支持值 1",
  },
  /** 映射目录的可用性复验结论（设置页、诊断、「我的工作」）。 */
  mappingCheck: {
    notFound: "本机工作目录不存在或无法访问",
    unresolvable: "本机工作目录无法解析或访问",
    notDirectory: "本机工作目录不是目录",
    statFailed: "本机工作目录无法读取状态",
    available: "本机工作目录可用",
    missingPermissions: (missing: readonly FolderPermission[]) =>
      `本机工作目录缺少${missing.map((permission) => PERMISSION_NAMES[permission]).join("、")}权限`,
  },
  /** 项目内路径校验。 */
  path: {
    notFound: "文件或目录不存在",
    notFile: "目标不是文件",
    notDirectory: "目标不是目录",
    outsideProject: "路径越过项目根目录",
    relativeRequired: "路径必须是项目内相对路径",
    dotDot: "路径不允许包含 ..",
  },
  /** 本机目录浏览（选目录）。 */
  localDirectory: {
    notFolder: "这个位置不是文件夹",
    absoluteRequired: "请输入以根目录开头的完整路径",
    notFound: "这个位置不存在",
    permissionDenied: "没有权限访问这个位置",
    unresolvable: "这个路径无法解析",
    readFailed: "读取本机目录失败",
    hiddenInvalid: "hidden 仅支持 1 或 0",
    unsupportedQuery: (key: string) => `不支持的查询参数: ${key}`,
    repeatedQuery: (key: string) => `查询参数 ${key} 只能出现一次`,
  },
  /** 会话输入框贴图（存进项目的 .suduo/attachments）。 */
  attachment: {
    fieldsInvalid: "附件请求字段无效",
    typeUnsupported: "附件仅支持 PNG/JPEG/GIF/WebP 图片",
    base64Invalid: "图片 base64 无效",
    sizeInvalid: "图片大小必须在 1 byte 到 10 MiB 之间",
    contentMismatch: "图片内容与 mediaType 不匹配",
    /** 预览需求附件时读远程内容失败。 */
    remoteReadFailed: "读取远程文件内容失败",
  },
  /** 文件、改动与打开位置。 */
  files: {
    skillsUnavailable: "Codex 运行时不可用，暂时无法读取 skills 目录",
    openFailed: "无法调用系统程序打开文件",
    diffNotFound: "diff 文件不存在",
    sessionNotFound: "会话不存在",
    baselineInvalid: "会话 baseline 无效",
    /** 写 `.suduo/` 前发现目标经符号链接指到项目外（会回给 Codex，也可能出现在界面的报错里）。 */
    storageDirOutsideProject: (path: string) =>
      `本机落盘目录 ${path} 指向了项目目录之外（可能是符号链接），为安全起见没有写入，请检查项目里的 .suduo 目录`,
  },
  /** 版本管理（git）。 */
  git: {
    unavailable: "本机未检测到 git，无法初始化版本管理",
    alreadyRepo: "该项目已是 git 仓库",
    notRepo: "该项目不是 git 仓库",
    hashInvalid: "提交号格式无效",
    /** stderr 是 git 自己的输出，原样附上。 */
    commandFailed: (stderr: string) => `git 操作失败：${stderr}`,
    commandFailedPlain: "git 操作失败",
  },
};
