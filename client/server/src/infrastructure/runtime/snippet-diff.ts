/**
 * Agent 只给出替换前后的片段、没有行号时（Claude 的 Edit / MultiEdit、ACP 的 diff 内容）：生成一个只含改动行的统一 diff 片段，
 * 首尾相同的行作为上下文。只供时间线的改动卡显示与计数；准确的工作区改动另由 Git 检查点给出。
 */
export function snippetDiff(path: string, before: string, after: string): string {
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
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${String(oldLines.length)} +1,${String(newLines.length)} @@`,
    ...oldLines.slice(0, head).map((line) => " " + line),
    ...oldLines.slice(head, oldLines.length - tail).map((line) => "-" + line),
    ...newLines.slice(head, newLines.length - tail).map((line) => "+" + line),
    ...oldLines.slice(oldLines.length - tail).map((line) => " " + line),
  ];
  return lines.join("\n") + "\n";
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
