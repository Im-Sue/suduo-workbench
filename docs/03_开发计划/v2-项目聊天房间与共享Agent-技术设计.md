---
id: suduo-v2-rooms-shared-agent-design-001
title: SuDuo V2 项目聊天房间与共享 Agent 技术设计
doc_type: technical_design
requirement_id: suduo-v2-rooms-shared-agent-001
expression_spec: v1
updated: 2026-10-01
---

# SuDuo V2 项目聊天房间与共享 Agent 技术设计

> 一句话：房间、消息、文件、Agent、共享、任务都存远程需求服务；本机服务用**一条上游推送连接**扇出给页面并接任务；Agent 任务在所有者本机以「隐藏的房间任务会话」跑只读 Codex，复用会话工具层（ADR-0008）与时间线；回答作为话题回复发回房间。｜最后更新：2026-10-01
>
> **无独立 status**，跟随需求 [suduo-v2-rooms-shared-agent-001](../02_需求设计/v2-项目聊天房间与共享Agent-需求.md)。数据边界变化见 [ADR-0009](../06_决策记录/ADR-0009-房间共享Agent的数据边界.md)。

---

## 一、设计概述

**目标对齐**：PM 没有代码，开发的 Codex 有。把开发的 Codex 共享进房间，PM 直接 @ 它问代码层面的事，回答与执行过程全员可见。执行留在所有者电脑上（代码在那里，也延续「不在服务端跑 Codex」），所有者主动共享、随时关；首期只问答与规划（只读沙箱）。

| 项 | 说明 |
|----|------|
| 名称 | 项目聊天房间与共享 Agent |
| 核心职责 | 房间与成员、消息（文本 / 图片 / 文件 / 视频、@、话题、未读、合并重试）、文件存储与媒体、实时推送与补拉、Agent 登记 / 在线 / 共享 / 申请共享、@Agent 在所有者本机执行与三层展示 |
| 设计原则 | 业务按模块拆（房间、消息、Agent、实时、存储、媒体、提醒），模块间只走接口；唯一约束只做合并不做拒绝（ADR-0004）；查询三态；房间数据只在远程，Agent 执行只在所有者本机 |
| 覆盖范围 | 需求 P0 全部（拆 S1–S4 交付） |
| 不覆盖 | 需求 P1 / P2（置顶纪要、撤回、转评论、云存储驱动、多实例推送、放开改代码） |

---

## 二、方案与架构

```
浏览器（多个标签页）                 本机服务 client/server                              远程需求服务 cloud/server
────────────────────                ─────────────────────                            ──────────────────────────────────────
讨论页 / 需求详情「讨论」             /api/v2/rooms*  ── 逐端点转发（带凭据）────────────► /v2/rooms* /v2/agents* /v2/agent-runs*
  │  GET /api/v2/events (SSE)  ◄──── RemoteEventsHub：一条上游 /v2/events ◄───────────── RealtimeHub（内存，带序号的环形缓冲）
  │                                   │  扇出给所有标签页                                       ▲ 房间事件（带内容）
  │                                   └─► RoomAgentRunner（派给本机 Agent 的任务）               │
  │                                         │                                                 RoomService / MessageService
  │                                         ├─ 开始任务 POST /v2/agent-runs/:id/start ─────────► AgentService / AgentRunService
  │                                         ├─ 房间任务会话（隐藏）→ Codex 只读线程              BlobStore（本机磁盘驱动，独立根目录）
  │                                         │    dynamicTools：房间工具 +（需求房间）需求只读工具
  │                                         ├─ 进度 / 过程回写 POST …/progress
  │                                         └─ 回答 POST …/complete → 远程发话题回复
  │                                   AgentPresence：登记 Agent、30 秒心跳（含「有打开的页面」）
  │                                   TokenRefresher：过期前 1 小时续期
```

