/**
 * 进程内记住「已经推送过在线」的 Agent 与真人，用来只在状态变化时推送
 * `agent.presence` / `user.presence`：心跳让它上线（推一次），扫描发现超时让它下线（推一次）。
 * 服务重启后集合为空：扫描会把数据库里仍在线的静默补进来，不重复推送。
 */
export class PresenceTracker {
  private readonly agents = new Set<string>();
  private readonly users = new Set<string>();

  /** 返回 true = 刚上线（需要推送）。 */
  markAgentOnline(agentId: string): boolean {
    if (this.agents.has(agentId)) return false;
    this.agents.add(agentId);
    return true;
  }

  markUserOnline(userId: string): boolean {
    if (this.users.has(userId)) return false;
    this.users.add(userId);
    return true;
  }

  /** 与数据库里当前在线的集合对账：返回刚下线的（需要推送），并静默补上未记录的在线者。 */
  reconcileAgents(online: ReadonlySet<string>): string[] {
    return reconcile(this.agents, online);
  }

  reconcileUsers(online: ReadonlySet<string>): string[] {
    return reconcile(this.users, online);
  }
}

function reconcile(known: Set<string>, online: ReadonlySet<string>): string[] {
  const wentOffline: string[] = [];
  for (const id of known) {
    if (!online.has(id)) {
      known.delete(id);
      wentOffline.push(id);
    }
  }
  for (const id of online) known.add(id);
  return wentOffline;
}
