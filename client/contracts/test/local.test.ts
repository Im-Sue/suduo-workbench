import { describe, expect, expectTypeOf, it } from "vitest";
import type { RequirementDetailDto, RequirementDto } from "@suduo/cloud-contracts";
import {
  ATTACHMENT_INLINE_PREVIEW_TYPES,
  LOCAL_PATH_ERROR_CODES,
  attachmentInlinePreviewType,
  attachmentInlinePreviewTypeForFileName,
  isAttachmentInlinePreviewType,
} from "../src/index.js";
import type {
  LocalDirectoryEntryDto,
  LocalDirectoryListQuery,
  RequirementDetailItemDto,
  RequirementListItemDto,
} from "../src/index.js";

describe("本机需求条目", () => {
  it("在远程需求 DTO 上只追加 localSessionCount", () => {
    expectTypeOf<RequirementListItemDto>().toEqualTypeOf<
      RequirementDto & { localSessionCount: number }
    >();
    expectTypeOf<RequirementDetailItemDto>().toEqualTypeOf<
      RequirementDetailDto & { localSessionCount: number }
    >();
  });
});

describe("本机目录浏览", () => {
  it("hidden 取值与路由一致；未探测的条目以 probed: false 标记", () => {
    expectTypeOf<LocalDirectoryListQuery["hidden"]>().toEqualTypeOf<"1" | "0" | undefined>();
    expectTypeOf<LocalDirectoryEntryDto["probed"]>().toEqualTypeOf<false | undefined>();
  });

  it("错误码固定为四个", () => {
    expect(LOCAL_PATH_ERROR_CODES).toEqual([
      "LOCAL_PATH_INVALID",
      "LOCAL_PATH_NOT_FOUND",
      "LOCAL_PATH_NOT_DIRECTORY",
      "LOCAL_PATH_PERMISSION_DENIED",
    ]);
  });
});

describe("附件在线预览白名单", () => {
  it("只含图片、PDF 与纯文本，不含可执行脚本的类型", () => {
    expect(ATTACHMENT_INLINE_PREVIEW_TYPES).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "application/pdf",
      "text/plain",
    ]);
  });

  it("按声明的 MIME 判断：去参数、不分大小写", () => {
    expect(attachmentInlinePreviewType("Text/Plain; charset=utf-8")).toBe("text/plain");
    expect(isAttachmentInlinePreviewType("IMAGE/PNG")).toBe(true);
    for (const contentType of [
      "image/svg+xml",
      "text/html",
      "application/xhtml+xml",
      "text/xml",
      "application/javascript",
      "text/markdown",
      "application/octet-stream",
      "",
      null,
      undefined,
    ]) {
      expect(isAttachmentInlinePreviewType(contentType), String(contentType)).toBe(false);
    }
  });

  it("按文件名扩展名推断", () => {
    expect(attachmentInlinePreviewTypeForFileName("截图.PNG")).toBe("image/png");
    expect(attachmentInlinePreviewTypeForFileName("photo.jpg")).toBe("image/jpeg");
    expect(attachmentInlinePreviewTypeForFileName("a.b.jpeg")).toBe("image/jpeg");
    expect(attachmentInlinePreviewTypeForFileName("说明.txt")).toBe("text/plain");
    expect(attachmentInlinePreviewTypeForFileName("需求.pdf")).toBe("application/pdf");
    for (const fileName of ["logo.svg", "page.html", "data.xml", "app.js", "README", ".png", "x."]) {
      expect(attachmentInlinePreviewTypeForFileName(fileName), fileName).toBeNull();
    }
  });
});
