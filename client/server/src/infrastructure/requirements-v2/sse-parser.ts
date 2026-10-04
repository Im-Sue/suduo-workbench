export interface ServerSentEvent {
  event: string;
  data: string;
  id?: string;
  retryMs?: number;
}

export interface ConsumeServerSentEventsOptions {
  signal?: AbortSignal;
  onEvent(event: ServerSentEvent): void | Promise<void>;
  /** 收到任意字节（包括注释心跳）即调用，供连接 watchdog 续期。 */
  onActivity?(): void;
}

/**
 * 最小 SSE 消费器。它以字节流而不是 fetch chunk 为事件边界，遵守 SSE 的
 * data 多行、CRLF 与空行提交规则；EOF 未提交的半个事件会被丢弃。
 */
export async function consumeServerSentEvents(
  response: Response,
  options: ConsumeServerSentEventsOptions,
): Promise<void> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("text/event-stream")) {
    throw new Error("Remote SSE response has an invalid Content-Type");
  }
  if (!response.body) throw new Error("Remote SSE response has no body");
  const parser = new ServerSentEventParser(options.onEvent);
  const reader = response.body.getReader();
  const abort = () => void reader.cancel().catch(() => undefined);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      options.onActivity?.();
      await parser.push(value);
    }
    // 特意不调用 flush：没有空行终止的 EOF 事件不可信，必须丢弃。
  } finally {
    options.signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export class ServerSentEventParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private eventName = "message";
  private readonly dataLines: string[] = [];
  private eventId: string | undefined;
  private retryMs: number | undefined;

  constructor(private readonly onEvent: (event: ServerSentEvent) => void | Promise<void>) {}

  async push(chunk: Uint8Array): Promise<void> {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    while (true) {
      const line = this.nextLine();
      if (line === undefined) return;
      await this.consumeLine(line);
    }
  }

  private nextLine(): string | undefined {
    for (let index = 0; index < this.buffer.length; index += 1) {
      const character = this.buffer[index];
      if (character !== "\n" && character !== "\r") continue;
      if (character === "\r" && index + 1 === this.buffer.length) return undefined;
      const line = this.buffer.slice(0, index);
      const nextOffset = character === "\r" && this.buffer[index + 1] === "\n" ? 2 : 1;
      this.buffer = this.buffer.slice(index + nextOffset);
      return line;
    }
    return undefined;
  }

  private async consumeLine(line: string): Promise<void> {
    if (line === "") {
      await this.dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") {
      this.eventName = value;
    } else if (field === "data") {
      this.dataLines.push(value);
    } else if (field === "id" && !value.includes("\0")) {
      this.eventId = value;
    } else if (field === "retry" && /^\d+$/u.test(value)) {
      this.retryMs = Number(value);
    }
  }

  private async dispatch(): Promise<void> {
    if (this.dataLines.length > 0) {
      await this.onEvent({
        event: this.eventName,
        data: this.dataLines.join("\n"),
        ...(this.eventId === undefined ? {} : { id: this.eventId }),
        ...(this.retryMs === undefined ? {} : { retryMs: this.retryMs }),
      });
    }
    this.eventName = "message";
    this.dataLines.length = 0;
    this.eventId = undefined;
  }
}
