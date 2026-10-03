import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function createInstallLogger(logPath) {
  return (message) => appendInstallLog(logPath, message);
}

export function appendInstallLog(logPath, message, now = new Date()) {
  appendFileSync(logPath, `[${now.toISOString()}] ${message}\r\n`, "utf8");
}

export function runNativeCommand(command, args, options) {
  const label = options.label ?? command;
  options.log(`COMMAND ${label}: ${formatCommandLine(command, args)}`);
  const result = spawnSync(command, args, {
    encoding: null,
    windowsHide: true,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  options.log(
    `RESULT ${label}: status=${String(result.status)} signal=${String(result.signal)} error=${result.error?.message ?? "none"}`,
  );
  options.log(formatBufferedOutput("stdout", result.stdout));
  options.log(formatBufferedOutput("stderr", result.stderr));
  if (options.required && result.status !== 0) {
    throw new Error(`${label} 失败（status=${String(result.status)}）`);
  }
  return result;
}

export function formatBufferedOutput(label, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.alloc(0);
  return [
    `${label}.bytes=${String(buffer.length)}`,
    `${label}.base64=${buffer.toString("base64")}`,
    `${label}.utf8=${JSON.stringify(decode(buffer, "utf-8"))}`,
    `${label}.gbk=${JSON.stringify(decode(buffer, "gbk"))}`,
  ].join(" ");
}

function decode(buffer, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(buffer);
  } catch (error) {
    return `<decode failed: ${error instanceof Error ? error.message : String(error)}>`;
  }
}

function formatCommandLine(command, args) {
  return [command, ...args].map(quoteArgument).join(" ");
}

function quoteArgument(value) {
  return /[\s"&<>|]/.test(value)
    ? `"${value.replaceAll('"', '\\"')}"`
    : value;
}
