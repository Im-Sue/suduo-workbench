/** 设置里与 Codex 怎么干活有关的分组：MCP 服务、Skills、执行与安全，以及本机的通知、外观。 */
export const settingsAgent = {
  mcp: {
    description: "MCP 服务给 Codex 接上外部工具（数据库、设计稿、内部系统等）。配置保存在这台电脑的 Codex 里。",
    addServer: "添加服务",
    /** 启动状态。unknown：列表里拿不到连接信息，可能没启动成功，也可能还没启动。 */
    startup: {
      unknown: "未确认连接",
      starting: "正在连接",
      ready: "已连接",
      failed: "没有连上",
      cancelled: "已取消",
    },
    auth: {
      notLoggedIn: "未登录",
      bearerToken: "已用令牌登录",
      oAuth: "已登录",
      unknown: "登录状态未知",
    },
    disabled: "已停用",
    transport: {
      stdio: "本机命令",
      http: "远程服务",
    },
    toolCount: (count: number) => `${String(count)} 个工具`,
    test: {
      title: "连接测试",
      description: "让 Codex 重新连接全部 MCP 服务，并刷新下面的状态。",
      statusUnavailable: "暂时读不到 Codex 的运行状态。",
      statusUnavailableSuggestion: "稍后再试；如果一直这样，到「诊断」里看看 Codex 是否正常。",
      noServers: "还没有配置 MCP 服务",
      noneEnabled: "没有启用的 MCP 服务",
      allConnected: (count: number, elapsed: string) => `启用的 ${String(count)} 个服务都已连接 · ${elapsed}`,
      troubled: (names: readonly string[]) =>
        `${String(names.length)} 个服务没有连上：${names.map((name) => `「${name}」`).join("、")}`,
      troubledSuggestion: "在下面对应的服务上点「查看原因」。",
    },
    list: {
      title: "已配置的服务",
      label: "MCP 服务",
      statusUnavailable: "暂时读不到 Codex 的运行状态，下面是本机已知的配置，连接状态显示为「未确认」。",
      loading: "正在读取 MCP 服务",
      loadFailed: (message: string) => `没能读取 MCP 服务：${message}`,
      emptyTitle: "还没有配置 MCP 服务",
      emptyDescription: "添加后可以在这里测试连接、登录。",
      diagnose: "查看原因",
      signIn: "登录",
      signInFailed: "没能开始登录",
      /** 内网没有浏览器的机器上，把地址交给用户自己打开。 */
      signInUrl: (url: string) => `如果浏览器没有自动打开，请复制这个地址完成登录：${url}`,
      enable: (name: string) => `启用 ${name}`,
      moreActions: (name: string) => `「${name}」的更多操作`,
      edit: "编辑",
      signOut: "退出登录",
      signOutFailed: "没能退出登录",
      remove: "删除",
      removeFailed: "没能删除",
    },
    /** 展开「查看原因」后的详情。有官方原文就显示原文；Codex 没给时如实说没有，不编造原因。 */
    detail: {
      noReason: "Codex 没有提供这个服务的连接详情。检查启动命令或服务地址后，点「测试连接」重新连接。",
      command: (command: string) => `启动命令：${command}`,
      url: (url: string) => `服务地址：${url}`,
      envVars: (names: readonly string[]) => `需要的环境变量：${names.join("、")}（值由系统环境提供）`,
    },
    removeConfirm: {
      title: (name: string) => `删除「${name}」？`,
      description: "删除后 Codex 不能再使用这个服务的工具，需要重新添加才能恢复。",
      confirm: "删除",
    },
    form: {
      addTitle: "添加 MCP 服务",
      editTitle: (name: string) => `编辑「${name}」`,
      description: "Codex 会按这里的配置启动或连接服务。",
      transport: "连接方式",
      transportChange: "改连接方式时，Codex 会先删掉原配置再按新配置添加。",
      name: "名称",
      nameHint: "以字母开头，只用字母、数字、- 或 _，例如 design-files。",
      nameRequired: "请填写名称",
      nameInvalid: "以字母开头，只用字母、数字、- 或 _",
      command: "启动命令",
      commandRequired: "请填写启动命令",
      args: "参数",
      argsHint: '用空格分隔，可以留空；含空格的参数用引号括起来，例如 --root "/Users/me/My Projects"。',
      argsUnclosedQuote: "引号没有配对，检查一下参数",
      envVars: "需要的环境变量名",
      envVarsHint: "用逗号或空格分隔。",
      url: "服务地址",
      urlProtocol: "地址要以 http:// 或 https:// 开头",
      urlInvalid: "请填写有效的服务地址",
      bearerEnv: "令牌所在的环境变量名",
      bearerEnvHint: "可以留空：需要登录的服务，添加后在列表里点「登录」。",
      secretsNote:
        "只填变量名，不要填值。值由启动 SuDuo 时的系统环境提供（例如本机服务的环境配置文件）。Codex 目前不能代为保管密钥，所以需要密钥的服务暂时不能在界面里填写密钥。",
      cancel: "取消",
      add: "添加",
      save: "保存",
    },
  },
  skills: {
    description: "Skill 是给 Codex 的做事说明。可用的越多，每条说明能分到的篇幅越少——停用不常用的，常用的会被理解得更准。",
    /** Skill 的来源：user=个人目录 / repo=项目内 / system=内置 / admin=管控；不认识的显示 scopeOther。 */
    scope: {
      user: "个人",
      repo: "项目",
      system: "内置",
      admin: "管理员",
    },
    scopeOther: "其他",
    global: {
      title: "使用个人 Skills 目录",
      description: "关闭后，只使用项目里自带的 Skills。",
      folder: (path: string) => `目录：${path}`,
      locked: "管理员已固定这个开关。需要调整时请联系管理员。",
    },
    project: {
      title: "查看的项目",
      description: "不同项目能用的 Skills 和启用状态可能不同。",
      emptyTitle: "还没有关联代码目录，只能看到已安装的 Skills",
      emptyAction: "去关联",
      placeholder: "选择项目",
    },
    install: {
      title: "安装 Skill",
      description: "填写本机上 Skill 文件夹的完整路径。",
      pathRequired: "先填写 Skill 文件夹的完整路径",
      submit: "安装",
      stillWorking: "仍在处理…",
      failed: "没能安装",
    },
    list: {
      title: "已安装的 Skills",
      projectRequired: "选择项目后，这里会显示每个 Skill 的来源和启用开关。",
      catalogUnavailable: "暂时读不到这个项目的启用状态，下面只列出已安装的 Skills。",
      loading: "正在读取 Skills",
      loadFailed: (message: string) => `没能读取 Skills：${message}`,
      emptyTitle: "还没有安装任何 Skill",
      emptyDescription: "可以从本机的 Skill 文件夹安装。",
      emptyAction: "安装 Skill",
      version: (version: string) => `版本 ${version}`,
      noDescription: "没有说明",
      enable: (name: string) => `启用 ${name}`,
      toggleFailed: "未能保存",
      uninstall: "卸载",
      uninstallFailed: "没能卸载",
    },
    uninstallConfirm: {
      title: (name: string) => `卸载「${name}」？`,
      description: "卸载会删除这个 Skill 的文件夹，之后需要重新安装才能使用。",
      confirm: "卸载",
    },
  },
  execution: {
    description: "新会话默认用哪种方式确认 Codex 的操作。",
    descriptionWithSessionNote: "新会话默认用哪种方式确认 Codex 的操作。每个会话都可以在输入框下方单独调整。",
    loading: "正在读取执行与安全设置",
    loadFailed: (message: string) => `没能读取本机设置：${message}`,
    /** 审批档的用户词表（需求 §5.1）。 */
    modes: {
      ask: {
        label: "每步确认",
        description: "运行命令、修改文件前都先问你。最稳妥，也最常被打断。",
      },
      auto: {
        label: "越界时确认",
        description: "在代码目录内读写、运行常规命令时直接执行；联网、访问目录外的文件时问你。",
      },
      full: {
        label: "完全访问",
        description: "不再询问，命令与网络全部放行。只在你完全信任当前任务时使用，切换时会再确认一次。",
      },
    },
    approval: {
      title: "新会话默认确认方式",
      recommended: "推荐",
      blocked: "管理员已限制，不可选",
      blockedBadge: "已限制",
      lockReason: (label: string) => `管理员已限制最高权限为「${label}」，更高的选项不可用。需要时请联系管理员。`,
    },
    /** 三种方式的实际权限：让人看清「选了会发生什么」。 */
    matrix: {
      label: "三种方式的实际权限",
      mode: "方式",
      files: "文件",
      network: "联网",
      rows: {
        ask: { files: "只读，写入前问你", network: "不允许" },
        auto: { files: "代码目录内可写", network: "不允许" },
        full: { files: "不受限制", network: "允许" },
      },
    },
    fullAccess: {
      title: "会话可切换到完全访问",
      description: "决定会话里能不能把确认方式切到「完全访问」。",
      allowed: "可以",
      blocked: "不可以（管理员已限制）",
    },
    checkpoint: {
      title: "回合前自动存档",
      description: "项目启用版本管理时，默认在每个回合开始前存一个检查点，改坏了可以回到开始前。",
    },
    fullConfirm: {
      title: "默认使用完全访问？",
      description: "新会话将不再询问，命令与网络全部放行。只在完全信任的代码目录里使用。",
      confirm: "设为完全访问",
    },
  },
  notifications: {
    description: "只影响这台电脑上的这个浏览器。",
    system: {
      title: "系统通知",
      description: "会话在后台完成、失败或等你确认时，用系统通知提醒你。标签页标题上的提醒始终开启。",
    },
    status: {
      requesting: "正在等你在浏览器里允许…",
      off: "已关闭",
      on: "已开启",
      blocked: "已开启，但浏览器阻止了通知",
      notGranted: "已开启，还没得到浏览器授权",
    },
    sample: {
      button: "发一条试试",
      title: "SuDuo 通知已开启",
      body: "会话需要你时，会像这样提醒你。",
      failed: "这个浏览器不允许页面直接发通知，标签页标题的提醒仍然有效。",
    },
    unsupported: "这个浏览器不支持系统通知，标签页标题上的提醒仍然有效。",
    blocked: {
      title: "浏览器阻止了 SuDuo 的通知",
      body: "点地址栏左侧的站点图标，把「通知」改为「允许」，回到这里就会生效。不想要系统通知的话，关掉上面的开关即可。",
    },
    requestPermission: "向浏览器申请通知权限",
  },
  appearance: {
    description: "改动立即生效，只影响这台电脑。",
    theme: {
      title: "主题",
      description: "跟随系统时，会随电脑的深浅色设置自动切换。",
      light: "浅色",
      dark: "深色",
      system: "跟随系统",
      systemRecommended: "跟随系统（推荐）",
      recommended: "推荐",
    },
    density: {
      title: "界面密度",
      description: "紧凑时列表和控件更矮，一屏能看到更多内容。",
      comfortable: "舒适",
      compact: "紧凑",
    },
    /** 选项名用 common.localeOption（各语言按自己的写法显示）。 */
    locale: {
      title: "语言",
      description: "选「跟随系统」时，浏览器语言是中文就显示中文，其他语言显示英文。",
      /** 这一页上有切换后带不过去的东西（打开的对话框、没保存的编辑）时，先问一句。 */
      confirm: {
        title: "切换语言？",
        body: "界面会按新语言重新载入，这一页上打开的对话框和还没保存的编辑会丢失；正在发送的消息，结果可能需要你核对。输入框里的草稿和排队的消息会保留。",
        action: "切换语言",
      },
      /** 别的标签页改了语言、这个标签页还有带不过去的东西时，不打断的提示；language 是新语言的名字。 */
      otherTab: {
        message: (language: string) =>
          `另一个标签页把语言改成了 ${language}。这里还有打开的对话框、没保存的编辑或正在发送的内容，处理完后会自动切换。`,
        switchNow: "现在切换",
      },
    },
  },
};
