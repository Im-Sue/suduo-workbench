---
doc_type: dev_task
task_id: subtask-1e1450158cad
title: testid 基线重建与漂移检查
status: done
current_node: archive
node_substate: archived
review_status: passed
priority: high
requirement_id: suduo-v2-feedback-interaction-language-001
section_id: pr1-testid-baseline-rebuild
order: 1
implementation_owner: ccb_codex
dependencies: []
source_breakdown_draft: docs/.ccb/drafts/breakdown/suduo-v2-feedback-interaction-language-001.json
source_draft_hash: 02b30b998028de4c87604f4656f338cd76afd80edddf54d47a4a963f5b3ba286
created_at: 2026-08-26T02:49:41.226Z
updated_at: 2026-08-26T07:22:40.394Z
updated_by: ccb_claude
code_workspace: {"path":"../SU-CCB-req-suduo-v2-feedback-interaction-language-001","branch":"ccb/req-suduo-v2-feedback-interaction-language-001"}
---

# testid 基线重建与漂移检查

> 本文档由 breakdown draft 物化生成；frontmatter 承载任务状态，正文按开发任务模板组织。

## 一、任务概述

| 项 | 说明 |
|----|------|
| 交付目标 | 把失真的 data-testid 基线重建为真实快照，并加上能自动发现漂移的检查与再生成命令。零依赖，必须排在所有其他片之前。 |
| 需求来源 | suduo-v2-feedback-interaction-language-001 |
| 本期范围 | pr1-testid-baseline-rebuild · testid 基线重建与漂移检查 |
| 不含范围 | 未在本子任务 spec_section_md 中声明的内容 |
| 预计工期 | 未估算 |
| 分工 | ccb_codex |

## 二、任务分解

### pr1 testid 基线重建与漂移检查

#### 任务概述

Gate-C 的 testid 基线现在是一张**过期地图**。后面所有片都要往里加条目，如果先在失真的快照上叠加，登记出来的东西没有校验价值——所以顺序不能反，这片必须最先做，而且不带任何其他改动，好让「删掉 9 条死条目」这件事在一次 diff 里看得清清楚楚。

**实测数字（请以此为准，不要相信任何文档转述）**：

- 基线登记 44 条 `(文件, id)` 对
- 其中 **9 条已死**，全部来自 3 个**已被删除的文件**：`LeftRail.tsx` 5 条、`TopBar.tsx` 3 条、`SettingsPanel.tsx` 1 条
- **没有**「文件还在但 id 没了」的死条目
- 存活匹配 35 条
- 源码实有 **127** 个静态 `(文件, id)` 对，分布在 **23** 个文件
- 因此未登记 = 127 − 35 = **92** 条

> **数字已于 2026-08-25 复测更新**。草案初稿写的是 120 / 85，那是 2026-08-24 16:40 的快照；当晚 commit `92434dc`（会话删除、主题与缩放、Skills 接线）新增了 7 个 testid：`session-row-delete`、`skills-project-context*` 3 个、`settings-{appearance-card,theme,ui-scale}` 3 个。**开工时必须重新实跑扫描，以当时的真实数字为准**——本片的存在理由就是「基线会过期」，照抄一个写死的数字等于再造一份过期基线。

另有 **12 处动态 `data-testid={...}`**（模板/变量拼接）。

#### 任务分解

1. **重建快照**：扫描 `client/web/src/**/*.tsx`，把**开工时实跑扫描得到的全部**静态 `(文件, id)` 对写成新基线（2026-08-25 实测 **127**；**不得照抄本文数字**，与本片概述口径一致）。允许删掉那 9 条死条目——用户 2026-08-24 已明确拍板授权。
2. **保留旧快照副本**（例如 `data-testid-baseline.prev.json` 或同等位置），便于日后比对，**不要直接丢弃**。
3. **漂移检查器**：新增可独立运行的 checker，比对源码实际值与基线。
   - **只比对静态字面量**。那 12 处动态 testid 要么显式排除、要么能枚举出模板后再纳入；**不能让它们产生伪漂移**——伪漂移会让检查很快被人忽略，等于白做。
   - 报「基线里有、源码没有」（删除/改名）与「源码有、基线没有」（新增未登记）两类，两类都要能让检查失败。
4. **再生成命令**：提供一条把当前源码写回基线的命令（例如 `pnpm testid:baseline --write` 或同等入口）。
   - **这条命令是后面 5 个并行片能同时改基线的前提**：并行片各自新增 testid 时不手工编辑 JSON，而是跑一次再生成；合并冲突靠重跑解决，不靠手动合并。这一点必须写进命令的使用说明。