| 关键原则 | 说明 |
|----------|------|
| 房间是公开空间 | 不做房间级权限；成员只决定未读、提醒、@ 候选（需求 R1） |
| 执行在所有者本机 | 远程只派任务、存结果；本机复用现有会话运行时（事件账本、时间线、会话工具层） |
| 合并不拒绝 | 消息按客户端 ID 合并、Agent 重复登记合并、重开共享改时长、重复申请合并、重试复用同一任务行 |
| 一条上游连接 | 本机服务一条 `/v2/events` 扇出给所有标签页与本机任务接收器（需求 4.9 多标签页共用） |
| 存储可替换 | `BlobStore` 接口 + 本机磁盘驱动；只增不删（删除是 ADR-0004 红线） |

**与现有系统的关系 / 边界**：

| 涉及模块 | 本设计如何动它 | 保留 / 不动什么 |
|----------|----------------|------------------|
| 远程 `/v2/events` | 加命名事件 `room`（带内容、序号 id、`Last-Event-ID` 补发）；需求事件不变 | 需求事件格式与前端白名单不变 |
| 远程鉴权 | 加 `POST /v2/auth/refresh` | 登录 / 注册不变 |
| 审计表 | 放宽资源类型与需求归属约束（room、agent_share 只属于项目） | 其他审计不变 |
| 本机 `/api/v2/events` | 改为订阅 `RemoteEventsHub`（不再每个标签页各开一条） | 浏览器端协议不变 |
| 会话表 | 加 `kind`（normal / room_task）；会话列表默认不含房间任务，另有筛选 | 现有会话不变 |
| 安全档 | 新增「房间 Agent」档：只读沙箱 + 联网 + 不审批 | ask / auto / full 三档不变 |
| 会话工具层 | `catalog` 加 scope `room`；新增 `RoomTools`；需求房间复用需求只读工具 | 需求会话工具不变 |

---

## 三、关键决策与取舍

- **Agent 任务的载体 = 本机隐藏会话**：每个「(Agent, 话题根消息)」一个房间任务会话（一个 Codex 线程），复用事件账本、时间线投影、运行时恢复；没选「另起一个 runtime 不落账本」——那样要重写归属、时间线、恢复逻辑。会话加 `kind = room_task`，普通列表不显示，会话页筛选「房间任务」可见、可停止（需求 4.5「所有者视角」）。
- **串行队列放在本机**：远程按 Agent 记 `queued_at`，本机接收器按顺序一次只跑一个；远程只负责「排第几」的展示（同 Agent 更早的排队数）。没在远程做分配锁——一个 Agent 就是一台设备、一个接收器，不存在争抢；`start` 只把「排队中」改成「执行中」，已不是排队中就原样返回当前状态，调用方跳过（合并语义，不报错）。
- **离线判定在远程**：Agent 在线 = 心跳 90 秒内。发消息时 @ 的 Agent 不在线或没共享 → 任务直接 `offline`（离线不补跑，需求 R11）；远程每 30 秒扫一次：到期共享关闭并停掉相关任务、掉线 Agent 的排队任务改 `offline`、执行中超过 3 分钟没心跳的改 `failed`（「所有者本机下线，执行中断」）。
- **本机重启恢复**：接收器每次同步（登记、上游重连、每分钟定时）都对账自己名下 `running` 的任务：不是本进程开始的标 `failed`（「执行中断」），可重试；本进程开始、结果没回写成功的重发结果（见十一节）。
- **上下文组装在本机**：固定层进 developerInstructions（建线程时），话题层 + 近邻层作为回合输入；续接同一话题时只追加上次之后的新消息。按字数预算主动降级（近邻 20 → 5 → 0 条），不等模型报超长。
- **执行过程上传**：完成 / 失败 / 停止时把这一回合的事件（`EventEnvelope[]`，单条输出截 4000 字、总量截 1.5MB）回写到任务；执行中按 3 秒节流回写进度一句话。运行详情前端直接用会话时间线投影渲染。
- **房间文件独立根目录**：`REQUIREMENTS_ROOM_FILE_ROOT`（缺省为附件根目录同级的 `<附件根>-rooms`），不与需求附件混用，免得两边的启动清理互相影响；房间文件不做任何启动删除，只清半截上传。
- **默认房间惰性创建**：列项目房间时 `INSERT … ON CONFLICT DO NOTHING`，名称读时取项目名（名称跟随项目）；不改项目创建事务，房间模块与协作模块解耦。默认房间成员是隐式的全部用户，成员行在读 / 记已读时惰性建立。
- **推送带内容但只对房间事件**：房间事件带消息全文与任务状态，客户端直接写缓存；需求事件仍只提示刷新。序号 id 在进程内单调，重启后从 1 重来——客户端发现 `ready` 帧里的 `epoch` 变了就按房间序号补拉。
- **「今天」到期时间由浏览器算**：开共享时浏览器传本地当天结束时刻，服务端只校验在未来 24 小时内，否则退回服务端时区的当天结束。

