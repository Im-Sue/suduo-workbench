import type { Readable } from "node:stream";

/**
 * 文件存储接口（需求「项目聊天房间与共享 Agent」4.10：存储可替换）。
 * 业务代码只认这个接口；首期是本机磁盘驱动，以后按配置换成 S3 / OSS / MinIO，
 * 房间、消息、媒体等模块不用改。
 *
 * 约定：存储只增不删（删除是 ADR-0004 的「不可逆字节损失」红线，本接口不提供）。
 */
export interface BlobStore {
  /** 启动时准备好存储（建目录、校验所有权、清理半截上传）。 */
  initialize(): Promise<void>;
  /** 流式写入，边写边算 sha256；超过 maxBytes 或与声明大小不符时丢弃并抛错。 */
  put(input: {
    stream: AsyncIterable<Uint8Array | string>;
    maxBytes: number;
    declaredSize?: number;
  }): Promise<StoredBlob>;
  /** 读取；给 range 时只读这一段（视频拖动进度用）。 */
  open(storageKey: string, range?: BlobRange): Promise<Readable>;
  /** 对象大小；不存在时抛错。 */
  size(storageKey: string): Promise<number>;
}

export interface StoredBlob {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
}

/** 闭区间 [start, end]，字节偏移。 */
export interface BlobRange {
  start: number;
  end: number;
}

/**
 * 解析 HTTP `Range: bytes=…` 头（只支持单段）。无法满足时返回 "unsatisfiable"，
 * 没带或格式不认识时返回 null（按整文件返回）。
 */
export function parseRangeHeader(header: string | undefined, size: number): BlobRange | null | "unsatisfiable" {
  if (header === undefined) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) {
    return null;
  }
  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") {
    return null;
  }
  if (size === 0) {
    return "unsatisfiable";
  }
  if (rawStart === "") {
    // bytes=-500：最后 500 字节。
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
    return "unsatisfiable";
  }
  return { start, end };
}
