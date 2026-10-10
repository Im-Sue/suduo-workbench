/**
 * 两份全文 → 统一 diff（多个 hunk，每处改动前后各留 3 行上下文），给跨会话读取的「累计改动」用（多 Agent 协作 S7）。
 *
 * 先去掉首尾相同的行，中间用 Myers 算最少改动；中间部分太大（改动太多）时不再细算，整段按「删掉旧的、换上新的」给出，
 * 并在 hunk 前注明——宁可粗，也不能让人误以为删了一大片却看不到新增。
 */

const CONTEXT = 3;
/** 中间部分（去掉首尾相同行之后）两边行数之和超过它就不细算。 */
const MAX_MIDDLE_LINES = 20_000;
/** Myers 最多走多少步（改动行数的量级）；超过就按整段替换。 */
const MAX_EDIT_DISTANCE = 4_000;

type Op = { kind: " " | "-" | "+"; line: string };

export interface LineDiffResult {
  /** 统一 diff 文本（含 ---/+++ 头）；两边相同时为空串。 */
  text: string;
  additions: number;
  deletions: number;
  /** 改动太多、按整段替换给出的。 */
  coarse: boolean;
}

export function lineDiff(path: string, before: string, after: string): LineDiffResult {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head += 1;
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }
  const oldMiddle = oldLines.slice(head, oldLines.length - tail);
  const newMiddle = newLines.slice(head, newLines.length - tail);
  if (oldMiddle.length === 0 && newMiddle.length === 0) return { text: "", additions: 0, deletions: 0, coarse: false };

  let middle: Op[] | null = null;
  if (oldMiddle.length + newMiddle.length <= MAX_MIDDLE_LINES) middle = myers(oldMiddle, newMiddle, MAX_EDIT_DISTANCE);
  const coarse = middle === null;
  middle ??= [...oldMiddle.map((line): Op => ({ kind: "-", line })), ...newMiddle.map((line): Op => ({ kind: "+", line }))];

  const ops: Op[] = [
    ...oldLines.slice(0, head).map((line): Op => ({ kind: " ", line })),
    ...middle,
    ...oldLines.slice(oldLines.length - tail).map((line): Op => ({ kind: " ", line })),
  ];
  const additions = middle.filter((op) => op.kind === "+").length;
  const deletions = middle.filter((op) => op.kind === "-").length;
  return { text: [`--- a/${path}`, `+++ b/${path}`, ...hunks(ops)].join("\n"), additions, deletions, coarse };
}

/** 按改动分 hunk：相邻改动之间隔不到 2×上下文行的并成一个。 */
function hunks(ops: readonly Op[]): string[] {
  const changed = ops.map((op, index) => (op.kind === " " ? -1 : index)).filter((index) => index >= 0);
  const lines: string[] = [];
  let cursor = 0;
  while (cursor < changed.length) {
    const first = changed[cursor]!;
    let last = first;
    while (cursor + 1 < changed.length && changed[cursor + 1]! - last <= CONTEXT * 2 + 1) {
      cursor += 1;
      last = changed[cursor]!;
    }
    cursor += 1;
    const from = Math.max(0, first - CONTEXT);
    const to = Math.min(ops.length, last + CONTEXT + 1);
    // 这一段之前有多少旧行、新行（算 hunk 头的起始行号）。
    let oldStart = 0;
    let newStart = 0;
    for (const op of ops.slice(0, from)) {
      if (op.kind !== "+") oldStart += 1;
      if (op.kind !== "-") newStart += 1;
    }
    const slice = ops.slice(from, to);
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    lines.push(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`, ...slice.map((op) => op.kind + op.line));
  }
  return lines;
}

/** hunk 头的「起始,行数」：行数为 0 时起始按惯例写前一行。 */
function range(start: number, count: number): string {
  return count === 0 ? `${String(start)},0` : `${String(start + 1)},${String(count)}`;
}

/** Myers 最短编辑序列；超过 maxD 步返回 null。 */
function myers(a: readonly string[], b: readonly string[], maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const offset = n + m;
  const v = new Int32Array(2 * offset + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(n + m, maxD); d += 1) {
    // 只存这一步用到的 k 范围，回溯时够用。
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
  }
  return null;
}

function backtrack(a: readonly string[], b: readonly string[], trace: readonly Int32Array[], dEnd: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d -= 1) {
    const v = trace[d]!;
    // trace[d] 存的是第 d 步开始前的 v，下标范围 [-d, d] → [0, 2d]。
    const at = (k: number) => v[k + d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: " ", line: a[x]! });
    }
    if (x === prevX) {
      y -= 1;
      ops.push({ kind: "+", line: b[y]! });
    } else {
      x -= 1;
      ops.push({ kind: "-", line: a[x]! });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    ops.push({ kind: " ", line: a[x]! });
  }
  return ops.reverse();
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}