---

## 四、核心流程 / 逻辑

### 4.1 发消息与唤起 Agent

```
浏览器 POST /api/v2/rooms/:id/messages {clientId, body, mentions, threadRootId, fileIds}
  本机服务原样转发 → 远程 MessageService.send（一个事务）
    已有 (room, clientId) → 返回那一条（200），不重复建任务
    UPDATE rooms SET last_seq = last_seq + 1 RETURNING last_seq   （按房间串行分配序号）
    INSERT room_messages；关联文件；话题根 reply_count + 1
    发送人自动成为成员（需求房间）；发送人已读到本条
    对每个 @Agent：
      共享开着且 Agent 在线 → INSERT agent_runs(status=queued)
      否则                  → INSERT agent_runs(status=offline, reason=未共享 / 不在线)
  提交后推送 room.message（带消息与 runs）、room.run（每个任务）
```

### 4.2 Agent 执行（所有者本机）

```
RemoteEventsHub 收到 room.run（agent = 本机 Agent，status = queued）或启动时 GET /v2/agent-runs?agentId&status=queued
  → RoomAgentRunner 入队（按 queued_at）
  串行取队首：POST /v2/agent-runs/:id/start → started=false 则跳过
  找 / 建房间任务会话：本机表 room_task_sessions(agent_id, room_id, thread_root_id) → session_id
     新建：会话 kind=room_task，项目 = 房间所属远程项目映射的本机项目（没映射 → finish failed「本机没有关联代码目录」）
           thread/start：安全档 room（只读 + 联网 + never）、developerInstructions = 固定层、dynamicTools = 房间工具 (+需求只读工具)
  组装回合输入（4.4），startTurn
  订阅本机账本：每 3 秒把「查看了 N 个文件 · 运行了 M 条命令」回写 progress
  回合结束：最终回答 → POST …/complete {replyBody, summary, events}；失败 → …/finish failed
  收到 stopRequested → interrupt → …/finish stopped
共享关闭 / 到期 / 本机下线 → 远程停任务；本机收到 stopRequested 照上处理
```

### 4.3 实时与补拉

```
远程 RealtimeHub.publish(roomEvent) → id = ++seq；放进最近 2000 条环形缓冲；写给每条 SSE 连接（event: room）
连接建立：先发 ready {epoch}；带 Last-Event-ID 且同 epoch → 补发缓冲里更大的 id
本机 RemoteEventsHub：一条上游连接（登录后建立，令牌续期后重连），解析后原样转给浏览器连接（含需求事件）
浏览器：room 事件 → setQueryData；断线重连（epoch 变或缺口）→ 对打开的房间 GET messages?after=<本地最大序号>
```

### 4.4 Agent 上下文（默认值）

