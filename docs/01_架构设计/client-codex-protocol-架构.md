---
doc_type: architecture
updated: 2026-08-15
generated_by: su-init-ai
human_verified: false
architecture_scope: client-codex-protocol
scope_source_roots: ["client/codex-protocol"]
---

# client/codex-protocol 架构

> 一句话定位：Codex CLI JSON-RPC schema 的版本锁与漂移哨兵——不被任何代码 import，只在构建/校验链路上跑。｜最后更新：2026-08-15

> ⚠️ 本文由 `/ccb:su-init` 依据仓库证据自动生成，**尚未人工校验**（`human_verified: false`）。请 review 后再作为真相源使用；需要修改直接对话说明。

---

## 一、概述与定位

| 项 | 内容 |
|----|------|
| 名称 | `@suduo/codex-protocol`（v0.1.0，private，ESM） |
| 定位 | 工具型包：把上游 Codex CLI 导出的协议 schema 固化为基线清单，并在 CI/本地检出协议漂移 |
| 架构模式 | 单脚本 CLI + 基线清单文件，**无源码目录、无依赖、无自有 scripts** |
| 覆盖范围 | `client/codex-protocol` |
| 不覆盖 | 实际使用协议的 `client/server`（`infrastructure/transport`、`runtime/codex`）；系统全景见《SuDuo V2 系统架构》 |

全仓检索 `@suduo/codex-protocol` 只命中它自己的 `package.json`——**没有任何应用 import 它**。它的价值在于：当上游 Codex 版本或协议形状变化时，`protocol:diff` 以非零退出码把问题挡在集成之前，从而保证 `client/server` 里手写的 JSON-RPC 适配层始终对着一个已知的协议基线。

---

## 二、整体结构

```
  根 package.json scripts
   protocol:generate │ protocol:baseline │ protocol:diff
            └────────────┬───────────────┘
                         ▼
          client/codex-protocol/scripts/schema.mjs
                         │
        ┌────────────────┼─────────────────────┐
        ▼                ▼                     ▼
   VERSION (0.159.2)  codex 可执行文件     baseline-manifest.json
   期望版本            CODEX_PROTOCOL_BIN    已固化基线
                       或 node_modules/.bin/codex
                         │
              assertCodexVersion(bin, VERSION)   ← 版本不符即失败
                         │
                    generateBundle()
                         │
        ┌────────────────┴────────────────┐
        ▼                                  ▼
   generate: 写 generated/          baseline/diff: 写临时目录
   （.gitignore 忽略）                    │
                                    ┌─────┴──────┐
                                    ▼            ▼
                              baseline:      diff:
                              覆写基线    compareManifests()
                                          漂移 → exitCode 1
```

---

## 三、技术栈

| 类别 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 运行时 | Node.js 内置模块 | — | `child_process`、`crypto`、`fs`、`os`、`path`、`url` |
| 依赖 | 无 | — | `package.json` 只有 name/version/private/type 四个字段 |
| 外部工具 | Codex CLI | 0.159.2 | 由 `VERSION` 锁定，根 devDependencies 提供 `@openai/codex` |
| 清单格式 | JSON（sha256 + bytes） | schemaVersion 1 | `baseline-manifest.json` |

---

## 四、项目结构

```
client/codex-protocol/
├── package.json            仅 name/version/private/type，无 scripts、无依赖
├── VERSION                 0.159.2，期望的 Codex CLI 版本
├── baseline-manifest.json  已固化基线：schemaVersion / codexVersion /
│                           experimental / files{path:{sha256,bytes}}
├── scripts/schema.mjs      唯一可执行入口，三种模式
└── generated/              generate 模式产物，被 .gitignore 忽略
```

