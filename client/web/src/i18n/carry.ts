/**
 * 切换语言不丢用户的输入（中英双语 S9）。
 *
 * 切换语言时 LocaleBoundary 用 key 按新语言重建整棵界面（provider.tsx），组件里的状态会随之清空。这里管三件事：
 *
 * 1. 带过重建：组件把要保住的状态（会话输入框的草稿、排队的消息……）登记成快照来源，
 *    locale.ts 在真的要重建之前统一拍一次；重建后同一个 key 的组件挂载时读回（provider.tsx 的 useCarried）。
 *    只在语言切换这一刻生效：平时离开页面、切会话照旧，不改原来的行为。
 * 2. 保不住的：打开的对话框、还没保存的表单。组件登记「现在切换会丢东西」的检查；
 *    设置页的语言选项据此先确认，别的标签页改了语言时这个标签页先不跟，等这些处理完再切（locale.ts）。
 * 3. 卸载时的清理分得清「真的离开」和「按新语言重建」：重建期间 isLocaleRebuilding() 为 true
 *    （例如悬浮的房间窗口在外壳卸载时关掉，重建时不能关）。
 *
 * 不依赖 React（locale.ts 也用它）；React 里用 provider.tsx 的 useCarried / useCarrySource / useLossCheck。
 */

const sources = new Map<string, () => unknown>();
let carried = new Map<string, unknown>();
const lossChecks = new Set<() => boolean>();
/** 挂着的 LocaleBoundary 数：没有时语言切换不会重建界面（如单独渲染组件的测试），也就不算「正在重建」。 */
let boundaries = 0;
/**
 * 拍了快照、新语言的界面还没挂好：LocaleBoundary 在重建提交后的微任务里清掉；万一没清，过一会儿自己清。
 * 清的时候没被读走的快照一并丢掉，免得以后正常挂载时冒出旧状态（例如绕过「刷新后队列先暂停」）。
 */
let rebuilding = false;
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
const REBUILD_FALLBACK_MS = 1_000;
const afterRebuild = new Set<() => void>();

/** 登记一个快照来源；返回注销函数。同一个 key 后登记的覆盖先登记的。 */
export function registerCarrySource(key: string, snapshot: () => unknown): () => void {
  sources.set(key, snapshot);
  return () => {
    if (sources.get(key) === snapshot) sources.delete(key);
  };
}

/** 重建前拍下所有登记的状态（locale.ts 在界面语言真的变了、通知订阅者之前调用）。上一次没被读走的一并作废。 */
export function captureCarry(): void {
  if (boundaries > 0) {
    rebuilding = true;
    if (rebuildTimer !== null) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(finishLocaleRebuild, REBUILD_FALLBACK_MS);
  }
  const next = new Map<string, unknown>();
  for (const [key, snapshot] of sources) {
    try {
      next.set(key, snapshot());
    } catch {
      // 某一处拍不下来不影响别处，也不能挡住切换。
    }
  }
  carried = next;
}

/**
 * 重建后读回；不删除——StrictMode 下初始化会跑两次，挂载提交后再由 dropCarried 删掉，
 * 重建结束（finishLocaleRebuild）时没读走的也清掉。没有对应的快照时返回 undefined。
 */
export function peekCarried<T>(key: string): T | undefined {
  return carried.get(key) as T | undefined;
}

export function dropCarried(key: string): void {
  carried.delete(key);
}

/** 是否正在按新语言重建（从拍快照到新界面挂好）。卸载时的清理据此判断是不是真的离开。 */
export function isLocaleRebuilding(): boolean {
  return rebuilding;
}

/** LocaleBoundary 挂载时登记；返回注销函数。 */
export function registerLocaleBoundary(): () => void {
  boundaries += 1;
  return () => {
    boundaries -= 1;
  };
}

/** 新语言的界面已经挂好（LocaleBoundary 在重建提交后的微任务里调用）：结束「正在重建」，丢掉没被读走的快照。 */
export function finishLocaleRebuild(): void {
  rebuilding = false;
  if (rebuildTimer !== null) clearTimeout(rebuildTimer);
  rebuildTimer = null;
  carried = new Map();
  const callbacks = [...afterRebuild];
  afterRebuild.clear();
  for (const callback of callbacks) callback();
}

/**
 * 重建结束后再调一次（只一次）；返回注销函数。重建期间先不做、等结束再看的事用它
 * （例如会话页重建期间不出队：被换掉的那一份注销了就不会再调；语言来回切、没真的重建时照常接着做）。
 */
export function afterLocaleRebuild(callback: () => void): () => void {
  afterRebuild.add(callback);
  return () => {
    afterRebuild.delete(callback);
  };
}

/** 登记「现在切换语言会丢东西」的检查；返回注销函数。 */
export function registerLossCheck(check: () => boolean): () => void {
  lossChecks.add(check);
  return () => {
    lossChecks.delete(check);
  };
}

/**
 * 现在按新语言重建，会不会丢掉带不过去的东西：打开着的对话框（含弹出层），或某处登记的检查说有。
 * 对话框按 DOM 判断（Radix 的对话框与弹出层打开时是 role=dialog / alertdialog 且 data-state=open），
 * 不用每个对话框各自登记。
 */
export function switchWouldLoseWork(): boolean {
  if (
    typeof document !== "undefined" &&
    document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !== null
  ) {
    return true;
  }
  for (const check of lossChecks) {
    try {
      if (check()) return true;
    } catch {
      // 检查本身出错时当作没有：不因此永远切不过去。
    }
  }
  return false;
}

/** 测试用：清空登记与快照。 */
export function resetCarry(): void {
  sources.clear();
  lossChecks.clear();
  afterRebuild.clear();
  finishLocaleRebuild();
}
