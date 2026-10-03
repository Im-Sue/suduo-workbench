---
id: two-ends-and-suduo-design-001
title: 两端目录拆分与品牌更名 SuDuo 技术设计
doc_type: technical_design
requirement_id: ADR-0010
expression_spec: v1
updated: 2026-10-02
---

# 两端目录拆分与品牌更名 SuDuo 技术设计

> 一句话：仓库按客户端 / 云端拆成两个独立 pnpm 工作区，契约按归属拆成两包，ZJWork 全量更名为 SuDuo；分六步提交，每步可单独构建、测试、回退。｜最后更新：2026-10-02
>
> 决策与理由见 [ADR-0010](../06_决策记录/ADR-0010-仓库按客户端云端两端拆分-品牌更名SuDuo.md)。本篇只讲怎么做。

---

## 一、设计概述

| 项 | 说明 |
|----|------|
| 目标 | 根目录只剩 `client/`、`cloud/`、`docs/`；两端各自安装、构建、测试、运行；品牌只有 SuDuo 一种写法 |
| 覆盖 | 目录与包、两份契约、两个工作区、全部脚本与部署资产、代码 / 配置 / 界面文案里的品牌、`docs/`（`.ccb` 除外）、用户本机数据迁移 |
| 不覆盖 | 「需求服务」术语；`.claude/` 的 CCB 钩子；`docs/.ccb/`；GitHub 仓库与本地目录改名（需用户另行同意） |
| 兼容 | 不保留旧名兼容，唯一例外：旧工具名 `zjwork_*` 按新名认（执行与时间线共用一处） |

---

## 二、目标布局与路径映射

```
su-workbench/                    （仓库目录改名另议）
├── client/                      pnpm 工作区 suduo-client
│   ├── package.json  pnpm-workspace.yaml  pnpm-lock.yaml
│   ├── tsconfig.base.json  eslint.config.js  mise.toml
│   ├── web/                     @suduo/web
│   ├── server/                  @suduo/client-server（.env.example 随行）
│   ├── contracts/               @suduo/client-contracts
│   ├── codex-protocol/          @suduo/codex-protocol
│   └── scripts/                 dev-local.sh  doctor.ts  install.mjs  uninstall.mjs  templates/  dist-win/  gate-c-vm.sh  gate-c-vm/
├── cloud/                       pnpm 工作区 suduo-cloud
│   ├── package.json  pnpm-workspace.yaml  pnpm-lock.yaml
│   ├── tsconfig.base.json  eslint.config.js  mise.toml
│   ├── server/                  @suduo/cloud-server（Dockerfile、compose.yaml、DEPLOYMENT.md 随行）
│   ├── contracts/               @suduo/cloud-contracts
│   └── scripts/                 dev-postgres.sh
├── docs/
└── CLAUDE.md  README.md  .gitignore
```

| 旧路径 | 新路径 |
|---|---|
| `apps/web` | `client/web` |
| `apps/server` | `client/server` |
| `apps/requirements-service` | `cloud/server` |
| `packages/contracts/src/*.ts`（根导出） | `client/contracts/src/*.ts` |
| `packages/contracts/src/requirements-v2/{local,workbench,attachment-preview}.ts` | `client/contracts/src/` 同名文件 |
| `packages/contracts/src/requirements-v2/其余` | `cloud/contracts/src/` 同名文件 |
| `packages/codex-protocol` | `client/codex-protocol` |
| `scripts/dev-postgres.sh` | `cloud/scripts/dev-postgres.sh` |
| `scripts/其余` | `client/scripts/` 同名 |
| `.env.example` | `client/server/.env.example` |
| `artifacts/`（不入库） | `client/artifacts/` |
| `AGENTS.md`、`ccb.config` | 删除 |

| 旧导入 | 新导入 |
|---|---|
| `@zjwork/contracts` | `@suduo/client-contracts` |
| `@zjwork/contracts/requirements-v2`（local / workbench / attachment-preview 的符号） | `@suduo/client-contracts` |
| `@zjwork/contracts/requirements-v2`（其余符号） | `@suduo/cloud-contracts` |

---

## 三、关键做法

