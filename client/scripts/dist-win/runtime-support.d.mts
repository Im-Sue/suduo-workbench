import type { SpawnSyncReturns } from "node:child_process";

export function createInstallLogger(
  logPath: string,
): (message: string) => void;
export function appendInstallLog(
  logPath: string,
  message: string,
  now?: Date,
): void;
export function runNativeCommand(
  command: string,
  args: string[],
  options: {
    label?: string;
    required: boolean;
    log(message: string): void;
    input?: string | Buffer;
  },
): SpawnSyncReturns<Buffer>;
export function formatBufferedOutput(
  label: string,
  value: Buffer | null,
): string;
