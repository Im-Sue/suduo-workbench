---
id: ADR-0010
title: 仓库按客户端 / 云端两端拆成两个独立工作区，契约按归属拆开，品牌统一更名为 SuDuo
doc_type: adr
status: accepted
supersedes: []
superseded_by:
date: 2026-10-02
---

# ADR-0010: 仓库按两端拆分，品牌更名 SuDuo

> 一个决策一篇，记下「为什么这么定」，防止以后反复扯 / 误改
>
> **状态**：accepted ｜ **拍板人**：用户（2026-10-02：「按两端分组合理」「根目录应该只放 docs 和子系统目录」「所有的对应子系统的运行、编译、执行都需要进到对应系统目录里，独立执行」「确定 SuDuo」「除了我本机没有其他需要保留的」）

---

## 一、背景

系统一直是三套子系统：前端（`apps/web`）、客户端后端（`apps/server`，本机 BFF + Codex 会话运行时，只听 127.0.0.1）、云端服务端（`apps/requirements-service`，PostgreSQL + 附件卷，Docker 部署）。部署上是两端：前端由客户端后端托管、一起装在用户电脑上；云端单独部署在内网服务器。

旧布局看不出这一点：`server` 和 `requirements-service` 都像「服务端」；两个共享包放在根目录 `packages/`；`scripts/` 混着开发环境、客户端发行、验收三类脚本；云端部署文件在应用目录里而客户端部署文件在根目录；根目录还留着 CCB 遗留文件（`AGENTS.md`、`ccb.config`）。

品牌上，代码里一直是 ZJWork（`zjwork` / `ZJWork` / `ZJWORK`），仓库叫 `su-workbench`，代码标识符有 `Zjwork*` 与 `ZJWork*` 两种驼峰。

核实过的两端依赖（2026-10-02）：云端不依赖客户端任何东西；客户端只在代码层依赖云端的 API 契约；gate-c 用自带的假云端，不启动真云端；Windows 安装包只打客户端，Docker 镜像只构建云端；跨两端的只有本机联调脚本 `dev-local.sh`（启动两端的构建产物，不引用代码）。

## 二、决策

1. **根目录只放 `client/`、`cloud/`、`docs/`**，外加 `CLAUDE.md`（Claude Code 从仓库根读取）、`README.md`、`.gitignore` 与隐藏目录。
2. **两端各是一个独立的 pnpm 工作区**：各自的 `package.json` / `pnpm-workspace.yaml` / `pnpm-lock.yaml` / `tsconfig.base.json` / `eslint.config.js` / `mise.toml`；安装、构建、测试、运行都进到对应目录执行。
   - `client/`：`web`（前端）、`server`（客户端后端）、`contracts`（前端 ↔ 本机后端的契约）、`codex-protocol`（Codex 协议版本锁）、`scripts`（联调、安装卸载、自检、Windows 发行、gate-c 虚拟机）
   - `cloud/`：`server`（云端服务端，Dockerfile / compose 随行）、`contracts`（云端 API 契约）、`scripts`（开发用 PostgreSQL）
3. **契约按归属拆开，依赖只能从客户端指向云端**：原 `@zjwork/contracts` 的根导出与 `requirements-v2` 里只有客户端用的 `local` / `workbench` / `attachment-preview` 归 `client/contracts`；其余（账号、项目、需求、评论、附件、房间等云端 API）归 `cloud/contracts`。客户端用 pnpm `link:` 引用 `cloud/contracts`，构建时用客户端自己的 tsc 经项目引用编译它；云端的依赖里没有客户端，引用不到。
4. **品牌统一为 SuDuo**，一个词在各处的写法固定：

   | 形态 | 写法 | 例 |
   |---|---|---|
   | 显示名 | `SuDuo` | 页面标题、安装包、文案 |
   | 小写 | `suduo` | 包名 `@suduo/*`、`.suduo/`、`suduo_requirement_get`、`suduo.theme`、数据库名 |
   | 全大写 | `SUDUO` | `SUDUO_PORT`、`SUDUO_DEFAULTS` |
   | 帕斯卡 | `SuDuo` | `SuDuoApplication`、`SuDuoToolName` |
   | 驼峰 | 开头 `suDuo`，中间 `SuDuo` | `suDuoTool`、`ensureSuDuoDir` |

   两端 eslint 各加一条检查：标识符里出现 `Suduo`、`suduo` 后接大写字母，或任何旧品牌写法，都报错。
