/** 自检：检查项的名称、结论与处理建议，以及 /doctor 纯文本页。 */
export const doctor = {
  /** 检查项名称（Node.js、pnpm、Codex CLI、better-sqlite3 是产品名，不进字典）。 */
  names: {
    codexDoctor: "Codex 官方诊断",
    linuxSandbox: "Codex 沙箱（Linux）",
    port: "监听端口",
    toolServer: "SuDuo 本机工具服务",
  },
  /** 版本锁定检查（Node.js、pnpm）。actual 为 null 表示命令不可用。 */
  version: {
    pinned: (actual: string) => `${actual}（已锁定）`,
    mismatch: (expected: string, actual: string | null) => `需要 ${expected}，当前为 ${actual ?? "不可用"}`,
    /** Node.js 只要求同一大版本、不低于最低版本（与 package.json 的 engines 一致）。 */
    supported: (actual: string, minimum: string) => `${actual}（要求 ${minimum.split(".")[0] ?? minimum}.x、不低于 ${minimum}）`,
    belowMinimum: (minimum: string, actual: string) =>
      `需要 ${minimum.split(".")[0] ?? minimum}.x、不低于 ${minimum}，当前为 ${actual}`,
  },
  /** Windows 上只确认命令能跑（输出编码不可靠，不比对版本）。 */
  command: {
    windowsOk: (expected: string, output: string) => `命令可执行（项目锁定 ${expected}）；输出仅供诊断：${output}`,
    windowsFailed: (status: string, stderr: string) => `命令执行失败 status=${status}；stderr：${stderr}`,
  },
  /** Codex 官方诊断（codex doctor --json）与 Codex CLI 版本。 */
  codex: {
    invalidJson: (detail: string) => `codex doctor --json 返回无效 JSON：${detail}`,
    runFailed: (status: string, stderr: string) => `codex doctor --json 执行失败 status=${status}；stderr：${stderr}`,
    /** 解析官方 JSON 时的问题（拼在 invalidJson 里）；label、field 是协议里的名字。 */
    mustBeObject: (label: string) => `${label} 必须是 object`,
    missingField: (field: string) => `codex doctor --json 缺少 ${field}`,
    noSummary: "未提供摘要",
    noChecks: (overallStatus: string) => `codex doctor --json 未返回任何检查项（overallStatus=${overallStatus}）`,
    cliPinned: (version: string) => `codex-cli ${version}（workspace 锁定版本）`,
    /** actual 为 null：官方诊断没报版本。 */
    cliMismatch: (expected: string, actual: string | null) => `需要 codex-cli ${expected}，当前为 ${actual ?? "未知"}`,
  },
  /** Linux 上 Codex 的沙箱（bubblewrap）。docs 是 OpenAI 的沙箱说明链接。 */
  sandbox: {
    readySystem: (path: string) => `沙箱可用，使用系统的 bubblewrap（${path}）`,
    readyBundled: "沙箱可用，但用的是 Codex 自带的 bubblewrap；官方建议安装系统的 bubblewrap",
    readyBundledRemediation: (docs: string) => `sudo apt install bubblewrap（Fedora：sudo dnf install bubblewrap）。详见 ${docs}`,
    timedOut: (seconds: number) => `沙箱命令 ${String(seconds)} 秒内没有结束，没能确认沙箱是否可用`,
    timedOutRemediation: "稍后在诊断页重新检查；一直这样时，在终端里运行 codex sandbox -P :workspace -- true 看看卡在哪里",
    /** stderr 没有内容时代替原因。 */
    exitCode: (status: string) => `退出码 ${status}`,
    notRun: (detail: string) => `没能运行 Codex 的沙箱命令，无法确认沙箱是否可用（${detail}）`,
    notRunRemediation: "先处理上面「Codex 官方诊断」「Codex CLI」里的问题，再回来重新检查",
    causes: {
      container: "SuDuo 跑在容器里，容器默认不允许创建用户命名空间",
      noSystemBwrap: "没有安装系统的 bubblewrap",
      apparmorRestricted: "系统用 AppArmor 限制了非特权用户命名空间（Ubuntu 24.04 默认如此）",
    },
    steps: {
      container:
        "让容器允许创建用户命名空间（例如 Docker 加 --security-opt seccomp=unconfined --security-opt apparmor=unconfined），或把 SuDuo 装在宿主机上",
      installBwrap: "sudo apt install bubblewrap（Fedora：sudo dnf install bubblewrap）",
      loadApparmorProfile: (command: string) => `加载官方的 AppArmor 放行配置：${command}`,
      reinstallService: "SuDuo 是作为系统服务在跑：重新运行安装（pnpm install:m1）更新服务配置后重启服务",
    },
    unavailable: (causes: readonly string[], detail: string) =>
      "Codex 的沙箱在这台机器上起不来，需要审批或受限执行的命令都会失败" +
      (causes.length > 0 ? `：${causes.join("；")}` : "") +
      `（${detail}）`,
    /** loosen：可以退一步放开 AppArmor 限制（不在容器里且确实被限制时）。 */
    remediation: (steps: readonly string[], docs: string, loosen: boolean) =>
      (steps.length > 0 ? steps.join("；然后 ") + "。" : "") +
      `按 OpenAI 的沙箱前置条件处理：${docs}` +
      (loosen ? "；若仍不行，可退一步放开限制：sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0" : ""),
  },
  sqlite: {
    ok: "原生 addon 可加载，临时库 migration/WAL 写读正常",
  },
  /** address 形如 127.0.0.1:8787。 */
  port: {
    available: (address: string) => `${address} 可用`,
    inUseBySuDuo: (address: string) => `${address} 已占用（服务正在运行）`,
    inUseByOther: (address: string) => `${address} 已被其他程序占用`,
  },
  /** 各家 Agent（多 Agent S12）：一家一项，几句说明用「；」连起来。 */
  agent: {
    separator: "；",
    ready: (version: string | null) => (version === null ? "可用（版本没读到）" : `可用，版本 ${version}`),
    installed: (version: string | null) =>
      `${version === null ? "已安装（版本没读到）" : `已安装，版本 ${version}`}，登录状态第一次用时确认`,
    checkTimeout: "已安装，读版本超时（首次运行常见），照样能用",
    authRequired: (version: string | null) => `${version === null ? "" : `版本 ${version}，`}需要登录`,
    notInstalledDefault: "没找到可执行文件（它是默认的 Agent，开工会选不上）",
    versionUnsupported: (version: string, minimum: string) => `版本 ${version} 低于最低要求 ${minimum}`,
    checking: "还在检测，稍后重新检测",
    error: (detail: string) => `检测出错：${detail}`,
    unverified: (version: string, verified: string) => `版本 ${version} 不在 SuDuo 验证过的范围（${verified}）里，一般也能用；遇到问题先换到验证过的版本`,
    path: (path: string) => `位置 ${path}`,
    loginRemediation: (command: string) => `在终端里执行 ${command} 登录（SuDuo 不读、不存你的凭据）`,
    installRemediation: (url: string) => `按官方说明安装：${url}；或在设置「AI Agent」里换一个默认 Agent`,
  },
  toolServer: {
    listening: (url: string) => `在 ${url}（Codex 以外的 Agent 经它用需求、会话、委派等工具）`,
    notListening: "还没开始监听：Codex 以外的 Agent 暂时拿不到 SuDuo 的工具",
  },
  /** /doctor 页面（不开设置页时用浏览器直接看）。 */
  page: {
    title: "SuDuo 自检",
    heading: "本机环境自检",
    checkedAt: (time: string) => `检查时间 ${time}`,
    remediation: (text: string) => `官方修复建议：${text}`,
    copy: "复制诊断信息",
    copied: "诊断信息已复制",
  },
  /** 命令行 `pnpm run doctor`（scripts/doctor.ts）：结论与参数报错。 */
  cli: {
    passed: "自检通过，可以启动 SuDuo。",
    failed: "自检未通过。请先修复上述问题；不会带病启动服务。",
    invalidPort: "--port 必须是 1 到 65535 的整数",
  },
};
