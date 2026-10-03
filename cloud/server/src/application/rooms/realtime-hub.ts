import { randomUUID } from "node:crypto";
import type { RoomEventDto } from "@suduo/cloud-contracts";
import { REALTIME_BUFFER_MAX_BYTES, REALTIME_BUFFER_SIZE } from "./constants.js";
import type { RoomEventDraft } from "./events.js";

type RoomEventListener = (event: RoomEventDto) => void;

interface BufferedEvent {
  event: RoomEventDto;
  /** 序列化后的 UTF-8 字节数（SSE 帧 data 的大小）。 */
  bytes: number;
}

/**
 * 房间事件推送（模块「实时」，首期进程内内存实现）。
 * id 在进程内单调递增，重启后从 1 重来；`epoch` 每次启动随机，客户端发现它变了就按房间序号补拉。
 * 最近的事件留在环形缓冲里，供断线重连按 `Last-Event-ID` 补发：最多 2000 条且合计不超过 32MB，
 * 两个上限任一超出都从最旧的丢。房间对所有人可见，事件广播给所有连接。
 */
export class RealtimeHub {
  readonly epoch: string;
  private lastId = 0;
  private readonly buffer: BufferedEvent[] = [];
  private bufferedBytes = 0;
  private readonly listeners = new Set<RoomEventListener>();

  constructor(
    private readonly capacity: number = REALTIME_BUFFER_SIZE,
    epoch: string = randomUUID(),
    private readonly now: () => Date = () => new Date(),
    private readonly maxBytes: number = REALTIME_BUFFER_MAX_BYTES,
  ) {
    this.epoch = epoch;
  }

  publish(draft: RoomEventDraft): RoomEventDto {
    const event: RoomEventDto = { ...draft, id: ++this.lastId, occurredAt: this.now().toISOString() };
    this.remember(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        this.listeners.delete(listener);
      }
    }
    return event;
  }

  publishAll(drafts: readonly RoomEventDraft[]): void {
    for (const draft of drafts) this.publish(draft);
  }

  subscribe(listener: RoomEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 缓冲里 id 大于 lastEventId 的事件（按 id 升序）。超出窗口（条数或字节）被丢掉的部分补不回来：
   * 客户端看到首条 id 不是 lastEventId+1 时应按房间序号 `after` 补拉。
   */
  eventsAfter(lastEventId: number): RoomEventDto[] {
    return this.buffer.filter((entry) => entry.event.id > lastEventId).map((entry) => entry.event);
  }

  /** 放进缓冲，再按条数与字节两个上限从最旧的丢（单条就超过字节上限的也不留，只实时推送）。 */
  private remember(event: RoomEventDto): void {
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    this.buffer.push({ event, bytes });
    this.bufferedBytes += bytes;
    let drop = 0;
    while (
      drop < this.buffer.length &&
      (this.buffer.length - drop > this.capacity || this.bufferedBytes > this.maxBytes)
    ) {
      this.bufferedBytes -= this.buffer[drop]!.bytes;
      drop += 1;
    }
    if (drop > 0) this.buffer.splice(0, drop);
  }
}
