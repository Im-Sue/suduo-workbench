import { expect, it } from "vitest";
import {
  REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT,
} from "@suduo/cloud-contracts";
import { loadConfig } from "../src/config.js";

const REQUIRED_ENVIRONMENT: NodeJS.ProcessEnv = {
  REQUIREMENTS_DATABASE_URL: "postgresql://unused",
  REQUIREMENTS_AUTH_SECRET: "config-test-secret-at-least-thirty-two-characters",
  REQUIREMENTS_ATTACHMENT_ROOT: "/tmp/suduo-config-test",
};

it("默认活跃附件上限为契约规定的 100，并允许在上限内覆盖", () => {
  expect(loadConfig(REQUIRED_ENVIRONMENT).maxAttachmentsPerRequirement)
    .toBe(REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT);
  expect(loadConfig({
    ...REQUIRED_ENVIRONMENT,
    REQUIREMENTS_MAX_ATTACHMENTS_PER_REQUIREMENT: "87",
  }).maxAttachmentsPerRequirement).toBe(87);
});

it("房间文件根目录缺省为附件根目录同级的 -rooms，可覆盖；不能与附件根目录重叠", () => {
  const defaults = loadConfig(REQUIRED_ENVIRONMENT);
  expect(defaults.roomFileRoot).toBe("/tmp/suduo-config-test-rooms");
  expect(defaults.allowedRoomFileExtensions?.has(".mp4")).toBe(true);
  expect(defaults.allowedRoomFileExtensions?.has(".mov")).toBe(true);
  expect(defaults.allowedRoomFileExtensions?.has(".exe")).toBe(false);
  expect(loadConfig({
    ...REQUIRED_ENVIRONMENT,
    REQUIREMENTS_ROOM_FILE_ROOT: "/srv/suduo/room-files",
    REQUIREMENTS_ALLOWED_ROOM_FILE_EXTENSIONS: "png, .MP4",
  })).toMatchObject({
    roomFileRoot: "/srv/suduo/room-files",
    allowedRoomFileExtensions: new Set([".png", ".mp4"]),
  });
  expect(() => loadConfig({ ...REQUIRED_ENVIRONMENT, REQUIREMENTS_ROOM_FILE_ROOT: "relative/rooms" }))
    .toThrow("REQUIREMENTS_ROOM_FILE_ROOT must be an absolute path");
  expect(() => loadConfig({ ...REQUIRED_ENVIRONMENT, REQUIREMENTS_ROOM_FILE_ROOT: "/tmp/suduo-config-test/rooms" }))
    .toThrow("must not be the same directory or contain each other");
  expect(() => loadConfig({ ...REQUIRED_ENVIRONMENT, REQUIREMENTS_ROOM_FILE_ROOT: "/tmp" }))
    .toThrow("must not be the same directory or contain each other");
  expect(() => loadConfig({ ...REQUIRED_ENVIRONMENT, REQUIREMENTS_ALLOWED_ROOM_FILE_EXTENSIONS: "bad ext" }))
    .toThrow("REQUIREMENTS_ALLOWED_ROOM_FILE_EXTENSIONS contains an invalid extension");
});

it("附件缺省允许的类型与房间文件同一份清单：压缩包、视频、日志都能传，可执行文件仍不行", () => {
  const defaults = loadConfig(REQUIRED_ENVIRONMENT);
  expect([...defaults.allowedAttachmentExtensions].toSorted()).toEqual([...(defaults.allowedRoomFileExtensions ?? [])].toSorted());
  for (const extension of [".zip", ".rar", ".7z", ".tgz", ".mp4", ".mov", ".log", ".yaml", ".heic", ".pdf", ".png"]) {
    expect(defaults.allowedAttachmentExtensions.has(extension), extension).toBe(true);
  }
  expect(defaults.allowedAttachmentExtensions.has(".exe")).toBe(false);
  expect(loadConfig({ ...REQUIRED_ENVIRONMENT, REQUIREMENTS_ALLOWED_ATTACHMENT_EXTENSIONS: "pdf,.ZIP" }).allowedAttachmentExtensions)
    .toEqual(new Set([".pdf", ".zip"]));
});
