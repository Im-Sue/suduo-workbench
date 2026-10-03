/**
 * 实时连接是否在线（模块级，供数据层判断「成功后能否靠自己的实时回声校正看板」）。
 * 由 RequirementsRealtimeProvider 维护；没挂载 Provider 时视为不在线。
 */
let live = false;

export function setRealtimeLive(value: boolean): void {
  live = value;
}

export function isRealtimeLive(): boolean {
  return live;
}