| 层 | 放哪里 | 内容 |
|---|---|---|
| 固定层 | developerInstructions | 身份（「你是陈思远的 Codex，在 SuDuo 项目「订单中心」的房间「订单中心」里被同事 @」）、能力边界（只读、可联网、只问答与规划、回答全员可见含执行过程）、远程内容不当指令、房间工具用法；需求房间附需求卡（复用 `SessionContextService` 的需求卡，不带笔记） |
| 话题层 | 回合输入 | 话题根 + 话题里的回复（最多 50 条，单条截 1500 字） |
| 近邻层 | 回合输入（新话题） | 触发消息之前、24 小时内的最近 20 条（单条截 500 字，附件只给文件名） |
| 按需层 | 工具 | `suduo_room_history`、`suduo_room_search`、`suduo_room_file_view`；需求房间加 `suduo_requirement_get / comments / attachments / attachment_view / artifact_versions / artifact_fetch` |
| 续接 | 回合输入 | 同一话题再次被 @：只给上次触发之后话题里的新消息 + 新触发消息 |
| 降级 | — | 回合输入超过 40000 字：近邻 20 → 5 → 0，再从最早的话题回复截 |

回合输入示意：

```
[房间近况（触发消息之前，最近 20 条）]
10:01 陈思远：……
10:02 李娜：[图片 订单截图.png]（文件 ID f-1，用 suduo_room_file_view 查看）
[@ 你的消息]
10:05 李娜：@陈思远的Codex 商家后台的订单详情现在能拿到收货信息吗？
请回答这条消息。
```

### 4.5 房间工具（scope `room`）

| 工具 | 参数 | 返回 |
|---|---|---|
| `suduo_room_history` | `beforeSeq?`、`limit?`（≤ 50） | 更早的消息（序号、时间、作者、正文截 500 字、附件名与 ID） |
| `suduo_room_search` | `query`、`limit?` | 正文包含关键词的消息（同上格式） |
| `suduo_room_file_view` | `fileId` | 图片内联（≤ 8MB）、文本内联（≤ 10000 字）、其他存到 `.suduo/rooms/<房间>/files/` 给路径 |

**模拟示例**：李娜在「订单中心」房间 @陈思远的Codex → 远程建任务（排队中）→ 陈思远本机接收器开始 → 建房间任务会话（只读）→ 模型 rg 找到 `MerchantOrderDetailRespVO.java` → 每 3 秒回写「查看了 6 个文件」→ 完成：话题回复「后端已有 receiverSnapshot，前端抽屉没展示……」，任务摘要同句 → 李娜点开话题看完整回答，再点「查看详情」看执行过程。

| 处理规则 | 说明 |
|----------|------|
| 合并（ADR-0004） | 消息 `(room, clientId)`、Agent `(owner, deviceKey, kind)`、开着的共享 `(agent, room)`、待处理申请 `(room, agent, requester)`、任务 `(triggerMessage, agent)`：重复请求返回已有行 |
| 授权（非一致性守卫） | 共享 / 关共享 / 处理申请 / 回写任务只能是 Agent 所有者；停止是触发人或所有者；重试是触发人。不符返回 404「没有这个 Agent / 任务」 |
| 三态 | 房间工具查询失败写「查不到：原因」 |
| 日志 | 本机 `suduo.room_run.*`：开始、完成、失败、停止、耗时；远程 sweep 每次处理条数 |

---

## 五、测试策略

