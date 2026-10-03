import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { AttachmentDto } from "@suduo/client-contracts";
import { ApiError } from "../../application/api-error.js";
import { guardWritableDirectory } from "./path-guard.js";
import { ensureSuDuoDir } from "./suduo-dir.js";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export async function saveImageAttachment(input: {
  projectId: string;
  projectRoot: string;
  mediaType: string;
  dataBase64: string;
}): Promise<AttachmentDto> {
  const extension = EXTENSIONS[input.mediaType];
  if (!extension) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "附件仅支持 PNG/JPEG/GIF/WebP 图片",
    );
  }
  let bytes: Buffer;
  if (
    input.dataBase64.length === 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64)
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", "图片 base64 无效");
  }
  try {
    bytes = Buffer.from(input.dataBase64, "base64");
  } catch (error) {
    throw new ApiError(400, "VALIDATION_ERROR", "图片 base64 无效", undefined, {
      cause: error,
    });
  }
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "图片大小必须在 1 byte 到 10 MiB 之间",
    );
  }
  assertImageMagic(input.mediaType, bytes);
  // 先做越界校验（`.suduo` 若是指向项目外的符号链接会在这里被拒），再建目录。
  const directory = await guardWritableDirectory(
    input.projectRoot,
    ".suduo/attachments",
  );
  // 经 ensureSuDuoDir 建 `.suduo/`，保证它带忽略全部内容的 .gitignore。
  await ensureSuDuoDir(directory.root);
  await mkdir(directory.absolutePath, { recursive: true, mode: 0o700 });
  const id = randomUUID() + extension;
  await writeFile(directory.absolutePath + "/" + id, bytes, {
    flag: "wx",
    mode: 0o600,
  });
  return {
    id,
    projectId: input.projectId,
    relativePath: ".suduo/attachments/" + id,
    mediaType: input.mediaType,
    size: bytes.length,
  };
}

function assertImageMagic(mediaType: string, bytes: Buffer): void {
  const valid =
    (mediaType === "image/png" &&
      bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
    (mediaType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) ||
    (mediaType === "image/gif" &&
      ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) ||
    (mediaType === "image/webp" &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP");
  if (!valid) {
    throw new ApiError(400, "VALIDATION_ERROR", "图片内容与 mediaType 不匹配");
  }
}
