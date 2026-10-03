/**
 * 行级 diff（零依赖）。
 *
 * 复杂度上限（consult 结论 Q2）：去掉公共前后缀后，任一侧超过 MAX_SIDE 行
 * 或 N×M 超过 MAX_CELLS 时放弃行级对齐，降级为双列全文模式。
 */

export interface DiffRow {
  kind: "context" | "add" | "del" | "hunk";
  beforeLine: number | null;
  afterLine: number | null;
  text: string;
}

export type DiffResult =
  | { mode: "unified"; rows: DiffRow[]; adds: number; dels: number }
  | { mode: "split"; before: string[]; after: string[] };

const MAX_SIDE = 2000;
const MAX_CELLS = 1_000_000;
const CONTEXT = 3;

export function computeDiff(beforeText: string, afterText: string): DiffResult {
  const before = toLines(beforeText);
  const after = toLines(afterText);

  // 公共前后缀裁剪，缩小 LCS 规模。
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  const midBefore = before.slice(head, before.length - tail);
  const midAfter = after.slice(head, after.length - tail);

  if (
    midBefore.length > MAX_SIDE ||
    midAfter.length > MAX_SIDE ||
    midBefore.length * midAfter.length > MAX_CELLS
  ) {
    return { mode: "split", before, after };
  }

  const ops: DiffRow[] = [];
  let beforeNo = 1;
  let afterNo = 1;
  const pushContext = (count: number) => {
    for (let index = 0; index < count; index += 1) {
      ops.push({
        kind: "context",
        beforeLine: beforeNo,
        afterLine: afterNo,
        text: before[beforeNo - 1] ?? "",
      });
      beforeNo += 1;
      afterNo += 1;
    }
  };

  pushContext(head);
  for (const op of lcsOps(midBefore, midAfter)) {
    if (op.kind === "context") {
      ops.push({ kind: "context", beforeLine: beforeNo, afterLine: afterNo, text: op.text });
      beforeNo += 1;
      afterNo += 1;
    } else if (op.kind === "del") {
      ops.push({ kind: "del", beforeLine: beforeNo, afterLine: null, text: op.text });
      beforeNo += 1;
    } else {
      ops.push({ kind: "add", beforeLine: null, afterLine: afterNo, text: op.text });
      afterNo += 1;
    }
  }
  pushContext(tail);

  return collapseContext(ops);
}

/** 标准 DP LCS 回溯为 del/add/context 序列。 */
function lcsOps(
  before: string[],
  after: string[],
): { kind: "context" | "add" | "del"; text: string }[] {
  const rows = before.length;
  const cols = after.length;
  if (rows === 0 && cols === 0) {
    return [];
  }
  const width = cols + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      table[row * width + col] =
        before[row] === after[col]
          ? (table[(row + 1) * width + col + 1] ?? 0) + 1
          : Math.max(
              table[(row + 1) * width + col] ?? 0,
              table[row * width + col + 1] ?? 0,
            );
    }
  }
  const ops: { kind: "context" | "add" | "del"; text: string }[] = [];
  let row = 0;
  let col = 0;
  while (row < rows && col < cols) {
    if (before[row] === after[col]) {
      ops.push({ kind: "context", text: before[row] ?? "" });
      row += 1;
      col += 1;
    } else if (
      (table[(row + 1) * width + col] ?? 0) >= (table[row * width + col + 1] ?? 0)
    ) {
      ops.push({ kind: "del", text: before[row] ?? "" });
      row += 1;
    } else {
      ops.push({ kind: "add", text: after[col] ?? "" });
      col += 1;
    }
  }
  while (row < rows) {
    ops.push({ kind: "del", text: before[row] ?? "" });
    row += 1;
  }
  while (col < cols) {
    ops.push({ kind: "add", text: after[col] ?? "" });
    col += 1;
  }
  return ops;
}

/** 折叠远离改动的 context 行，只保留每处改动前后 CONTEXT 行，中断处插入 hunk 行。 */
function collapseContext(ops: DiffRow[]): DiffResult {
  const changed = ops.map((op) => op.kind !== "context");
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let index = 0; index < ops.length; index += 1) {
    if (!changed[index]) {
      continue;
    }
    for (
      let nearby = Math.max(0, index - CONTEXT);
      nearby <= Math.min(ops.length - 1, index + CONTEXT);
      nearby += 1
    ) {
      keep[nearby] = true;
    }
  }

  let adds = 0;
  let dels = 0;
  const rows: DiffRow[] = [];
  let skipping = false;
  const anyChange = changed.some(Boolean);
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];
    if (!op) {
      continue;
    }
    if (op.kind === "add") {
      adds += 1;
    }
    if (op.kind === "del") {
      dels += 1;
    }
    if (!anyChange || keep[index]) {
      if (skipping) {
        rows.push({ kind: "hunk", beforeLine: null, afterLine: null, text: "⋯" });
        skipping = false;
      }
      rows.push(op);
    } else {
      skipping = true;
    }
  }
  if (skipping) {
    rows.push({ kind: "hunk", beforeLine: null, afterLine: null, text: "⋯" });
  }
  return { mode: "unified", rows, adds, dels };
}

function toLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}
