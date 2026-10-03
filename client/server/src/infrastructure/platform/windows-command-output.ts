export interface WindowsCommandOutput {
  bytes: number;
  base64: string;
  utf8: string;
  gbk: string;
}

export function decodeWindowsCommandOutput(
  value: Buffer | null | undefined,
): WindowsCommandOutput {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.alloc(0);
  return {
    bytes: buffer.length,
    base64: buffer.toString("base64"),
    utf8: decode(buffer, "utf-8"),
    gbk: decode(buffer, "gbk"),
  };
}

export function formatWindowsCommandOutput(
  value: Buffer | null | undefined,
): string {
  const output = decodeWindowsCommandOutput(value);
  return (
    `bytes=${String(output.bytes)} base64=${output.base64} ` +
    `utf8=${JSON.stringify(output.utf8)} gbk=${JSON.stringify(output.gbk)}`
  );
}

function decode(buffer: Buffer, encoding: string): string {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(buffer);
  } catch (error) {
    return `<decode failed: ${error instanceof Error ? error.message : String(error)}>`;
  }
}