- [ ] 远程（真实 PostgreSQL）：默认房间惰性创建与名称跟随；序号连续；客户端 ID 合并；话题计数；未读与 @ 未读；需求房间初始成员；共享开 / 关 / 重开改时长 / 到期 sweep；申请合并与处理；任务：queued / offline 判定、start 合并、complete 发话题回复、finish、stop、retry、掉线 sweep；文件上传、Range 206 / 416；`auth/refresh`；SSE 房间事件、`Last-Event-ID` 补发；审计约束放宽。
- [ ] 本机：RemoteEventsHub 扇出与重连；令牌续期；Agent 登记与心跳（含 browserActive）；RoomAgentRunner：串行、start 跳过、上下文组装与降级、续接只追加、进度节流、完成 / 失败 / 停止回写、重启标失败；房间工具；安全档 room；会话列表过滤 room_task；代理端点（含 Range 透传）。
- [ ] 前端：房间列表与未读、消息流（虚拟列表、向上翻历史）、Composer（@ 选择、粘贴图片、发送中占位与合并、失败放回草稿）、话题面板、任务状态行、运行详情、共享面板与申请、需求详情「讨论」区块、房间事件写缓存与补拉。
- [ ] 端到端：本机联调栈两个账号（两个浏览器上下文）+ 真实 Codex：A 共享、B @、A 本机执行、B 看到回答与详情；关闭共享后 @ 显示离线未执行；重试。
- [ ] `pnpm typecheck / lint / test`；gate-c 夹具补房间接口，加「讨论」步骤。

---

## 六、数据设计

远程迁移 `cloud/server/migrations/011_rooms_and_shared_agents.sql`（全文见文件）：

| 表 | 关键字段 | 说明 |
|------|----------|------|
| `rooms` | project_id、requirement_id、kind、name、last_seq、created_by、archived_at | 默认房间每项目一个（部分唯一索引）；name 为空 = 用项目名 |
| `room_members` | room_id、user_id、joined_at、last_read_seq | 未读 = last_seq − last_read_seq（只算别人发的） |
| `room_messages` | room_id、seq、client_id、author_kind、author_id、agent_id、body、mentions、thread_root_id、reply_count、last_reply_at | (room, seq) 唯一；(room, client_id) 部分唯一用于合并 |
| `room_files` / `room_message_files` | storage_key、size、sha256 / 消息 ↔ 文件 | 文件先传、发消息时关联 |
| `agents` | owner_id、kind、device_key、device_name、last_seen_at | (owner, device_key, kind) 唯一 |
| `user_presence` | user_id、last_active_at | 真人在线 |
| `agent_shares` | agent_id、room_id、started_at、expires_at、closed_at、closed_reason | 开着的共享 (agent, room) 部分唯一 |
| `agent_share_requests` | room_id、agent_id、requester_id、status | 待处理的部分唯一 |
| `agent_runs` | trigger_message_id、thread_root_id、agent_id、triggered_by、status、progress、summary、reply_message_id、reason、stop_requested、events、queued_at | (trigger, agent) 唯一 |

本机迁移 `016_room_tasks.sql`：`sessions.kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','room_task'))`；`room_task_sessions(agent_id, room_id, thread_root_id, session_id, remote_project_id, room_name, requirement_id, requirement_version, last_trigger_seq, last_run_id, created_at, PRIMARY KEY(agent_id, room_id, thread_root_id))`。本机安装标识存 `<v2 数据目录>/agent-device.json`（没有另建表）。

**任务状态**：`queued` 排队中 → `running` 执行中 → `completed` / `failed` / `stopped`；发消息时不可执行直接 `offline`；`failed` / `stopped` / `offline` 可由触发人重试回到 `queued`（或再次 `offline`）。

---

## 七、接口设计

远程 `/v2`（全部需登录；浏览器只经本机 `/api/v2` 同名端点一比一转发）：