5. **接进 CI / 现有校验入口**，与 `structure-check.ts` 同级别对待。

#### 验收标准

- [ ] 新基线条目数 = **开工当时实跑扫描得到的**源码静态 `(文件, id)` 对数（2026-08-25 实测 127，但**以你开工时实跑为准，不得照抄本文数字**）；3 个已删文件的 9 条条目已清除。
- [ ] 旧快照副本已留存。
- [ ] checker 在当前 HEAD 上通过。
- [ ] 人为删掉源码里一个已登记 testid → checker 失败。
- [ ] 人为加一个未登记 testid → checker 失败；跑一次再生成命令后通过。
- [ ] 12 处动态 testid 不产生伪漂移（写一条针对它们的用例证明）。
- [ ] build / typecheck / lint 通过。

#### 边界

**本片独占文件**（outline 的归属矩阵不会随物化进入任务文档，故在此下沉）：新增的 checker 脚本与再生成命令入口；`client/server/test/gate-c/data-testid-baseline.json` 由本片**建立**。注意：基线建立后即转为**共享生成文件**，pr2~pr7 会各自经再生成命令写入它——本片必须保证「重跑即可消解合并冲突」，不要把它设计成只有本片能写的格式。

**不动 `client/web/src` 的任何一行**——本片只读源码、只写测试侧。不改 `steps/requirements-board.ts` 的断言（那归 pr8）。不新增依赖。不顺手补 testid：需要补的地方由各自的域片在接入时补。

## 三、执行顺序 / 里程碑

- 前置依赖: 无
- 执行顺序: 按本任务分解完成实现、验证、回执。

## 四、进度记录

| 日期 | 完成内容 | 遇到问题 | 下一步 |
|------|----------|----------|--------|
| 2026-08-26 | 物化任务文档 | 无 | 等待 dispatch 派工 |

## 五、验收标准

- [ ] 完成 `spec_section_md` 定义的实现范围。
- [ ] 保持 dev_task frontmatter 状态机字段由流程命令维护。
- [ ] 完成必要验证，并在回执中说明测试命令与结果。

## 六、风险与注意

| 风险 / 注意 | 影响 | 处理 |
|------|------|------|
| 任务范围与需求或技术设计不一致 | 返工或越界实现 | 实施前回读需求、设计和本任务 spec_section_md |

## Materialization Context

- Requirement: suduo-v2-feedback-interaction-language-001
- Section: pr1-testid-baseline-rebuild
- Owner: ccb_codex
- Priority: high
- Dependencies: none

---

## 审查记录 · 2026-08-26（ccb_claude）

**Review decision: pass** — 归档。执行：slot4_codex，job `job_ce90a34f18e3`，commit `e50b981`（单提交），5 文件 +479/-19。

### 逐条验收判定 —— 证据全部由审查方独立复跑，未采信回执

| # | 验收标准 | 判定 | 证据 |
|---|---|---|---|
| 1 | 新基线 = 开工实扫的静态 pair 数；9 条死条目清除 | **pass** | 审查方用独立正则扫描重算，与提交基线**对称差为空**：127 pair / 23 文件。`LeftRail.tsx` 5、`TopBar.tsx` 3、`SettingsPanel.tsx` 1 共 9 条已清除 |
| 2 | 旧快照副本留存 | **pass** | `client/server/test/gate-c/data-testid-baseline.prev.json`，44 条，与旧基线逐条一致 |
| 3 | checker 在当前 HEAD 通过 | **pass** | 审查方自跑 `pnpm testid:check` → exit 0，`PASS testid baseline: 127 static pairs; 12 dynamic attributes excluded` |
| 4 | 删掉一个已登记 testid → checker 失败 | **pass** | 审查方实做：改 `ui/message.tsx` 去掉 `global-message` → exit 1，`Baseline entries missing from source: client/web/src/ui/message.tsx: global-message`。已恢复 |
| 5 | 加一个未登记 testid → 失败；再生成后通过 | **pass** | 审查方实做：插入 `review-probe-xyz` → exit 1，`Source entries missing from baseline`；`pnpm testid:baseline` → 128 → check exit 0。恢复源码再生成回 127，**`git status` 为空** |
| 6 | 12 处动态 testid 不产生伪漂移，且有专门用例 | **pass** | `testid-baseline.test.ts` 两条用例：一条以 fixture 证明 `={id}` / `={\`row-${id}\`}` 不入基线，一条对全仓断言 12 个动态项且双向漂移为空。审查方抽样 5 处动态点，全是模板串或变量，无 `={"字面量"}` 这类会被误判的漏登记 |
| 7 | build / typecheck / lint 通过 | **pass** | 审查方自跑（Node 24.10）全部 exit 0；lint 为 `--max-warnings=0` |
| 8 | 既有单测未被改动且仍绿 | **pass** | 审查方自跑：contracts 3/3、web 82/82、requirements-service 43/43、server 129/129。web 82 未变证明未动既有前端测试；server 127→129 即本片新增那 2 条 |

