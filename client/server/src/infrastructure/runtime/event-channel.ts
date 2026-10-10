/** 多个会话的事件汇成一条流（运行时的 subscribe）；没人订阅时先攒着，订阅结束不丢事件。 */
export class EventChannel<T> {
  private readonly buffer: T[] = [];
  private wake: (() => void) | null = null;

  push(value: T): void {
    this.buffer.push(value);
    this.wake?.();
  }

  async *iterate(signal: AbortSignal): AsyncIterable<T> {
    const onAbort = () => this.wake?.();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (!signal.aborted) {
        const next = this.buffer.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = null;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