| 关键文件 | 职责 | 状态 |
|------|------|------|
| `scripts/schema.mjs` | generate / baseline / diff 三模式实现 | ⭐ 重点 |
| `baseline-manifest.json` | 协议基线真相源，漂移判定的比较基准 | ⭐ 重点 |
| `VERSION` | Codex 版本锁；与 `@suduo/client-contracts` 的 `CODEX_VERSION` 同为 `0.159.2` | ✅ 在用 |

---

## 五、核心模块 / 组件

| 模块 | 职责 | 依赖 |
|------|------|------|
| `assertCodexVersion(bin, version)` | 执行 `codex --version`，与 `VERSION` 不一致即中止 | `spawnSync` |
| `generateBundle(bin, out)` | 调 Codex 导出 schema 到目标目录，逐文件算 sha256/bytes 生成 manifest | `createHash` |
| `compareManifests(baseline, current)` | 产出 `added` / `removed` / `changed` 三类差异 | — |
| 模式 `generate` | 写 `generated/` 与其 `manifest.json`，输出 `status: "generated"` | 上述 |
| 模式 `baseline` | 在临时目录生成后覆写 `baseline-manifest.json`，输出 `status: "baseline-written"` | 上述 |
| 模式 `diff` | 在临时目录生成后比对基线；有差异或版本不符则打印 `status: "protocol-drift"` 并 `exitCode = 1`，否则 `status: "clean"` | 上述 |

`baseline` 与 `diff` 都在 `tmpdir()` 下建带 pid + 时间戳的临时目录，并在 `finally` 中 `rmSync(..., {recursive:true, force:true})` 清理。

---

## 六、关键流程 / 数据流

日常校验（漂移哨兵）：

```
pnpm protocol:diff
   → 解析 codexBin（CODEX_PROTOCOL_BIN 优先，
       否则 <workspace>/node_modules/.bin/codex[.cmd]）
   → assertCodexVersion 必须等于 VERSION=0.159.2
   → 临时目录生成当前 schema bundle → 算 sha256 清单
   → compareManifests(baseline-manifest.json, 当前)
        ├─ 无差异 → status: "clean"，退出码 0
        └─ 有差异 → status: "protocol-drift"（含 expected/actual 版本
                     与 added/removed/changed）→ 退出码 1
   → finally 清理临时目录
```

升级 Codex 版本时的顺序：改 `VERSION` → `pnpm protocol:baseline` 重新固化 → 同步 `@suduo/client-contracts` 的 `CODEX_VERSION` → 复核 `client/server` 的 transport / runtime 适配层。

---

## 九、部署 / 运行

不参与构建产物，也不发布：根 `package.json` 的 `build` / `test` 使用 `--if-present`，本包没有这些脚本因而被跳过。

| 命令 | 作用 |
|---|---|
| `pnpm protocol:generate` | 生成 `generated/` 供人工查阅（gitignored） |
| `pnpm protocol:baseline` | 重新固化 `baseline-manifest.json` |
| `pnpm protocol:diff` | 校验漂移，失败退出码 1 |

环境变量：`CODEX_PROTOCOL_BIN` 可覆盖 Codex 可执行文件路径（默认取工作区 `node_modules/.bin/codex`，Windows 下 `codex.cmd`）。

---

## 十、边界 / 不做项

- 不导出任何运行时代码，不被任何应用 import；协议适配实现在 `client/server/src/infrastructure/transport` 与 `runtime/codex`。
- 不自动升级或修复漂移，只报告并以退出码失败。
- `generated/` 不入库（`.gitignore` 已忽略），基线只认 `baseline-manifest.json`。

---

## 十一、相关文档

| 想深入 | 看 |
|--------|-----|
| 系统总架构 | `docs/01_架构设计/v2-系统架构.md` |
| 协议的实际使用方 | `docs/01_架构设计/client-server-架构.md` |
| 版本常量所在 | `docs/01_架构设计/contracts-架构.md` |

---

## 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-08-15 | v1.0 | `/ccb:su-init` 依据仓库证据生成初版（未经人工校验） |
