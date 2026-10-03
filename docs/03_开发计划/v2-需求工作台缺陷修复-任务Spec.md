# 任务 Spec:suduo-v2 需求工作台缺陷修复(登录文案 + 深链详情 + 会话页 ID)

- 日期:2026-08-23 · 状态:已协商待派工 · 目标 agent:`main_codex`
- 来源:本机整套系统实跑(BFF 8787 / requirements-service 4100 / PG 15432)现场取证
- 协商:job_95d90dfe6db7(main_codex,consult)已回执并据此修订;**Codex 推翻了我的一条错误证据,见缺陷二**

## 施工约定(开工前先读这段)

| 项 | 值 |
|---|---|
| 基线 SHA | `be0da55c8c4c3a1b21506f55e7309d4f343c7c39`(分支 `main`) |
| 工作空间 | 主仓原地(`workspace_mode=inplace`),**无 worktree 展开** |
| 提交 | **不 commit、不 push**,改动留在工作树等 Claude 审查 |
| 验收产物 | **以生产 dist 验收**,不用 vite dev server |
| 构建重启 | `pnpm build` → `systemctl --user restart suduo.service`(requirements-service 改动则同时 restart `suduo-requirements.service`) |
| 服务检查 | `systemctl --user is-active suduo-postgres suduo-requirements suduo`;健康 `curl 127.0.0.1:4100/v2/health`、`curl 127.0.0.1:8787/healthz` |
| 网络证据 | **HAR + 自动化网络日志**(Playwright 1.61 + 本机 Chrome,`PLAYWRIGHT_BROWSERS_PATH=/home/sue/.cache/ms-playwright`),**不要求 DevTools 截图** |
| 测试数据 | **已获用户授权**:可在本机 SQLite / PG 新建独立测试项目·需求·会话并在验完后清理;**严禁改动或删除现有的「测试对话需求」「导出支持按门店筛选」及账号 `sue`/`suyejian`** |
| 现成夹具 | 账号 `suyejian`(已登录态在 BFF 侧);深链 requirementId `f3698b0a-9b5f-4043-826b-b702ff8ffed6`;映射 远程 `7cdc2cdf…` → 本机 `b1d11143…` |

**为什么强制生产 dist**:今天刚踩过「新前端 + 旧后端」(server 进程跑旧代码导致 404);且 StrictMode 只在 dev 下双调用,用 dev server 会让"请求次数"结论失真。

## 缺陷一:`AUTH_INVALID` 一码两义,登录页文案答非所问

**现象**:登录名对、密码错时,登录页提示「登录凭证无效或已过期,请重新登录」——用户正在登录,这句话没有可执行含义。

**取证**:远程原文是准确的(`cloud/server/src/application/auth-service.ts:43` 抛 `401 / AUTH_INVALID /「登录名或密码错误」`);服务端日志确认两次真实登录都打到 4100 并返回 401,链路无故障。

**Claude 拍板:走「远程细分错误码」,不走「BFF 按调用点分叉」。** 理由:现架构里 **code 是唯一语义载体**,BFF 靠 code 选文案;按调用点分叉等于让同一个码在不同位置有不同含义,下一个调用点还会再踩。

**改法(含 Codex 协商纠正的关键一处)**:
1. `cloud/contracts/src/errors.ts` 的 `REQUIREMENTS_V2_ERROR_CODES` 增加 `LOGIN_CREDENTIALS_INVALID`(**必须进联合类型,不许用裸字符串绕类型检查**)。
2. `auth-service.ts:43` 登录失败改抛新码;`cloud/server/src/application/errors.ts` 同步。
3. **`client/server/src/infrastructure/requirements-v2/remote-client.ts:510-520` 的 `throwRemoteError()` 必须改**——当前 `status === 401` 是**优先分支**,会把任意 401 无条件改写成 `AUTH_INVALID` 并 `credentials.clear()`,**根本走不到下面的 code 查表**。只给 `safeRemoteMessage()` 加新码是无效的。顺带:密码错时不应清凭据。
4. `safeRemoteMessage()` 为新码映射「登录名或密码错误」;`AUTH_INVALID` 保留「登录凭证无效或已过期,请重新登录」专表会话失效。
5. **保持不透传远程 message 的信任边界设计**,不要改成直接回显远程文本。

**已知代价**:旧版 BFF 遇到新码会落到兜底文案「远程需求服务处理失败」——本机单版本部署,可接受。

## 缺陷二:深链/刷新进需求详情永远停在骨架屏

**现象**:直接访问 `/requirements/<id>`(等价于在详情页按 F5)**3/3 稳定复现**停在骨架屏(3 个 `.animate-pulse`),永不加载;从看板点进去正常。

