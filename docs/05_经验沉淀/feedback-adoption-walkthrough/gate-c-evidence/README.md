---
doc_type: lessons
title: pr8 定向 Gate-C 实跑证据
updated: 2026-08-28
---

# pr8 定向 Gate-C 实跑证据

需求 `suduo-v2-feedback-interaction-language-001` 的 pr8 唯一硬验收是「`pnpm gate:c` 实跑通过」。
完整 14 步套件在本机跑不完（第 2 步 `assistant-approval` 需要模型实际发出需审批命令，
codex 告警 `gpt-5.6-terra` 使用 fallback metadata），故改为**定向实跑**：临时将步骤表缩减为
`v2UserPathStep + requirementsBoardStep`，跑完立即还原。

依据：`requirements-board` 步骤只使用 `context.page` / `browserContext` / `origin`，
不依赖第 2~7 步的任何产物 —— 它排在第 8 位只是顺序，不是依赖。

这些截图由该次实跑产出，原本只存在于 worktree 的 `artifacts/`（被 gitignore），
需求级归档 cleanup 会将其永久删除，故在归档前转存至此。

## 截图

| 文件 | 内容 |
|---|---|
| `06-requirements-board.png` | 看板首屏 |
| `07-board-conflict-resolved.png` | 拖拽冲突回查后归位 |
| `08-artifact-published-sse.png` | 产物发布经 SSE 分发到另一窗口 |
| `09-artifact-published-board.png` | 发布后看板刷新 |
| `10-attachment-version-conflict-refreshed.png` | **附件删除 409 → `version_conflict/global` 反馈，详情自动回查至 v3** —— 即 pr8 `:260` 断言通过的画面 |

## 关键日志（两次实跑均一字不差）

```
[requirements-board] viewport=1440x900 clientWidth=1392 scrollWidth=1392
[requirements-artifacts] SSE 已经由 parseRequirementsEvent 通过并进入 artifact.published 分发；主窗口收到事件后回查详情。
[requirements-artifacts] 附件删除收到 409：收到 version_conflict/global 反馈，详情已自动回查至 v3。
```

第三行是 pr8 自己改的 `:265` 日志，**只有 `:260` 断言成功后才会打印**；`:202`（发布成功
`success/global`）在同一函数中排在其前，必然亦通过。

## 解耦判据

spec 要求「故意改掉对应中文文案后断言仍须通过」。将 `"已发布产物版本"` 改为
`"文案已被故意改动ABC"`、`version_conflict` 兜底文案改为 `"文案已被故意改动XYZ"` 后重跑，
上述三行日志一字不差照常出现，证明断言与文案确已解耦。测试后文案已还原。

## `doctor-normal.json`

同次实跑的 Gate-C doctor 前置输出（exit 0，零 fail，3 warn 均为 npm 安装根不一致）。
保留它是因为本需求排查过程中 doctor 的通过/失败一度是关键判据。
