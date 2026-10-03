import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type UploadCall = {
  file: File;
  key: string;
  signal: AbortSignal | undefined;
  resolve(): void;
  reject(error: unknown): void;
};

const calls: UploadCall[] = [];

vi.mock("../src/api/client.js", () => ({
  REQUIREMENT_ATTACHMENT_MAX_BYTES: 1_000,
  api: {
    uploadRequirementAttachment: (
      _requirementId: string,
      file: File,
      key: string,
      _onProgress: (percent: number) => void,
      signal?: AbortSignal,
    ) =>
      new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        calls.push({
          file,
          key,
          signal,
          resolve: () => resolve({ attachment: { id: `att-${file.name}` }, requirementVersion: 1 }),
          reject,
        });
      }),
  },
}));

const { cancelUpload, enqueueUploads, resetUploadQueues, retryUpload, uploadQueueSnapshot } = await import(
  "../src/features/requirements/upload-queue.js"
);

vi.stubGlobal("window", { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) });

const file = (name: string, size = 10) => new File([new Uint8Array(size)], name);
const queue = () => uploadQueueSnapshot("r1").map((item) => ({ name: item.file.name, state: item.state, error: item.error }));
const flush = async () => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
};

beforeEach(() => {
  calls.length = 0;
  resetUploadQueues();
});

afterEach(() => resetUploadQueues());

describe("材料上传队列（修复「一个文件失败整批卡住」）", () => {
  it("最多同时传 2 个；一个失败不阻塞后面的文件", async () => {
    enqueueUploads(new QueryClient(), "r1", [file("a"), file("b"), file("c")], 0);
    await flush();
    expect(calls.map((call) => call.file.name)).toEqual(["a", "b"]);

    calls[0]!.reject(new TypeError("Failed to fetch"));
    await flush();
    expect(calls.map((call) => call.file.name)).toEqual(["a", "b", "c"]);

    calls[1]!.resolve();
    calls[2]!.resolve();
    await flush();
    expect(queue()).toEqual([
      expect.objectContaining({ name: "a", state: "failed" }),
      expect.objectContaining({ name: "b", state: "done" }),
      expect.objectContaining({ name: "c", state: "done" }),
    ]);
  });

  it("重试沿用同一个幂等键：响应丢失后重传也不会多出一份", async () => {
    enqueueUploads(new QueryClient(), "r1", [file("a")], 0);
    await flush();
    const firstKey = calls[0]!.key;
    calls[0]!.reject(new TypeError("Failed to fetch"));
    await flush();
    retryUpload("r1", uploadQueueSnapshot("r1")[0]!.id);
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.key).toBe(firstKey);
  });

  it("超过大小上限的文件直接标为失败，不发请求", async () => {
    enqueueUploads(new QueryClient(), "r1", [file("big", 2_000)], 0);
    await flush();
    expect(calls).toHaveLength(0);
    expect(queue()[0]).toMatchObject({ name: "big", state: "failed", error: "超过 300 MB，无法上传" });
  });

  it("超出单需求材料数上限的部分标为失败，其余照常上传", async () => {
    enqueueUploads(new QueryClient(), "r1", [file("a"), file("b")], 99);
    await flush();
    expect(calls.map((call) => call.file.name)).toEqual(["a"]);
    expect(queue()[1]).toMatchObject({ name: "b", state: "failed" });
  });

  it("预检没通过的文件不能重试：点了也不会发请求", async () => {
    enqueueUploads(new QueryClient(), "r1", [file("big", 2_000)], 0);
    await flush();
    const [item] = uploadQueueSnapshot("r1");
    expect(item).toMatchObject({ state: "failed", retryable: false });
    retryUpload("r1", item!.id);
    await flush();
    expect(calls).toHaveLength(0);
    expect(queue()[0]).toMatchObject({ state: "failed" });
  });

  it("上传失败时回调 onFailed（新建对话框关掉后靠它提示）", async () => {
    const onFailed = vi.fn();
    enqueueUploads(new QueryClient(), "r1", [file("a"), file("b")], 0, { onFailed });
    await flush();
    calls[0]!.reject(new TypeError("Failed to fetch"));
    calls[1]!.resolve();
    await flush();
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0]![0]).toMatchObject({ state: "failed", retryable: true });
    expect(onFailed.mock.calls[0]![0].file.name).toBe("a");
  });

  it("换人登录时清空：中止进行中的上传，队列不留上一个人的文件", async () => {
    enqueueUploads(new QueryClient(), "r1", [file("a"), file("b"), file("c")], 0);
    await flush();
    resetUploadQueues();
    await flush();
    expect(calls.map((call) => call.signal?.aborted)).toEqual([true, true]);
    expect(uploadQueueSnapshot("r1")).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("取消正在上传的文件：中止请求并移出队列，下一个接着传", async () => {
    enqueueUploads(new QueryClient(), "r1", [file("a"), file("b"), file("c")], 0);
    await flush();
    cancelUpload("r1", uploadQueueSnapshot("r1")[0]!.id);
    await flush();
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(queue().map((item) => item.name)).toEqual(["b", "c"]);
    expect(calls.map((call) => call.file.name)).toEqual(["a", "b", "c"]);
  });
});