**客户端怎么用云端契约**：`client/{contracts,server,web}` 的依赖写 `"@suduo/cloud-contracts": "link:../../cloud/contracts"`，pnpm 只建软链接、不装它的依赖（契约包零运行时依赖）。`client/contracts` 与 `client/server` 的 tsconfig 用 `references` 指向 `../../cloud/contracts`，`tsc -b` 用客户端自己的 TypeScript 顺带编译它，客户端构建前不需要在 `cloud/` 里安装。云端的 package.json 里没有任何客户端包，方向由此强制。

**两份锁文件不变版本**：把旧根锁文件复制进两端再 `pnpm install`，pnpm 以已有锁定版本为首选，只修剪不再用到的条目；安装后对比两端锁文件与旧锁文件里同名包的版本。

**依赖版本覆盖**：`fast-uri`、`find-my-way` 两条安全覆盖两端都写（两端都用 Fastify）；`onlyBuiltDependencies` 客户端 `better-sqlite3`、`esbuild`，云端 `esbuild`。

**品牌替换顺序**（避免驼峰被吞）：

| 顺序 | 匹配 | 替换为 |
|---|---|---|
| 1 | `zjwork` 后紧跟大写字母（驼峰开头，如 `zjworkTool`） | `suDuo` |
| 2 | `ZJWork`、`Zjwork` | `SuDuo` |
| 3 | `ZJWORK` | `SUDUO` |
| 4 | `zjwork` | `suduo` |
| 5 | `zj-` 前缀的 CSS 动画、`__zjCreateRequire` | `suduo-`、`__suduoCreateRequire` |
| 6 | 测试数据里的 skill 名 `zj-req` | 中性名 |

例外：时间线兼容旧工具名的那一处（加 eslint 豁免注释）；ADR-0010、本篇、项目总览里的新旧对照表（需要原样保留旧名）。

**品牌守卫**：两端 `eslint.config.js` 用 `no-restricted-syntax` 禁止标识符匹配 `Suduo`、`suduo[A-Z]` 和任何旧品牌写法，字符串里禁止旧品牌写法。

---

## 四、实施步骤（每步一个提交）

| 步 | 提交 | 内容 | 验证 |
|---|---|---|---|
| S0 | `0028dec` docs: ADR-0010 与技术方案 | 本篇与 ADR | — |
| S1 | `048ac49` refactor: 目录按两端分组，拆成两个独立 pnpm 工作区 | `git mv` 搬目录与脚本（契约整包先放 `cloud/contracts`）；根目录的工作区与工具链文件分到两端，两份锁文件；`link:` 引用云端契约；修正 tsconfig、脚本、测试、gate-c 虚拟机、Docker 构建上下文；删除 `AGENTS.md`、`ccb.config` | 两端 install / build / typecheck / lint / test；锁文件版本与旧锁文件逐条比对一致；`protocol:diff`、`testid:check`、doctor |
| S2 | `3c49db0` refactor: 契约按归属拆成两包 | 新建 `client/contracts`；云端契约展平为包根导出；按名字分流全部导入；测试拆分 | 同上 |
| S3 | `9da61e5` refactor: 品牌更名 SuDuo | 代码、配置、脚本、界面文案、文件名、包名（含 `client-server` / `cloud-server`）、环境变量、存储标记、Windows / systemd 资产；图标与字标改为 SD；时间线兼容旧工具名；eslint 品牌守卫 | 同上 |
| S4 | docs: 文档同步目录与品牌 | `docs/`（`.ccb` 与原始验收证据除外）正文路径与品牌替换、34 篇文件改名与链接修正、总览新旧对照表、契约架构重写、README、CLAUDE.md 质量门 | 相对链接检查（与改造前相比没有新增断链） |

本机数据迁移（第五节）用一次性脚本完成，不进仓库。

---

## 五、已落盘的标识与本机迁移

