# SuDuo Windows 安装器验证手册

> 内部试点版尚未代码签名。Windows SmartScreen 可能显示“Windows 已保护你的电脑”：核对安装包文件名和 SHA256 后，点击“更多信息”→“仍要运行”。仅使用试点负责人分发的安装包。

## 形态说明（本版重设计）

安装 = 纯放文件：解压到 `%LOCALAPPDATA%\SuDuo`、创建快捷方式、登记卸载项，**不改 ACL、不注册计划任务、不碰剪贴板**。运行 = 按需启动：快捷方式用内置 `node.exe` 运行启动器 `installer\launcher.mjs`，启动器确认/拉起本机服务后带令牌打开浏览器（自动登录）；服务在无页面且 30 分钟无活动后自动退出。一切可变状态（SQLite、令牌、Codex 配置与登录态）都在 `data\`，升级覆盖安装不受影响。

## 杀软提示说明

SuDuo 是未签名的内部试点软件，火绒、360、腾讯电脑管家等仍可能因安装器信誉不足或释放本地运行时而提示风险。持久物零 shell 包装：快捷方式直接运行内置 `node.exe`，安装包内不携带 PowerShell/cmd/wscript 脚本，也不再注册任何计划任务。

如被拦截：

1. 先停止安装并核对分发人、文件名及 SHA256，不核对一致性时不要放行。
2. 确认一致后，在杀软隔离区恢复该文件并仅对白名单中的安装包 SHA/`%LOCALAPPDATA%\SuDuo` 放行；不要长期关闭实时防护。
3. 记录杀软名称、病毒名、被拦截文件路径、安装包 SHA256 和截图，交试点负责人统一向厂商提交误报申诉。
4. 试点铺开建议由 IT 统一下发精确白名单；正式推广前应采购代码签名证书并给 setup.exe/后续原生程序签名。

## 验证状态

- WSL2 已验：setup.exe 构建、离线缓存/SHA256、PE x64 资产、零 shell 持久物静态测试、ICO/favicon、bundled server 启动 smoke（`/healthz` 契约）、首启自举功能测试（令牌自动生成、defaults 补配置、令牌换会话、优雅停机、空闲自停）、typecheck/lint/test。
- 待真 Windows 验证：启动器首启/二次启动、Edge 应用窗口与任务栏图标、无 Edge 的默认浏览器兜底、杀软扫描、安装器 GUI、从旧版（计划任务版）升级迁移、`codex.exe` 真实 turn、better-sqlite3 Windows addon、NTFS/跨盘 watcher、重启后按需启动恢复会话、控制面板卸载。

## 1. 安装前

1. 确认试点机为 Windows 10/11 x64。
2. 不需要安装 Node、pnpm、Codex、SQLite 或 WSL。
3. 按分发通知核对 `SuDuo-Setup-<version>.exe` 的 SHA256。
4. 如 SmartScreen 拦截，按文首说明选择“仍要运行”。

## 2. 双击安装与首次启动

1. 双击 setup.exe，完成页保持“立即打开 SuDuo”勾选。
2. 预期出现一个短暂的控制台窗口（显示“正在检查/启动 SuDuo 服务…”），随后浏览器打开工作台并**自动登录**（无需粘贴令牌），控制台窗口自动关闭。
3. 若启动失败，控制台窗口会保留中文错误和日志路径，不会无声消失。

检查点：

- `%LOCALAPPDATA%\SuDuo` 中存在 `runtime/app/config/data/defaults/assets/installer`；
- 桌面/开始菜单 `SuDuo.lnk` 目标为 `%LOCALAPPDATA%\SuDuo\runtime\node.exe`，参数为 `installer\launcher.mjs`，图标为 `assets\suduo.ico`；不应出现 PowerShell/cmd/wscript；
- `SuDuo 自检.lnk` 参数为 `installer\launcher.mjs --doctor`；
- 有 Edge 时浏览器为独立应用窗口（无地址栏、独立任务栏图标），无 Edge 时用默认浏览器打开，功能一致；
- 地址栏/历史中不应残留 `?token=`（进入页面后被立即清除）；
- `data\access-token` 由服务首启自动生成；`data\codex\` 内有 `config.toml`（内部版另有 `auth.json`）；
- “设置→应用→已安装的应用”/控制面板可见 SuDuo；
- **任务计划程序中不存在 `SuDuo` 任务**（从旧版升级的机器：原任务应被删除）。

从旧版（计划任务常驻版）升级的机器，额外确认：

- 安装过程不再出现“运行时初始化失败（代码 1）”一类中断；
- 旧 `config\codex` 已迁移到 `data\codex`（含此前被 ACL 锁死的文件，安装器会先 `icacls /reset` 修复再迁移）；
- 会话数据、事件账本与访问令牌保留。

## 3. doctor

从开始菜单打开“SuDuo 自检”：服务可用时浏览器进入 `/doctor` 页面；服务起不来时启动器改为在控制台运行命令行自检并保留窗口。预期通过：

- 内置 Node `24.10.0`；
- 内置 Codex `0.159.2`；
- 公司模型配置可用；
- access-token ACL 没有对 Everyone/Users/Authenticated Users 开放（`%LOCALAPPDATA%` 默认继承权限即满足）；
- better-sqlite3 Windows x64 addon 可加载，migration/WAL 读写正常；
- `127.0.0.1:8787` 服务正在运行。

如“模型配置”失败，说明拿到的是不含 key 模板版，联系试点负责人更换内部分发版；不要自行填写密钥。

## 4. 真实 turn 与审批

1. 添加一个本机临时项目文件夹，新建会话。
2. 发送“只回复 Windows turn ok”，预期流式输出并转为“完成”。
3. 发送会触发文件写入的任务，对一次审批选“拒绝”，对另一次选“批准一次”。
4. 预期 accept/decline 都有历史，文件 diff 与蓝点可见。

## 5. 关浏览器后后台跑

1. 发送一个运行超过 20 秒的任务，看到“后台运行”提示后关闭浏览器。
2. 等待后双击桌面 SuDuo，预期 SSE `after=seq` 补齐进度，无丢失/重复（任务进行中服务不会因空闲退出：runtime 事件计入活跃）。
3. 在任务管理器结束内置 `node.exe` 后再双击 SuDuo，预期启动器重新拉起服务并恢复会话（新形态没有崩溃自动拉起，恢复动作发生在下次点击时）。

## 6. watcher、空闲退出与重启

1. 分别对 `C:`/可选 `D:` 项目外部修改文件，确认目录树更新。
2. 关闭所有 SuDuo 页面并保持无操作 30 分钟以上，预期 `node.exe` 自动退出（任务管理器确认）；再次双击 SuDuo 可正常拉起并看到原会话。
3. 重启 Windows 并登录：登录后**不应**有 SuDuo 进程自动运行；双击 SuDuo，预期原会话、事件与文件改动仍在，可继续新 turn。

## 7. 卸载

1. 从 Windows “已安装的应用”/控制面板卸载 SuDuo（卸载器会先请求服务优雅退出，再按 pid 兜底）。
2. 首次选择“保留会话数据”，预期快捷方式、应用与内置运行时被删除，`%LOCALAPPDATA%\SuDuo\data`（含令牌与 Codex 配置）保留。
3. 重装后再卸载，选择不保留数据，预期 `%LOCALAPPDATA%\SuDuo` 完全删除。

## 8. 回报模板

- Windows 版本/CPU：
- setup.exe 版本/SHA256：
- SmartScreen：PASS/FAIL
- 火绒/360/腾讯扫描（产品+病毒名+文件路径）：PASS/FAIL
- 启动器首启（控制台→浏览器自动登录）：PASS/FAIL
- Edge 应用窗口/无 Edge 默认浏览器兜底（注明实际分支）：PASS/FAIL
- 快捷方式目标、参数和 SuDuo 图标：PASS/FAIL
- 持久物零 shell 包装 + 无计划任务：PASS/FAIL
- 旧版升级迁移（config→data、任务删除、数据保留）：PASS/FAIL（全新机器填 N/A）
- doctor（含 codex.exe/addon/ACL）：PASS/FAIL
- 真实 turn + accept/decline：PASS/FAIL
- 关页后台跑 + 手杀后点击拉起恢复：PASS/FAIL
- NTFS/跨盘 watcher：PASS/FAIL
- 空闲 30 分钟自动退出 + 重启后按需启动：PASS/FAIL
- 卸载保留/清除数据：PASS/FAIL
- 失败步骤的完整脱敏错误与截图：