| 端点 | 方法 | 作用 |
|------|------|------|
| `/v2/auth/refresh` | POST | 用有效令牌换新令牌 |
| `/v2/projects/:projectId/rooms` | GET | 项目的房间（含默认房间、需求房间；带当前用户未读） |
| `/v2/requirements/:requirementId/rooms` | GET / POST | 需求的房间 / 新建需求房间 |
| `/v2/rooms/:roomId` | GET / PATCH | 房间详情 / 改名、归档（默认房间不能改名） |
| `/v2/rooms/:roomId/members` | GET / POST | 成员（含在线）/ 加入或拉人 |
| `/v2/rooms/:roomId/read` | POST | 记已读（只前进） |
| `/v2/rooms/:roomId/messages` | GET / POST | `after` / `before` / `threadRootId` 分页 / 发消息（合并重试） |
| `/v2/rooms/:roomId/messages/search` | GET | `q` 关键词搜消息（房间工具用） |
| `/v2/rooms/:roomId/files` | POST | 上传文件（multipart 单文件 `file`，≤ 300MiB） |
| `/v2/room-files/:fileId/content` | GET | 下载 / 内联（`?disposition=inline`）/ `Range` 分段 |
| `/v2/agents` | GET / POST | Agent 列表（含在线）/ 登记本机 Agent（合并） |
| `/v2/agents/:agentId/heartbeat` | POST | 心跳（含 browserActive） |
| `/v2/rooms/:roomId/shares` | GET / POST | 房间的共享 / 开启（或改时长） |
| `/v2/agent-shares/:shareId/close` | POST | 关闭共享（停掉相关任务） |
| `/v2/rooms/:roomId/share-requests` | GET / POST | 待处理申请 / 申请共享（合并） |
| `/v2/share-requests/:requestId/resolve` | POST | 所有者开启或忽略 |
| `/v2/agent-runs` | GET | `agentId`、`status` 过滤（接收器用） |
| `/v2/agent-runs/:runId` | GET | 任务详情（含执行过程） |
| `/v2/agent-runs/:runId/start` | POST | 所有者本机开始（只把排队中改成执行中） |
| `/v2/agent-runs/:runId/progress` | POST | 进度与过程回写 |
| `/v2/agent-runs/:runId/complete` | POST | 完成：发话题回复、写摘要与过程 |
| `/v2/agent-runs/:runId/finish` | POST | 失败 / 已停止 |
| `/v2/agent-runs/:runId/stop` | POST | 触发人或所有者停止 |
| `/v2/agent-runs/:runId/retry` | POST | 触发人重试 |
| `/v2/events` | GET | 增加命名事件 `room`（见契约 `RoomEventDto`）；`ready` 帧带 `epoch`；支持 `Last-Event-ID` |

本机额外端点：`GET /api/v2/agents/self`（本机 Agent 登记状态与在线）。契约：`cloud/contracts/src/rooms.ts`。

---

## 八、文件结构 / 变更清单

```
cloud/server/
  migrations/011_rooms_and_shared_agents.sql
  src/infrastructure/storage/{blob-store,local-disk-blob-store}.ts
  src/infrastructure/rooms/{room,message,file,agent,share,run}-repository.ts
  src/application/rooms/{room,message,file,agent,share,run}-service.ts、realtime-hub.ts、room-sweeper.ts
  src/http/routes/{rooms,agents,agent-runs}-routes.ts、multipart.ts（从 server.ts 抽出单文件上传）
client/server/
  src/infrastructure/db/migrations/016_room_tasks.sql
  src/application/remote-events-hub.ts、token-refresher.ts、agent-presence.ts
  src/application/room-agent/{runner,context,progress}.ts
  src/application/session-tools/room-tools.ts（catalog 加 scope room）
  src/infrastructure/http/routes/rooms-routes.ts
client/web/src/features/rooms/
  keys.ts queries.ts realtime.ts RoomsPage.tsx
  components/{RoomList,MessageStream,MessageItem,RoomComposer,MentionPicker,ThreadPanel,RunStatusLine,AgentRunDetail,ShareAgentPanel,RoomFile}.tsx
  sections/RequirementRooms.tsx
```

