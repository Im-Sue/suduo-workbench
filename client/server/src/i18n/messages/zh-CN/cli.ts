/**
 * 本机服务启动阶段的输出与报错（中英双语 S8）。启动时没有请求，按系统语言取字典：
 * `messagesFor(cliLocale(process.env))`，在用到时取，不在模块加载时固定。
 * 多是给运维 / 开发者看的配置报错；环境变量名、路径、命令、版本号原样。
 */
export const cli = {
  /** 入口（main.ts）的环境变量校验，不合法就退出。 */
  hostMustBeLoopback: "SUDUO_HOST 必须严格为 127.0.0.1",
  transportStdioOnly: "M1 的 SUDUO_CODEX_TRANSPORT 仅允许 stdio",
  /** name 是环境变量名。 */
  integerOutOfRange: (name: string, minimum: number, maximum: number) =>
    `${name} 必须是 ${String(minimum)} 到 ${String(maximum)} 的整数`,
  /** 入口只提醒、不退出的两条；调用方在前面加「SuDuo: 」、末尾加换行。 */
  codexVersionMismatch: (configured: string, pinned: string) =>
    `安装配置里的 SUDUO_CODEX_VERSION=${configured} 与锁定的 Codex ${pinned} 不一致；重新运行安装（pnpm install:m1）即可更新。`,
  codexHomeMissing: (path: string) =>
    `CODEX_HOME 指向的目录不存在：${path}。Codex 会无法启动；请检查 SUDUO_CODEX_HOME / CODEX_HOME，或删掉这个设置改用默认的 ~/.codex。`,
  /** 安装版的运行配置文件（--runtime-config）；key 是环境变量名。 */
  runtimeConfigPathRequired: "--runtime-config 必须提供配置文件路径",
  runtimeConfigKeyNotAllowed: (key: string) => `runtime config 包含不允许的环境项: ${key}`,
  runtimeConfigNotObject: "runtime config 必须是 JSON object",
  runtimeConfigSchemaVersion: "runtime config schemaVersion 必须为 1",
  runtimeConfigEnvironmentNotObject: "runtime config environment 必须是 object",
  runtimeConfigValueNotString: (key: string) => `runtime config 环境项必须是非空字符串: ${key}`,
  runtimeConfigPathNotRelative: (key: string) => `${key} 必须是相对安装目录的路径`,
  runtimeConfigPathOutsideInstall: (key: string) => `${key} 不得越出安装目录`,
  /** 找不到 workspace 锁定版本的 Codex；version 是锁定的版本号。 */
  pinnedCodexNotFound: (version: string) =>
    `未找到 workspace 锁定的 Codex ${version}；请通过绝对或相对路径设置 SUDUO_CODEX_BIN`,
  /** 本机数据库：原生适配器加载失败、库里有旧版本的迁移记录。 */
  databaseAdapterLoadFailed: "无法加载 better-sqlite3 原生适配器；请确认 Node 版本与平台预构建包匹配，并重新执行 pnpm install。",
  legacyMigrations: (versions: readonly number[]) =>
    `检测到旧数据库迁移版本 [${versions.join(", ")}]；按 D4 删除本机数据库后重建。`,
  /** 部署侧审批上限（运行时读环境变量时才校验）。 */
  maxApprovalModeInvalid: "SUDUO_MAX_APPROVAL_MODE 仅支持 ask / auto / full",
  /**
   * 需求服务地址与本机配置文件。启动时由 SUDUO_REQUIREMENTS_SERVICE_URL 写入或读到坏文件时出现；
   * 界面改地址时由需求服务的设置接口换成按请求语言的说明（remote.validation）。
   */
  requirementsSettingsInvalid: "V2 本机远程服务配置格式无效",
  serverAddressEmpty: "远程服务地址不能为空",
  serverAddressNotUrl: "远程服务地址不是有效 URL",
  serverAddressProtocol: "远程服务地址仅支持 http 或 https",
  serverAddressCredentials: "远程服务地址不允许包含用户名或密码",
  serverAddressOriginOnly: "远程服务地址只能是协议、主机和可选端口",
  privateJsonUnreadable: "V2 本机配置文件无法读取或解析",
};
