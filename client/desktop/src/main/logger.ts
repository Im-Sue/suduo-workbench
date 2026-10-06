import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const ROTATE_BYTES = 5 * 1024 * 1024;

/** 外壳自己的日志 desktop.log（本机服务的输出另在 suduo.log）。写不进去不影响运行。 */
export function createLogger(file: string, echo: boolean): (message: string) => void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (statSync(file).size > ROTATE_BYTES) renameSync(file, file + ".1");
  } catch {
    // 还没有日志文件。
  }
  return (message: string) => {
    const line = `${new Date().toISOString()} ${message}\n`;
    if (echo) process.stdout.write(line);
    try {
      appendFileSync(file, line);
    } catch {
      // 磁盘满、目录被删等：忽略。
    }
  };
}
