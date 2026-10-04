import type { Readable } from "node:stream";
import { Busboy, type BusboyFileStream } from "@fastify/busboy";
import { ApplicationError } from "../application/errors.js";

/** multipart 里唯一的 `file` 字段：流式读取，completion 在整个请求体解析完时兑现。 */
export interface MultipartFile {
  stream: BusboyFileStream;
  filename: string;
  mimeType: string;
  completion: Promise<void>;
  cancel(): void;
}

/**
 * 解析只含一个名为 `file` 的文件字段的 multipart 请求体（需求附件与房间文件共用）。
 * 超过 maxBytes 时以 413 中断；额外字段 / 多个文件 / 没有文件为 400。
 */
export async function singleMultipartFile(
  body: Readable,
  contentType: string,
  maxBytes: number,
): Promise<MultipartFile> {
  let fileSeen = false;
  let resolveCompletion: () => void = () => undefined;
  let rejectCompletion: (error: unknown) => void = () => undefined;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => undefined);
  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: { "content-type": contentType },
      preservePath: false,
      limits: {
        files: 1,
        fields: 0,
        parts: 1,
        fileSize: maxBytes,
        headerPairs: 50,
        headerSize: 16_384,
      },
    });
  } catch (error) {
    body.resume();
    throw new ApplicationError(400, "ATTACHMENT_INVALID", "Invalid multipart attachment upload", undefined, {
      cause: error,
    });
  }
  let currentFile: BusboyFileStream | null = null;
  let parserFinished = false;
  let cancelUpload = () => {
    if (!body.destroyed) body.resume();
  };
  const file = new Promise<MultipartFile>((resolve, reject) => {
    const interrupted = () =>
      new ApplicationError(400, "ATTACHMENT_INVALID", "Attachment upload was interrupted");
    const terminate = (error: ApplicationError) => {
      if (parserFinished || parser.destroyed) return;
      body.unpipe(parser);
      currentFile?.destroy();
      parser.destroy(error);
      if (!body.destroyed) body.resume();
    };
    cancelUpload = () => terminate(interrupted());
    const onBodyError = () => terminate(interrupted());
    const onBodyAborted = () => terminate(interrupted());
    const onBodyClose = () => {
      if (!body.readableEnded) terminate(interrupted());
    };
    const removeBodyListeners = () => {
      body.off("error", onBodyError);
      body.off("aborted", onBodyAborted);
      body.off("close", onBodyClose);
    };
    body.once("error", onBodyError);
    body.once("aborted", onBodyAborted);
    body.once("close", onBodyClose);
    const invalid = (message: string) => {
      const error = new ApplicationError(400, "ATTACHMENT_INVALID", message);
      reject(error);
      rejectCompletion(error);
      terminate(error);
    };
    parser.on("file", (fieldName, stream, filename, _encoding, mimeType) => {
      if (fileSeen || fieldName !== "file") {
        stream.resume();
        invalid("multipart must contain exactly one attachment, in a field named file");
        return;
      }
      fileSeen = true;
      currentFile = stream;
      stream.once("limit", () => {
        const error = new ApplicationError(
          413,
          "ATTACHMENT_TOO_LARGE",
          "Attachment exceeds the 300 MiB limit",
        );
        rejectCompletion(error);
        terminate(error);
      });
      resolve({
        stream,
        filename,
        mimeType,
        completion,
        cancel: () => cancelUpload(),
      });
    });
    parser.on("field", () => invalid("multipart must not contain extra fields"));
    parser.on("filesLimit", () => invalid("multipart can contain only one attachment"));
    parser.on("fieldsLimit", () => invalid("multipart must not contain extra fields"));
    parser.on("partsLimit", () => invalid("multipart can contain only one attachment"));
    parser.on("error", (error) => {
      removeBodyListeners();
      reject(error);
      rejectCompletion(error);
    });
    parser.on("finish", () => {
      parserFinished = true;
      removeBodyListeners();
      if (!fileSeen) {
        invalid("An attachment file is required");
        return;
      }
      resolveCompletion();
    });
  });
  body.pipe(parser);
  return file;
}