| 位置 | 旧 | 新 | 本机迁移 |
|---|---|---|---|
| 环境变量（约 38 个） | `ZJWORK_*` | `SUDUO_*` | `mise.local.toml` 拆到两端并改名 |
| 数据根目录 | `/Volumes/Sue-SSD/Dev/data/zjwork`、`Dev/tmp/zjwork` | `.../suduo` | 停栈后整体改名 |
| 本机数据文件 | `zjwork.sqlite` / `.pid` / `.log` / `.env` | `suduo.*` | 随数据目录改名 |
| 默认数据目录 | `~/.local/share/zjwork`、`%LOCALAPPDATA%\ZJWork` 等 | `suduo` / `SuDuo` | 本机未使用默认目录 |
| 关联项目里的本机目录 | `.zjwork/` | `.suduo/` | 已关联的演示 / 测试仓库逐个改名 |
| 本机 SQLite 里的工具名、事件来源 | `zjwork_*`、`zjwork:api`、`zjworkTool` | 新名 | 文本列整体替换 |
| Codex 配置 | `[model_providers.zjwork]`、`zjwork_gate_c_probe` | `suduo` | 按实际存在的键改 |
| 浏览器存储 | `zjwork.*` | `suduo.*` | 不迁移，界面偏好回默认 |
| 云端存储标记 | `.zjwork-attachments-v1`、`.zjwork-room-files-v1` | `.suduo-*-v1` | 标记文件改名并改内容 |
| 开发 PostgreSQL | 角色 `zjwork`、库 `zjwork_dev` | `suduo`、`suduo_dev` | 临时超级用户改名后删除 |
| 健康检查标识 | `zjwork-requirements-service`、`zjwork-local-bff` | `suduo-*` | 两端同时升级，无需迁移 |
| Docker 卷（随 compose 项目名） | `zjwork-requirements-service_*` | `suduo-requirements-service_*` | 尚无部署；若已部署，升级前要把旧卷数据迁过去，否则会起一套空库 |
| 已执行的迁移文件 | 注释里的旧名 | **不改** | 两端测试锁定哈希（云端执行器校验校验和） |
| systemd / Windows | `zjwork.service`、`Software\ZJWork`、快捷方式、计划任务 | `suduo` / `SuDuo` | 本机未安装；gate-c 虚拟机重建为 `suduo-gate-c` |

---

## 六、测试与验证

- 每步：受影响工作区的 install / build / typecheck / lint / test 全绿。
- S3 后：`protocol:diff`、`testid:check`；对比两端锁文件版本与旧锁文件一致。
- S4 后：品牌残留扫描（代码 / 配置里除兼容处外不再出现旧品牌）；新建 `suduo-gate-c` 虚拟机跑 gate-c 全量。
- S5 后：文档相对链接全部可达。
- 本机迁移后：联调栈起来，登录、需求、会话、房间走一遍。
- **无法验证**：本机没有 Docker，云端 Docker 构建与 compose 不能实跑；Windows 安装包只能在有缓存资产时离线构建检查。

---

## 七、风险

| 风险 | 应对 |
|---|---|
| 两端工具链版本以后分叉 | 本次两端锁定同一版本；以后各自升级是有意为之 |
| `link:` 的契约在客户端构建时未编译 | 由 tsconfig 项目引用保证；`pnpm build` 顺序验证 |
| 机械替换误伤（如别的词里含 zjwork） | 替换前列出全部不同标识逐一过目；替换后全量测试 |
| gate-c 虚拟机内路径与名称变化 | 重建虚拟机而不是原地改；旧虚拟机保留到用户确认后再删 |

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-02 | 初稿（用户已在对话中确认方案与品牌名） |
| 2026-10-02 | 验证结果：两端 install / build / typecheck / lint / test 全绿；新建 `suduo-gate-c` 虚拟机跑官方 gate-c 全量 19 步通过（含 supervisor-recovery、Codex 配置提醒、视觉收口、无障碍）。gate-c 顺带发现 `f1dadbe`（会话列表按项目）的回归：项目切换器选中当前项目时没记住选择，已修（`89b7448`） |
| 2026-10-02 | 独立审查后修正：旧工具名兼容挪到 `client/contracts` 并接到服务端分派（更名前的线程续接后仍按旧名调用）；恢复被误改的 3 个已执行迁移文件并加哈希锁定测试；`ROOM_RESYNC_SSE_EVENT_NAME`、`LocalAgentStateDto` 挪到 `client/contracts`；遗留 skill 清理名单恢复旧名；`dev-local.sh` 进程识别带上 node 前缀 |
| 2026-10-02 | 实施调整：「目录分组」与「拆独立工作区」合为一步（脚本的根目录计算两步都要改）；服务端包名在品牌一步定为 `client-server` / `cloud-server`；图标与字标由 ZJ 改为 SD（方块 S 像数字 5，改为圆角 S）；云端测试连接写死 `suduo@127.0.0.1:15432`，在开发库先新增 `suduo` 角色，迁移时并入；原始验收证据（`gate-c-evidence/` 的 JSON、截图）与 CCB 工具名（`zj-dev`、`zj-worktrees`）保持原样 |