- `[MODIFY] cloud/server/src/http/server.ts`：注册路由、`/v2/events` 房间事件、`/v2/auth/refresh`。
- `[MODIFY] cloud/server/src/application.ts`、`config.ts`：组装、房间文件根目录与扩展名（加 mp4 / webm / mov / m4v）。
- `[MODIFY] client/server/src/infrastructure/requirements-v2/remote-client.ts`：房间相关方法、Range 与 Last-Event-ID 透传、`refresh`。
- `[MODIFY] client/server/src/infrastructure/http/http-server.ts`：`/api/v2/events` 改订阅 hub。
- `[MODIFY] client/server/src/infrastructure/runtime/codex/codex-runtime.ts`：安全档 room 放行；`client/contracts/src/config.ts` 加 `ROOM_AGENT_SECURITY_POLICY`。
- `[MODIFY] client/server/src/application/{session-service,message-service,runtime-supervisor}.ts`、`session-list-repository.ts`：会话 kind 与安全档。
- `[MODIFY] client/web/src/app/{router.tsx,shell/Sidebar.tsx,shell/AppShell.tsx,shell/CommandPalette.tsx}`、`features/requirements/RequirementDetailPage.tsx`、`features/sessions/SessionsPage.tsx`（房间任务筛选）。

---

## 九、依赖与配置

| 配置 key | 默认值 | 说明 |
|----------|--------|------|
| `REQUIREMENTS_ROOM_FILE_ROOT` | `<REQUIREMENTS_ATTACHMENT_ROOT>-rooms` | 房间文件根目录（绝对路径，SuDuo 独占） |
| 心跳 / 在线 | 30 秒 / 90 秒 | 常量 |
| 远程 sweep | 30 秒 | 常量 |
| 推送环形缓冲 | 2000 条 | 常量 |

---

## 十、迁移影响与风险

- **受影响**：远程 `/v2/events`（加命名事件）、审计约束、本机事件转发方式、会话列表（多一个筛选）、Windows 版空闲退出（共享期间常驻）。
- **打法**：S1 房间与文本消息 → S2 存储与媒体 → S3 Agent / 共享 / 在线 / 续期 → S4 @Agent 执行与三层展示；每片可演示、可验收。实现时远程、本机、前端三条线并行，契约先定。
- **回滚**：远程迁移只新增表与放宽约束，旧版本服务可在新库上运行；本机迁移只加列与表。

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 所有者本机空闲退出 / 令牌过期 → Agent 莫名离线 | 高 | 共享不可用 | 共享期间 retainStream 常驻；过期前续期；离线原因写进任务 |
| 推送在内存，服务重启丢事件 | 低 | 短暂不同步 | epoch 变化 → 按房间序号补拉 |
| 执行过程含代码与命令输出，存进服务器 | 确定 | 数据边界变化 | 用户已决定完整展示、不加约束；写进 ADR-0009；共享开关与时长由所有者控制 |
| 只读沙箱可读整盘，房间里的人能借 Agent 读所有者电脑上的文件 | 中 | 信息外流 | 用户已决定不做系统限制；ADR-0009 记明，所有者通过「主动共享、随时关」控制 |
| 话题很长 / 房间很活跃时上下文超长 | 中 | 回答失败 | 字数预算与逐级降级；历史靠工具按需翻 |
| 视频经本机服务转发 | 中 | 卡顿 | Range 分段透传、不缓冲整文件 |

---

## 十一、实现记录（2026-10-01）

与上文设计的差异与补充，按实现为准：

| 项 | 实现 |
|---|---|
| room-resync 时机 | 本机上游**每次重连**都给浏览器发（不只在发现缺口时）：需求事件不补发，浏览器到本机的连接在上游断线期间一直开着，否则页面不知道漏了需求事件。浏览器收到后刷新房间与需求数据 |
| Last-Event-ID | 只认数字的房间事件 id；本机 hub 单独记最后一个房间事件 id 与 epoch |
| 推送背压 | 单连接积压超过 8MB 才断开（房间事件带正文，原「write 返回 false 即断」会误断） |
| 本机 runner 兜底 | 20 分钟没有新事件按失败收尾；发中断后最多等 30 秒终态；执行中约 15 秒随进度上传一次过程（运行中也能看详情）；回答超 10 万字截断；远程 4xx 拒收回答时改 finish failed |
| 停止原因文案 | 开始执行前被叫停 / 执行中被叫停 / 在所有者电脑上被中断（本机会话页停止房间任务） |
| 房间文件下载 | 本机代理加 `nosniff` 与 `Content-Security-Policy: sandbox`，远程文件不能以本机源执行脚本；svg / html 一律下载 |
| 默认房间 | 惰性创建，created_by 取项目创建人，不写审计；共享到期由 sweeper 关闭，不写审计（没有操作人） |
| 房间工具文案 | 契约 `SUDUO_ROOM_TOOL_LABELS`：翻看房间消息 / 搜索房间消息 / 查看房间文件 |