5. **不保留旧名兼容**：没有需要保住数据的真实安装（只有用户本机联调环境与 gate-c 虚拟机），环境变量、数据目录与文件名、`.suduo/`、浏览器存储键、Codex 工具名、Windows 注册表 / 快捷方式、systemd 单元、云端存储标记与数据库名一律直接改名；用户本机数据用一次性脚本迁移。唯一例外：旧工具名 `zjwork_*` 按新名认（`client/contracts` 的 `currentSuDuoToolName`，执行与时间线共用）——更名前建的 Codex 线程把工具清单存在线程里，续接后模型仍按旧名调用，不认就会全部失败；旧会话的时间线也靠它正常显示。
6. **不随品牌改的东西**：已执行过的迁移文件一个字节都不改（ADR-0001；云端执行器校验校验和，改了注释也会拒绝启动），两端各有测试锁定其哈希；旧版实际存在过的目录名（如 CODEX_HOME 里待清理的 `zjwork-*` skill）保留原名。
7. **文档全量更新**（`docs/.ccb/` 除外，它是停更的 CCB 机器层）：正文里的品牌与路径全部替换，文件名去掉品牌前缀、模块路径式文件名改成新路径；ADR 只做名称与路径的机械替换，决策内容不动。

## 三、否决的方案

| 方案 | 为什么没选 |
|------|------------|
| 保留 `apps/` + `packages/`，只把应用改名 | 根目录还是看不出两端；共享包仍在根目录 |
| 两端分组但保持一个 pnpm 工作区 | 根目录必须留工作区文件；两端不能各自独立安装构建，与「进到对应目录独立执行」相悖 |
| `contracts` 整包放 `shared/` 或放某一端 | `shared/` 违背根目录只放子系统；整包放任一端都会让另一端的专用类型住错地方 |
| 云端契约打包发布（tarball / 私有源），客户端按版本引用 | 每次改契约要打包、升级、改锁文件，两端同步开发（如房间）太重；同仓库 `link:` 已够用 |
| 保留 ZJWork，只统一写法 | 用户选择重新起名；目录改造本来就要改全部包名与路径，此时换名成本最低 |
| Sudo（速度谐音） | `sudo` 命令自带 `SUDO_*` 环境变量，与前缀冲突 |
| 显示名 `Suduo`（只一个大写） | 用户确定 `SuDuo`；代价是驼峰写法要按上表的规则，由 eslint 兜底 |
| 写旧名兼容层（读旧环境变量 / 旧目录 / 旧存储键） | 没有要保住的真实安装，兼容层只会留下长期负担 |

## 四、影响

- **好处**：目录即架构，两端边界与依赖方向由 package.json 强制；云端 Docker 构建上下文缩到 `cloud/`；品牌只有一种写法。
- **代价**：两次安装、两份锁文件，两端工具链版本以后可能各自升级；根目录没有一条命令跑全仓，质量门改为两端分别跑；安全相关的依赖版本覆盖两端都要写。
- **一次性影响**：已有安装（仅用户本机与 gate-c 虚拟机）需要迁移或重建；浏览器里的界面偏好（主题、侧栏等）会回到默认；GitHub 仓库与本地目录改名另行处理（需用户同意）。
- **不在本次范围**：「需求服务 / requirements service」这一术语不改（只改品牌部分，如 `suduo-requirements-service`）；`.claude/` 里的 CCB 钩子、`docs/.ccb/` 不动。
