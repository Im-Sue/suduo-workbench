import { AuthService } from "./application/auth-service.js";
import { AttachmentService } from "./application/attachment-service.js";
import { ArtifactVersionService } from "./application/artifact-version-service.js";
import { CollaborationService } from "./application/collaboration-service.js";
import { RequirementsEventHub } from "./application/event-hub.js";
import { ROOM_FILE_ROOT_MARKER } from "./application/rooms/constants.js";
import { createRoomsModule } from "./application/rooms/module.js";
import { defaultRoomFileRoot, type RequirementsServiceConfig } from "./config.js";
import { buildHttpServer } from "./http/server.js";
import { CollaborationRepository } from "./infrastructure/collaboration-repository.js";
import { AttachmentRepository } from "./infrastructure/attachment-repository.js";
import { AttachmentStorage } from "./infrastructure/attachment-storage.js";
import { ArtifactVersionRepository } from "./infrastructure/artifact-version-repository.js";
import type { Database } from "./infrastructure/database.js";
import { LocalDiskBlobStore } from "./infrastructure/storage/local-disk-blob-store.js";
import { UserRepository } from "./infrastructure/user-repository.js";

export async function createApplication(
  config: RequirementsServiceConfig,
  database: Database,
) {
  const users = new UserRepository(database);
  const auth = new AuthService(users);
  const collaboration = new CollaborationService(
    new CollaborationRepository(database),
  );
  const attachmentStorage = new AttachmentStorage(
    config.attachmentRoot,
    config.maxAttachmentBytes,
    config.allowedAttachmentExtensions,
  );
  const artifactVersionRepository = new ArtifactVersionRepository(database);
  const attachments = new AttachmentService(
    new AttachmentRepository(database, config.maxAttachmentsPerRequirement),
    attachmentStorage,
    artifactVersionRepository,
  );
  const artifactVersions = new ArtifactVersionService(
    artifactVersionRepository,
  );
  // 房间文件：独立根目录，启动时只清半截上传，不删任何对象（存储只增不删）。
  const roomBlobStore = new LocalDiskBlobStore(
    config.roomFileRoot ?? defaultRoomFileRoot(config.attachmentRoot),
    ROOM_FILE_ROOT_MARKER,
  );
  await roomBlobStore.initialize();
  await attachments.initialize();
  try {
    let server: Awaited<ReturnType<typeof buildHttpServer>> | null = null;
    const rooms = createRoomsModule({
      database,
      blobStore: roomBlobStore,
      // 服务器建好后才有日志器；扫描最早 30 秒后才跑。
      logger: {
        info: (object, message) => server?.log.info(object, message),
        warn: (object, message) => server?.log.warn(object, message),
      },
      ...(config.allowedRoomFileExtensions === undefined
        ? {}
        : { allowedFileExtensions: config.allowedRoomFileExtensions }),
    });
    server = await buildHttpServer({
      config,
      database,
      auth,
      collaboration,
      attachments,
      artifactVersions,
      attachmentStorage,
      events: new RequirementsEventHub(),
      rooms,
    });
    // 到期共享、掉线 Agent 的扫描：进程内定时，服务关闭时（onClose）停止。
    rooms.sweeper.start();
    return server;
  } catch (error) {
    try {
      await attachments.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "requirements-service HTTP 初始化和附件所有权释放均失败",
        { cause: closeError },
      );
    }
    throw error;
  }
}
