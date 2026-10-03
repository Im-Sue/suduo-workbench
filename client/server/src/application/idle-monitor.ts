export interface IdleMonitorOptions {
  idleMs: number;
  onIdle(idleMs: number): void;
  now?(): number;
}

/**
 * 空闲监测：没有打开的事件流、且连续 idleMs 内没有任何 HTTP 请求或
 * runtime 事件时触发 onIdle。idleMs <= 0 表示禁用（长驻模式）。
 */
export class IdleMonitor {
  private readonly idleMs: number;
  private readonly onIdle: (idleMs: number) => void;
  private readonly now: () => number;
  private lastActivityAt: number;
  private activeStreams = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: IdleMonitorOptions) {
    this.idleMs = options.idleMs;
    this.onIdle = options.onIdle;
    this.now = options.now ?? Date.now;
    this.lastActivityAt = this.now();
  }

  get enabled(): boolean {
    return this.idleMs > 0;
  }

  touch(): void {
    this.lastActivityAt = this.now();
  }

  retainStream(): () => void {
    this.activeStreams += 1;
    this.touch();
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.activeStreams -= 1;
      this.touch();
    };
  }

  checkIdleNow(): boolean {
    return (
      this.enabled &&
      this.activeStreams === 0 &&
      this.now() - this.lastActivityAt >= this.idleMs
    );
  }

  start(): void {
    if (!this.enabled || this.timer !== null) {
      return;
    }
    const interval = Math.max(
      5_000,
      Math.min(60_000, Math.floor(this.idleMs / 4)),
    );
    this.timer = setInterval(() => {
      if (!this.checkIdleNow()) {
        return;
      }
      this.stop();
      this.onIdle(this.idleMs);
    }, interval);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
