/** 设置：MCP、模型服务、网络代理与试连、Skill、Codex 配置文件、设置读写的报错与提示。 */
export const config = {
  /**
   * 字段在界面上的叫法（与前端设置页 settingsConnection 里的行标题一致）：报错里不露接口字段名。
   * 句式沿用原来「字段名 + 空格 + 说明」的写法，中文结果与以前前端改写后的逐字相同。
   */
  fields: {
    proxy: {
      httpProxy: "HTTP 代理",
      httpsProxy: "HTTPS 代理",
      allProxy: "其他连接的代理",
      noProxy: "不走代理的地址",
    },
    model: {
      baseUrl: "服务地址",
      apiKey: "API Key",
      model: "默认模型",
      reasoningEffort: "默认推理强度",
      contextWindow: "上下文上限",
    },
  },
  /** 参数是字段的界面叫法（fields.*）。 */
  mustBeString: (field: string) => `${field} 必须是字符串`,
  /** Codex 没给出可写的用户配置层版本（MCP 与模型服务写配置前都要它）。 */
  userLayerVersionMissing: "Codex 未返回可写 user 配置层版本，拒绝无版本保护的写入",
  /** 网络代理（设置保存与试连共用的校验）。参数是字段的界面叫法。 */
  proxy: {
    invalidUrl: (field: string) => `${field} 不是合法代理 URL`,
    unsupportedProtocol: (field: string) => `${field} 仅支持 http / https / socks5 / socks5h`,
    hostRequired: (field: string) => `${field} 必须包含代理主机`,
    credentialsUnsupported: (field: string) => `${field} 暂不支持带用户名或密码的代理`,
    extraPartsUnsupported: (field: string) => `${field} 不能包含路径、查询参数或片段`,
    noLineBreaks: (field: string) => `${field} 不能包含换行`,
  },
  /** 试连模型服务的说明（界面按 failure 渲染；这句给日志与「复制诊断信息」）。 */
  connectivity: {
    invalidBaseUrl: "当前模型网关地址无效，无法进行连通性检查",
    invalidProxy: "当前代理环境变量无效，无法进行连通性检查",
    reached: (statusCode: number) => `已到达模型网关（HTTP ${String(statusCode)}；401/403 仅表示网关仍需 Codex 凭据）`,
    unreachable: (reason: string) => `无法连接模型网关：${reason}`,
    /** 没有网络错误码时的原因。 */
    connectionFailed: "连接失败",
  },
  /** 模型服务。参数 field 是字段的界面叫法。 */
  model: {
    nothingToUpdate: "没有提供任何要修改的字段",
    baseUrlRequiredFirstTime: "第一次配置模型服务需要填写服务地址",
    invalidUrl: (field: string) => `${field} 不是合法 URL`,
    httpOnly: (field: string) => `${field} 仅支持 http/https`,
    invalidFormat: (field: string) => `${field} 格式无效`,
    invalidModelName: (field: string) => `${field} 名称格式无效`,
    contextWindowRange: (field: string) => `${field} 必须是 4000 ~ 100000000 之间的整数（tokens）`,
    /** 密钥从哪里来（设置页「API Key」一行显示，不回传密钥本身）。 */
    keyFromCommand: (program: string) => `由本机命令提供（${program}）`,
    /** 取不到程序名时代替它。 */
    commandFallback: "命令",
    keyFromEnv: (name: string, present: boolean) => `来自环境变量 ${name}${present ? "" : "（本机服务启动时没有这个变量）"}`,
    keyManagedByCodex: "由 Codex 管理",
    /** 保存结果：被上层配置覆盖。effective 为 null 时 Codex 没给出生效值；detail 是 Codex 的原文说明。 */
    savedOverridden: (effective: string | null, detail: string | null) =>
      `已写入你的配置，但被上层配置覆盖，当前生效值仍是 ${effective ?? "上层配置"}。${detail ?? ""}`,
    saved: "已保存，Codex 已读取新配置；新配置将在下一个回合生效。",
    rollbackConflict: (original: string, rollback: string) =>
      `Codex 模型验证失败，且自动还原遇到版本冲突：${original}；还原错误：${rollback}`,
    loginFailed: (detail: string) => `Codex API Key 登录失败：${detail}`,
  },
  /** MCP 服务器。 */
  mcp: {
    created: "已通过 Codex 官方接口新增并重载 MCP 服务器。",
    updatedAtomically: "已通过 Codex config/batchWrite 原子更新并重载 MCP 服务器。",
    updatedNonAtomically: "已用 Codex CLI 非原子替换；若后续步骤失败，请按原配置重建服务器。",
    atomicUpdateFailed: (detail: string) => `Codex MCP 原子更新失败：${detail}`,
    cliCannotExpress: "Codex RPC 不可用，且本次修改含 CLI 无法安全表达的字段；未执行非原子替换。",
    /** returnedInvalidJson 的说明对象。 */
    listLabel: "Codex MCP 列表",
    detailLabel: "Codex MCP 详情",
    returnedInvalidJson: (label: string) => `${label} 返回了无效 JSON`,
    listNotArray: "Codex MCP 列表返回了无效 JSON",
    detailNameMismatch: "Codex MCP 详情名称不匹配",
    statusPagesUnfinished: "Codex MCP 状态分页未结束",
    createCleanupFailed: "MCP 新增后的官方配置写入失败，且自动清理失败；请检查 Codex 配置后手动删除该服务器。",
    createCleanedUp: (detail: string) => `MCP 新增后的官方配置写入失败，已自动清理：${detail}`,
    commandTimedOut: "Codex MCP 命令执行超时",
    commandOutputTooLarge: "Codex MCP 命令输出超过安全上限",
    commandFailed: (detail: string) => `Codex MCP 命令失败：${detail}`,
    createBodyInvalid: "MCP 新增请求必须是 JSON object",
    updateBodyInvalid: "MCP 编辑请求必须是 JSON object",
    nothingToUpdate: "没有提供任何要修改的 MCP 字段",
    transportNotObject: "transport 必须是 JSON object",
    transportTypeInvalid: "transport.type 仅允许 stdio 或 http",
    httpNoEnvVars: "HTTP MCP 服务器不支持 envVars",
    configMissingTransport: "Codex MCP 配置缺少传输字段",
    entryNotObject: "Codex MCP 返回项不是 object",
    entryMissingTransport: "Codex MCP 返回项缺少 transport",
    entryMissingEnabled: "Codex MCP 返回项缺少 enabled",
    unknownTransport: "Codex MCP 返回了未知 transport",
    /** label 是协议字段名（如 Codex MCP command），不翻译。 */
    protocolFieldInvalid: (label: string) => `${label} 无效`,
    nameInvalid: "MCP 名称仅允许字母开头的字母、数字、下划线或连字符（最多 64 位）",
    commandInvalid: "MCP stdio command 格式无效",
    argsInvalid: "MCP args 必须是不超过 64 项的字符串数组",
    argInvalid: "MCP args 含有无效字符串",
    secretInArgs: "敏感值必须来自系统环境变量；stdio 参数不能传 token/key/password/secret",
    urlInvalid: "MCP HTTP URL 格式无效",
    urlUnsupported: "MCP HTTP URL 仅支持无凭据的 http/https 地址",
    envVarsInvalid: "envVars 必须是不超过 32 项的环境变量名数组",
    envVarInvalid: "环境变量必须是合法变量名，不能传入变量值",
    scopesInvalid: "scopes 必须是不超过 32 项的字符串数组",
    scopeInvalid: "OAuth scope 格式无效",
    /** field 是接口字段名（enabled、startupTimeoutSeconds 等）。 */
    mustBeBoolean: (field: string) => `${field} 必须是 boolean`,
    timeoutInvalid: (field: string) => `${field} 必须是 1~86400 的整数秒数`,
    serverNotFound: (name: string) => `Codex MCP 服务器不存在：${name}`,
  },
  /** 全局 Skill 的安装与卸载。 */
  skill: {
    zipEmptyContent: "zip 内容不能为空",
    zipTooLarge: "zip 超过 30 MiB 上限",
    zipCorrupted: "zip 解压失败，文件可能损坏",
    zipEmpty: "zip 为空",
    zipTooManyFiles: "zip 文件数超过 2000 上限",
    unpackedTooLarge: "解压后超过 50 MiB 上限",
    zipMissingSkillFile: "zip 必须在根目录或唯一顶层目录内包含 SKILL.md",
    folderRequired: "必须提供文件夹路径",
    folderNotFound: (path: string) => `文件夹不存在：${path}`,
    folderMissingSkillFile: "该文件夹内没有 SKILL.md",
    alreadyExists: (name: string) => `全局已存在同名 skill「${name}」，确认后可覆盖更新`,
    notRecognized: "安装后未识别到有效 SKILL.md",
    pathRequired: "必须提供 skill 路径",
    outsideGlobalRoot: "只允许管理全局 skills 目录内的 skill",
    zipUnsafePath: (path: string) => `zip 含非法路径：${path}`,
    zipEntryEscapes: "zip 条目越出安装目录",
    nameUnresolvable: "无法从来源推断合法的 skill 名称",
  },
  /** 本机设置读写。field 是接口字段名。 */
  settings: {
    mustBeBoolean: (field: string) => `${field} 必须是布尔值`,
    globalSkillsLocked: "globalSkills 已被环境变量 SUDUO_GLOBAL_SKILLS 锁定",
    approvalModeInvalid: "defaultApprovalMode 仅允许 ask / auto / full",
  },
  /** 「关于」里直接打开 Codex 配置文件。 */
  configFile: {
    onlyCurrentHome: "只能打开当前 CODEX_HOME 的 config.toml",
    missing: "Codex 配置文件不存在，无法打开",
    openFailed: "无法用系统编辑器打开 Codex 配置文件",
  },
};