**独立审查后的修正（2026-10-01）**

| 项 | 实现 |
|---|---|
| 房间图片交给模型 | `suduo_room_file_view` 按 `disposition=inline` 取文件（附件下载一律 octet-stream，图片会被当普通文件存盘） |
| 回写不卡死 | 结果带执行过程发不出去 → 退一步不带执行过程再发（远程 complete 收到空过程时保留执行中已上传的）→ 仍因远程暂不可用失败就记在内存里，下次同步重发。登录失效（401 / 403）与本机报的「未配置 / 地址已变」按暂不可用处理（重新登录后能发），只有远程的 400 / 404 / 413 等算不收。同一任务被重试后重新开始时，旧的未回写结果作废。本机与远程都去掉 NUL（PostgreSQL 拒收，原来会稳定 500） |
| 开始失败不卡排队 | `start` 网络 / 5xx 失败按 5s→15s→30s→60s 退避安排同步重取；另每 60 秒定时同步一次 |
| 停止信号兜底 | 定时同步对账执行中的任务，推送丢了也能拿到 `stopRequested` |
| 恢复与开始的竞态 | 记本进程开始过 / 正在开始 / 已收尾的任务：同步拿到的执行中列表是旧快照时不会重复收尾，也不会误标「本机服务重启」；start 响应丢了的标「开始执行时与需求服务的连接中断，这次没有执行」 |
| 关共享与发消息并发 | 远程 `start` 再查一次共享，已不生效就置已停止「共享已关闭」、`started=false`（状态迁移，不是拒绝） |
| 执行过程只传本回合 | 按回合 ID（用户消息按 `clientTurnId`）过滤；房间任务会话在会话页只读 |
| 线程重建 | 续接失败重建线程时，固定层附「这个话题此前的讨论」（到上次被 @ 为止的消息 + 自己之前的回答，证据段包裹），与本回合的续接输入合起来完整 |
| MCP 与连接器 | 房间 Agent 档建线程 / 续接都带配置覆盖：按生效配置逐个关 MCP server 与单独开着的连接器、连接器默认关；读不到配置不建线程（ADR-0009）。真实 Codex 0.159.2 实测：嵌套对象覆盖深合并生效；续接不带覆盖时 MCP 会重新启动 |
| 话题面板 | 回复多于一页时单独取根、「加载更早的回复」翻页；话题重取与缓存合并，不丢已翻出的与重取期间推送进来的 |
| 归档房间 | 不再 409：界面只读，服务端收下晚到的消息（ADR-0004 判据） |
| 本机代理 | 去掉浏览器用不上的登记、心跳、任务列表与开始 / 进度 / 完成 / 收尾 |
| 推送缓冲 | 远程补发缓冲另加 32MB 字节上限 |
| 默认房间 | 先查后插，列房间不再每次写库 |

验证：远程 109 测、本机 421 测、前端 508 测；本机联调栈两个本机实例 + 两个账号 + 真实 Codex（中转站 gpt-6-sol）：共享 → @ → 本机只读执行（约 24 秒）→ 话题回复；关闭共享后 @ 显示「离线，未执行」，重新共享后重试完成；执行中停止保留过程；需求房间里 Agent 调用需求工具；所有者在会话页「房间任务」看到执行。

## 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-10-01 | v1.0 | 初版 |
| 2026-10-01 | v1.1 | 补实现记录（十一节） |
| 2026-10-01 | v1.2 | 独立审查后的修正（十一节） |