### 边界核查（硬约束，优先于功能验收）

`client/web/src` 零改动；`steps/requirements-board.ts` 未碰；`package.json` 仅加 2 条 script 并改 `gate:c`，**无依赖变化**；工作树干净；canonicalRoot 未被写入。全部符合 dispatch brief 禁止范围。拍板项扫描（rg pattern v1）对 diff 无命中。

### 超出回执声明的发现

**再生成是字节级确定性的。** 审查方恢复源码后重跑 `testid:baseline`，产出与已提交基线完全相同（`git status` 为空）。这比回执声称的更强——它证明了 spec 要求的「并行片各自新增 testid 时靠重跑消解合并冲突，不手工合并 JSON」在机制上真的成立，而不只是写在 `usage()` 里的承诺。

**实现优于交叉验证手段。** checker 用 TypeScript compiler API 做真 AST 遍历，只把 JSX 属性上的字符串字面量收进基线；审查方的正则扫描反而是更粗的手段，两者结果一致说明当前代码里不存在需要 AST 才能分辨的边界情况。`readBaseline` 另有 `total` 与实际条目数的交叉校验。

### 已知覆盖缺口（不阻塞归档，须传递给后续）

**「接进 CI」这条验收判定为：入口接线 pass，CI 覆盖 unknown。** 经审查方与 Codex 双方核实，本仓**没有 CI 配置**，spec 拿来做同级参照的 `structure-check.ts` 自己也没有 package.json 入口、没有任何自动触发点（全仓 rg 仅文档提及）。本片把 `testid:check` 前置进 `gate:c` 已满足「接进现有校验入口」的可达解释；在无 CI 的仓里新建 CI 属于越界，不应由本片自行决定。

**后果要说清楚**：`testid:check` 目前只在 `pnpm gate:c` 里自动触发，而 `gate:c` 消耗真实模型调用、拉浏览器、跑 systemd，代价高、不会频繁跑。因此在日常开发中这道闸**实际上是手动的**。本批次的处置是在 pr2~pr7 每片的 dispatch brief 里强制要求同提交跑 `testid:baseline` + `testid:check`；批次之外的长期覆盖是遗留事项。

**建议后续另开**：把 `testid:check` 纳入一个廉价的常规校验入口（例如并入 `pnpm lint` 链路或新建 `pnpm verify`），否则它只在昂贵的 Gate-C 前生效。不在本需求授权范围内，不在本片做。

### 其余判断复核

**`expect(scan.dynamicEntries).toHaveLength(12)` 的硬编码是有用的绊线，不是雷。** 前一条 fixture 用例已经独立证明了「动态属性被排除」这条通用规则，这条断言额外承担的是「全仓动态 testid 清单」的看守职责。spec 本就要求各域片「状态走 `data-feedback-kind` / `data-feedback-result` 属性，不要用随状态变化的 id」，所以后续片撞红这条＝它违反了契约，应该被拦下。已写进 pr2~pr7 dispatch brief 的必须回抛项：撞红即升级，不许自行改数字。

**丢弃 `capturedAt` 字段成立。** checker 持续校验之后，时间戳只会在每次再生成时制造无谓 diff，且会破坏刚刚验证过的字节级确定性；溯源由 git 提交时间与 `.prev.json` 承担。

**`gate:c` 里 `build && testid:check && gate-c.real` 的前置位置正确**——应该在真实模型调用、systemd、浏览器这些昂贵副作用之前失败，放到之后只会把无效基线变成事后报告。

### 未覆盖

- 未跑 `pnpm gate:c`（含真实模型与系统服务副作用），归 pr8 的已授权实跑。本片对 Gate-C 的影响仅通过静态阅读 `package.json` 与独立运行 `testid:check` 确认。
- checker 只覆盖 `client/web/src/**/*.tsx`。`.ts` 文件里若有 testid（当前没有）不在扫描范围。
