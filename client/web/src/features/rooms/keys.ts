/**
 * 房间模块的查询键（需求 suduo-v2-rooms-shared-agent-001）。按前缀组织：
 * - ["rooms", "project", projectId] / ["rooms", "requirement", requirementId]：房间列表（带当前用户未读）；
 * - ["rooms", "room", roomId, …]：单个房间的详情、成员、消息、话题、共享、申请；
 * - ["rooms", "agents", …]：Agent 列表与本机 Agent 状态；
 * - ["rooms", "run", runId]：运行详情（完整执行过程）。
 * 断线补拉时没人在看的消息 / 话题缓存直接丢掉，其余整组 ["rooms"] 失效；打开着的消息查询自己按序号增量补
 * （见 realtime.ts 的 resyncRooms、queries.ts 的 fetchMessages）。
 */
export const roomKeys = {
  all: ["rooms"] as const,
  lists: ["rooms", "list"] as const,
  projectRooms: (projectId: string) => ["rooms", "list", "project", projectId] as const,
  requirementRooms: (requirementId: string) => ["rooms", "list", "requirement", requirementId] as const,
  room: (roomId: string) => ["rooms", "room", roomId] as const,
  detail: (roomId: string) => ["rooms", "room", roomId, "detail"] as const,
  members: (roomId: string) => ["rooms", "room", roomId, "members"] as const,
  messages: (roomId: string) => ["rooms", "room", roomId, "messages"] as const,
  threads: (roomId: string) => ["rooms", "room", roomId, "thread"] as const,
  thread: (roomId: string, rootId: string) => ["rooms", "room", roomId, "thread", rootId] as const,
  shares: (roomId: string) => ["rooms", "room", roomId, "shares"] as const,
  shareRequests: (roomId: string) => ["rooms", "room", roomId, "share-requests"] as const,
  agents: ["rooms", "agents"] as const,
  selfAgent: ["rooms", "agents", "self"] as const,
  run: (runId: string) => ["rooms", "run", runId] as const,
};
