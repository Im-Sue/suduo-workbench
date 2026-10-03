import { ROOM_FILE_MAX_BYTES } from "@suduo/cloud-contracts";
import type { Database } from "../../infrastructure/database.js";
import { AgentRepository } from "../../infrastructure/rooms/agent-repository.js";
import { RoomFileRepository } from "../../infrastructure/rooms/file-repository.js";
import { MessageRepository } from "../../infrastructure/rooms/message-repository.js";
import { RoomRepository } from "../../infrastructure/rooms/room-repository.js";
import { AgentRunRepository } from "../../infrastructure/rooms/run-repository.js";
import { AgentShareRepository } from "../../infrastructure/rooms/share-repository.js";
import type { BlobStore } from "../../infrastructure/storage/blob-store.js";
import { AgentService } from "./agent-service.js";
import { DEFAULT_ROOM_FILE_EXTENSIONS } from "./file-types.js";
import { RoomFileService } from "./file-service.js";
import { RoomMessageService } from "./message-service.js";
import { PresenceTracker } from "./presence-tracker.js";
import { RealtimeHub } from "./realtime-hub.js";
import { RoomService } from "./room-service.js";
import { RoomSweeper } from "./room-sweeper.js";
import { AgentRunService } from "./run-service.js";
import { AgentShareService } from "./share-service.js";

/** 房间与共享 Agent 的全部服务（HTTP 层只依赖这里）。 */
export interface RoomsModule {
  rooms: RoomService;
  messages: RoomMessageService;
  files: RoomFileService;
  agents: AgentService;
  shares: AgentShareService;
  runs: AgentRunService;
  realtime: RealtimeHub;
  sweeper: RoomSweeper;
}

export interface CreateRoomsModuleOptions {
  database: Database;
  blobStore: BlobStore;
  allowedFileExtensions?: ReadonlySet<string>;
  maxFileBytes?: number;
  realtime?: RealtimeHub;
  now?: () => Date;
  logger?: ConstructorParameters<typeof RoomSweeper>[5];
}

export function createRoomsModule(options: CreateRoomsModuleOptions): RoomsModule {
  const { database } = options;
  const roomRepository = new RoomRepository(database);
  const messageRepository = new MessageRepository(database);
  const fileRepository = new RoomFileRepository(database);
  const agentRepository = new AgentRepository(database);
  const shareRepository = new AgentShareRepository(database);
  const runRepository = new AgentRunRepository(database);
  const realtime = options.realtime ?? new RealtimeHub();
  const presence = new PresenceTracker();
  const shares = new AgentShareService(
    database,
    roomRepository,
    agentRepository,
    shareRepository,
    runRepository,
    options.now,
  );
  const runs = new AgentRunService(database, roomRepository, messageRepository, agentRepository, runRepository);
  return {
    rooms: new RoomService(database, roomRepository),
    messages: new RoomMessageService(
      database,
      roomRepository,
      messageRepository,
      fileRepository,
      agentRepository,
      runRepository,
    ),
    files: new RoomFileService(
      roomRepository,
      fileRepository,
      options.blobStore,
      options.allowedFileExtensions ?? new Set(DEFAULT_ROOM_FILE_EXTENSIONS),
      options.maxFileBytes ?? ROOM_FILE_MAX_BYTES,
    ),
    agents: new AgentService(agentRepository, presence),
    shares,
    runs,
    realtime,
    sweeper: new RoomSweeper(shares, runs, agentRepository, presence, realtime, options.logger ?? null),
  };
}