> **⚠️ 证据更正(Claude 自己的错,Codex 协商时挑出)**:本 Spec 早期版本写的「`GET /api/v2/requirements/:id` 从未发出」**是错的**——那是我把 Playwright 日志用 `tail` 截断后的误读。**已重测并作废该结论。**

**重测后的确凿事实(HAR 全量抓取)**:
- `GET /api/v2/requirements/f3698b0a…` **确实发出,且返回 200**;`comments`/`attachments`/`artifact-versions`/`audit` 四条同样全部 200。
- 但 10 秒后页面仍是 3 个骨架元素,详情内容始终不渲染 → **数据回来了却被丢弃**。
- `localStorage` 里 `suduo.v2.remoteProjectId = 7cdc2cdf…`,与该需求所属项目一致。

**已定位的相关源码(未下结论,由你收口)**:
- `client/web/src/components/requirements-v2/RequirementsWorkbench.tsx:309` —— `openDetail` 在**调用时刻**捕获 `const projectId = activeProjectId.current`。
- `:341-343` —— 守卫 `detailRequestSequence.current !== requestSequence || activeProjectId.current !== projectId || detail.projectId !== projectId` 命中即 `return`,**丢弃已返回的数据**。
- `:391-397` —— `finally` 只在 `detailRequestSequence` 与 `attachmentsRefreshSequence` **都匹配**时才 `setDetailLoading(false)`。
- `:411-436` —— 路由驱动 effect,注释声称「刷新页面、粘贴链接、前进后退三条路径自动等价」,`:436` 无条件 `void openDetail(requirementId)`。

**怀疑方向(仅供参考,请自行验证)**:深链首帧 `activeProjectId.current` 尚未就绪(HAR 显示 `/api/v2/projects` 与详情请求几乎同时发出),导致守卫把 200 回来的数据丢掉;而 loading 复位又受 sequence 匹配条件约束。**请先用 HAR + 断点/日志锁定真实因果链再改**,不要照抄这段猜测。

**Claude 拍板的行为定义**:深链需求所属项目与 `localStorage` 当前项目**不一致时,自动切换到该需求所属项目**并正常渲染详情。理由:用户粘贴链接的意图就是看这条需求,要求他先手动切项目是把内部状态泄露给用户。

## 缺陷三:会话页拿**远程** projectId 打**本机** v1 接口,运行状态永远取不到

**现象**:会话列表所有会话恒显示「空闲」,运行中与待审批**永远不亮**。页面不报错,失败完全静默。

**取证**:
- 实错点(Codex 定位、Claude 已核实):`client/web/src/app/SessionsWorkbench.tsx:150` 把**远程** `props.projectId` 传给 v1 `api.listRunStatus()`。
- 静默原因就在旁边 `:153` 的 catch:`// 状态灯是增强信息，拉不到就退化为 idle，不打扰用户。`
- `client/web/src/app/RequirementsV2App.tsx:37-40` 的注释确认两套 id 并存:`/sessions?projectId=` 深链契约用的是**本机项目 id**,`remoteProjectId` 参数才是远程 id。
- 实测:15 秒内 2 次 run-status 调用**全部 404、无一次成功**(非启动时序抖动);同接口用本机 id `b1d11143…` 返回 **200**,用远程 id `7cdc2cdf…` 返回 **404**;`GET /api/v2/project-mappings` 确认映射 `7cdc2cdf… → b1d11143…`。

**交付要求(按 Codex 建议重新定义,不是"18 处改动")**:这是一次**逐调用链审计**,不是逐个接口改。`client/web/src/api/client.ts` 里接受 `projectId` 的 v1 接口约 18 个(`:405`/`:414`/`:426`/`:483`/`:488`/`:492`/`:502`/`:506`-`:534`/`:637`/`:649`/`:658` 等),多数由已持有本机 `session.projectId` 的 `SessionRuntime` 调用、本身是对的。**回执必须给一张表:client 方法 → 消费者 → ID 来源 → 是否本机 ID。** 当前已确认错的只有会话页轮询这一条;其余按表给结论,不要求逐个点击验证文件/Git/附件行为。

## 范围

**允许改动**:
- `cloud/contracts/src/errors.ts`
- `cloud/server/src/application/{errors,auth-service}.ts`
- `client/server/src/infrastructure/requirements-v2/remote-client.ts`、`client/server/src/application/api-error.ts`
- `client/web/src/components/requirements-v2/RequirementsWorkbench.tsx`、`client/web/src/api/client.ts`
- `client/web/src/app/SessionsWorkbench.tsx`;如选择由父层解析映射,可一并改 `client/web/src/app/RequirementsV2App.tsx`、`client/web/src/app/SessionsMode.tsx`
- 测试:`cloud/server/test/application.test.ts`、`client/server/test/http.test.ts`,**允许新增测试文件**

