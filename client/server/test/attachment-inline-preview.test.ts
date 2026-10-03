import { buffer } from "node:stream/consumers";
import { ReadableStream } from "node:stream/web";
import { describe, expect, it } from "vitest";
import {
  INLINE_PREVIEW_SNIFF_BYTES,
  fileNameFromDisposition,
  prepareInlinePreview,
  sniffInlinePreviewType,
} from "../src/infrastructure/http/attachment-inline-preview.js";

describe("附件在线预览：文件头嗅探", () => {
  it("识别五种二进制签名", () => {
    const cases: Array<[number[] | string, string]> = [
      [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00], "image/png"],
      [[0xff, 0xd8, 0xff, 0xe0, 0x00], "image/jpeg"],
      ["GIF87a\u0001\u0000", "image/gif"],
      ["GIF89a\u0001\u0000", "image/gif"],
      ["RIFF$\u0000\u0000\u0000WEBPVP8 ", "image/webp"],
      ["%PDF-1.4\n", "application/pdf"],
    ];
    for (const [head, expected] of cases) {
      const bytes = typeof head === "string" ? Buffer.from(head, "latin1") : Buffer.from(head);
      expect(sniffInlinePreviewType(bytes, true), expected).toBe(expected);
    }
  });

  it("签名不完整或 RIFF 不是 WEBP 不算图片", () => {
    expect(sniffInlinePreviewType(Buffer.from([0x89, 0x50, 0x4e, 0x47]), true)).toBeNull();
    expect(sniffInlinePreviewType(Buffer.from("RIFF$\u0000\u0000\u0000WAVE", "latin1"), true))
      .toBeNull();
  });

  it("纯文本：合法 UTF-8 且无 NUL；样本截断处的半个字符只在未读完时放行", () => {
    expect(sniffInlinePreviewType(Buffer.from("说明\n"), true)).toBe("text/plain");
    expect(sniffInlinePreviewType(Buffer.alloc(0), true)).toBe("text/plain");
    expect(sniffInlinePreviewType(Buffer.from([0x68, 0x00, 0x69]), true)).toBeNull();
    expect(sniffInlinePreviewType(Buffer.from([0xc3, 0x28]), true)).toBeNull();
    const truncated = Buffer.from("说明").subarray(0, 4);
    expect(sniffInlinePreviewType(truncated, false)).toBe("text/plain");
    expect(sniffInlinePreviewType(truncated, true)).toBeNull();
  });
});

describe("附件在线预览：文件名", () => {
  it("优先 filename*，退回 filename，无效编码不报错", () => {
    expect(
      fileNameFromDisposition(
        `attachment; filename="__.png"; filename*=UTF-8''${encodeURIComponent("截图.png")}`,
      ),
    ).toBe("截图.png");
    expect(fileNameFromDisposition('attachment; filename="a \\"b\\".txt"')).toBe('a "b".txt');
    expect(fileNameFromDisposition("attachment; filename=plain.pdf")).toBe("plain.pdf");
    expect(fileNameFromDisposition("attachment; filename=\"x.png\"; filename*=UTF-8''%E0%A4%A"))
      .toBe("x.png");
    expect(fileNameFromDisposition("attachment")).toBeNull();
    expect(fileNameFromDisposition(null)).toBeNull();
  });
});

describe("附件在线预览：流式转发", () => {
  it("只预读文件头，回放后内容完整；扩展名不在白名单时不预读", async () => {
    const content = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200_000, 0x20)]);
    const source = chunkedSource(content, 1_000);
    const decision = await prepareInlinePreview(
      source.stream,
      "attachment; filename*=UTF-8''spec.pdf",
    );
    expect(decision.headers?.["Content-Type"]).toBe("application/pdf");
    expect(source.pulledBytes()).toBeLessThanOrEqual(INLINE_PREVIEW_SNIFF_BYTES + 2_000);
    expect((await buffer(decision.stream)).equals(content)).toBe(true);

    const skipped = chunkedSource(content, 1_000);
    const download = await prepareInlinePreview(
      skipped.stream,
      "attachment; filename*=UTF-8''page.html",
    );
    expect(download.headers).toBeNull();
    expect(skipped.pulledBytes()).toBeLessThanOrEqual(2_000);
    expect((await buffer(download.stream)).equals(content)).toBe(true);
  });

  it("下游提前关闭时取消远端流", async () => {
    const source = chunkedSource(Buffer.alloc(100_000, 0x61), 1_000);
    const decision = await prepareInlinePreview(
      source.stream,
      "attachment; filename*=UTF-8''long.txt",
    );
    expect(decision.headers?.["Content-Type"]).toBe("text/plain; charset=utf-8");
    for await (const chunk of decision.stream) {
      expect(chunk).toBeDefined();
      break;
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(source.cancelled()).toBe(true);
  });
});

function chunkedSource(content: Buffer, chunkSize: number) {
  let offset = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= content.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(content.subarray(offset, offset + chunkSize)));
      offset += chunkSize;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    pulledBytes: () => Math.min(offset, content.length),
    cancelled: () => cancelled,
  };
}
