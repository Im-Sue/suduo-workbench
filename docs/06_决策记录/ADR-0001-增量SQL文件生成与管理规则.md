---
id: ADR-0001
title: zj-dev 增量 SQL 文件的生成与管理规则
doc_type: adr
status: accepted
supersedes: []
superseded_by:
date: 2026-07-06
---

# ADR-0001: zj-dev 增量 SQL 文件的生成与管理规则

> 一个决策一篇,记下"为什么这么定",防止以后反复扯 / 误改
>
> **状态**(见 frontmatter `status`):accepted ｜ **拍板人**: 用户

---

## 一、背景

backend-skills 的 `$zj-dev` 后端开发流,原先对 SQL 只有"审查视角"(role-dba 评审 schema)+ "落点约束"(放已有 SQL 目录),**没有"怎么生成增量 SQL"的规范**——命名、落点、回滚、幂等、多库全部"跟随目标项目既有约定"。

差距在于:目标项目**无约定 / greenfield 新模块 / 多人协作迁移**时没有下限兜底,风险包括命名漂移、无可执行回滚、多人抢占文件名、手工执行串库。

约束(经 Codex 核对造价通真实后端坐实):Java + Spring Boot + MyBatis-Flex + **MySQL 8**(8.0.27),**多数据源**(主 `cost_controll` / 副 `manager_center`,`@DS` 切换),手工 SQL 脚本、**无 Flyway/Liquibase**,**多人经常并行**开发。

---

## 二、决策

给 `$zj-dev` 增加增量 SQL 生成与管理规则(规则本体见 `zj-dev/references/sql-migration-rules.md`):

1. **落点**:增量 SQL 落目标后端 `{服务}/sql/` 平铺;存量(`docs/sql` 等)原地不动、只登记 baseline、不纳管。
2. **命名**:`{YYMMDDHHmm}_{序号}_{物理库}.sql`(两位年,时间戳到分钟排序;序号前置、同分钟批次内排位防同名)。
3. **追溯**:靠文件头元信息块(需求号 / 数据源 / 变更类型 / 生成者+日期 / 回滚指向 / 幂等标记),需求号**不进文件名**。
4. **回滚**:全部结构变更强制成对 `.rollback.sql`。
5. **幂等(折中)**:默认朴素 DDL;仅破坏性变更或跨多环境反复执行才用 `information_schema` 探测 + `PREPARE` 模板;**MySQL 8 禁用 `IF NOT EXISTS`**(那是 MariaDB 方言)。
6. **多库**:一文件一物理库,正文 `USE` + 全限定库名,文件头写 `datasource-key/物理库`。
7. **破坏性变更**(删列/改类型/改名/删表):卡决策门② + "先加后改"过渡。
8. **执行追踪**:`{服务}/sql/EXECUTED.md` 人工台账(明确"不保证数据库实际状态一致"),不建 log 表。
9. **落地**:`scan-service-locator.mjs` 升 v2(`managedSqlDir` 认 `{服务}/sql`、`legacySqlDirs` 登记 baseline);SKILL.md 阶段 3/5 挂接;role-dba 呼应。

---

## 三、否决的方案

| 方案 | 为什么没选 |
|------|------------|
| Flyway / Liquibase 迁移框架 | 项目手工执行、不引框架 |
| 纯递增号 `V001` / 需求号进文件名 | 多人并行抢号 / 文件名过复杂;时间戳到分钟已足够防撞 |
| 全部 DDL 严格幂等(套 information_schema 模板) | 每个改表变 10+ 行样板,与"简单"取向冲突;抓大放小,只在破坏性/跨环境用 |
| 每库建 `schema_change_log` 表 | 加维护负担、破"无 log 表";暂用人工台账,未来漂移再上 |
| 增量按需求分子目录 | 用户选平铺(暂时);膨胀了按年归档即可 |

---

## 四、影响

- **好处**:增量 SQL 有统一纪律(落点/命名/回滚/防串库),无约定项目有下限;MySQL 8 幂等写法坐实、不会写错方言;命名时间戳排序、天然低撞。
- **代价 / 风险**(已知限制,当前非阻断):
  - 平铺目录长期膨胀 → 出路:按年归档 `sql/YYYY/`。
  - 人工台账不保证数据库实际状态一致,多人 / 多环境可能漂移。
  - 幂等模板只覆盖"新增方向",破坏性"存在才删"反向模板未给,靠门② 人工兜底。
  - scan v2 取消了"非常规位置 .sql 兜底",SQL 放 `resources/db` 等的项目会漏(对造价通 `docs/sql` 无影响)。
- **受影响**:`zj-dev/`(SKILL.md、references/sql-migration-rules.md、role-dba.md、scripts/scan-service-locator.mjs)。

---

## 五、关联

| 关系 | 对象 |
|------|------|
| 相关文档 | `skills/backend-skills/zj-dev/references/sql-migration-rules.md`(规则本体) |
| 相关决策 | 无(首条 ADR) |

---

## 六、决策依据

- 与用户多轮协商逐项拍板:落点 → 命名 → 幂等强度 → 执行追踪。
- slot1_codex `consult` 协商(job_87f9ae31290a):以 MySQL 官方文档坐实 MySQL 8 不支持 `ADD COLUMN / CREATE INDEX ... IF NOT EXISTS`;访问造价通真实后端验证技术栈假设;修正命名尾序 `-2` 破坏字典序的 bug(改为序号前置)。
- slot1_codex 实施(job_a02a24a2e890)→ Claude 审查通过(4 文件忠实锁死参数、scan v2 独立重跑验证、无跨文件污染)。