**禁止**:
- 不改 BFF「不透传远程 message」的信任边界设计
- 不动 `/api/v2/requirements/:id/sessions` 的 POST-only 现状(已确认是正确设计,GET 返回 404 符合预期)
- 不借机重构需求工作台状态管理;只收敛本 Spec 点名的问题
- 不动 archive 历史、不改 Console 业务代码
- 超出上述允许列表的文件,先问 Claude 再动

## 验收

1. **缺陷一**:密码错 → 「登录名或密码错误」;会话过期 → 「登录凭证无效或已过期,请重新登录」。两条分支各有测试;远程 message 仍不透传;确认密码错时不再误清凭据。
2. **缺陷二**:`/requirements/<id>` 直接访问、详情页 F5 刷新、浏览器前进后退**三条路径**均正常渲染(标题、产物版本、附件、评论、审计五区齐全);跨项目深链自动切换项目后同样正常。
3. **缺陷二附带**:页面稳定后,需求列表的**每个 status 分片只请求一次**(7 列看板 = 7 个请求),且无 abort。统计口径以 HAR 为准,窗口 = 从导航开始到最后一个 `/api/v2` 响应后 3 秒无新请求。(注:原 Spec 写的"个位数"口径不准确,以本条为准。)
4. **缺陷三**:run-status 返回 200,运行中与待审批如实显示;并交付上述「client 方法 → 消费者 → ID 来源 → 是否本机 ID」审计表。
5. 三项均在本机整套系统(8787/4100/15432)**以生产 dist 实跑复验**,附 HAR 与网络日志。**静默类缺陷(一/三)不接受"看着正常",必须有网络证据。**
6. `pnpm typecheck`、`pnpm lint`、`pnpm test` 全绿。

## 回执格式

- changed files 清单(按包分组)
- 实跑验证命令与关键输出(含 HAR 路径)
- 缺陷三的调用链审计表
- 缺陷二的真实根因结论(以及我上面那段猜测是否成立)
- 残留风险
- 未做的部分及原因

## 阻塞时怎么办

遇到与本 Spec 矛盾、或需要改动允许列表之外的文件:**停下来问 Claude,不要自行裁量**。测试数据只在授权范围内造,不确定就先问。

## 派工前 4 锚点反思(Claude)

**① 事实锚 —— 证据站不站得住?**
一开始站不住。缺陷二我写的「`GET /api/v2/requirements/:id` 从未发出」是把 Playwright 日志 `tail` 截断后的误读,Codex 用源码反推(`:436` 无条件调用、`:331` 在守卫之前发请求)指出因果链矛盾,我重测 HAR 才确认请求确实发出且 200。**教训:自动化日志必须全量读,`tail` 出来的结论不能当证据。** 已在 Spec 里显式作废该结论并保留更正痕迹,避免执行者照着错前提排查。缺陷一、三的证据经复核成立(且 Codex 补出我漏掉的 401 优先分支)。

**② 边界锚 —— 范围闭没闭合?**
原范围漏了三块,均由协商补上:缺陷三真正的错点在 `SessionsWorkbench.tsx:150`(我只写了 `client.ts`)、测试文件未进允许列表、缺陷一漏了 `throwRemoteError()` 的 401 优先分支——这一处是决定性的,不改则我拍板的方案根本不生效。现允许列表已逐文件列明,并写明"超出列表先问"。

**③ 风险锚 —— 最可能翻车在哪?**
最大风险是**拿旧产物验收**:今天已真实发生过一次(server 跑旧代码导致 404 误判)。故把"生产 dist 验收 + 构建后必须 restart"写成硬约束而非建议。次风险是缺陷二的根因我只给了猜测,若执行者照抄我的猜测去改,可能修错地方——已明确要求"先用 HAR 锁定真实因果链再改,不要照抄这段猜测",并把根因结论列入回执必答项。第三是缺陷三若理解成"改 18 处"会过度改动,已按 Codex 建议改判为"逐调用链审计 + 交付一张表"。

**④ 用户目标锚 —— 这次派工还在服务用户吗?**
用户要的是"系统能用"。三个缺陷都是**用户已经撞上或必然撞上**的:登录看不懂提示、刷新详情页白屏、会话状态灯永远不亮。没有一条是为技术完整性自造的活。反过来我也压住了扩张:明确禁止重构状态管理、禁止动信任边界设计、缺陷三不要求逐个点击验证文件/Git/附件行为。测试数据授权已前置问过用户(可造可清、不许碰现有数据),没有替用户扩大风险范围。
