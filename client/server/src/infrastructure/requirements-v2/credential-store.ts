import { join } from "node:path";
import type { CurrentUserDto } from "@suduo/cloud-contracts";
import {
  readPrivateJson,
  removePrivateFile,
  writePrivateJson,
} from "./local-json-store.js";
import { normalizeRequirementsServiceUrl } from "./settings-store.js";

interface StoredAuthSession {
  schemaVersion: 1;
  baseUrl: string;
  accessToken: string;
  expiresAt: string;
  user: CurrentUserDto;
}

export interface RequirementsAuthSession {
  baseUrl: string;
  accessToken: string;
  expiresAt: string;
  user: CurrentUserDto;
}

export class RequirementsCredentialStore {
  private readonly filePath: string;

  constructor(dataDirectory: string) {
    this.filePath = join(dataDirectory, "auth-session.json");
  }

  getForBaseUrl(baseUrl: string, now = Date.now()): RequirementsAuthSession | null {
    const stored = readPrivateJson<StoredAuthSession>(this.filePath);
    if (!stored) {
      return null;
    }
    if (!isStoredSession(stored)) {
      this.clear();
      return null;
    }
    const normalizedBaseUrl = normalizeRequirementsServiceUrl(baseUrl);
    if (stored.baseUrl !== normalizedBaseUrl || Date.parse(stored.expiresAt) <= now) {
      this.clear();
      return null;
    }
    return {
      baseUrl: stored.baseUrl,
      accessToken: stored.accessToken,
      expiresAt: stored.expiresAt,
      user: stored.user,
    };
  }

  save(session: RequirementsAuthSession): void {
    const baseUrl = normalizeRequirementsServiceUrl(session.baseUrl);
    if (!session.accessToken.trim() || !Number.isFinite(Date.parse(session.expiresAt))) {
      throw new Error("Invalid requirements service sign-in session format");
    }
    writePrivateJson(this.filePath, {
      schemaVersion: 1,
      baseUrl,
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
      user: session.user,
    } satisfies StoredAuthSession);
  }

  clear(): void {
    removePrivateFile(this.filePath);
  }
}

function isStoredSession(value: StoredAuthSession): boolean {
  return (
    value.schemaVersion === 1 &&
    typeof value.baseUrl === "string" &&
    typeof value.accessToken === "string" &&
    value.accessToken.trim() !== "" &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    value.user !== null &&
    typeof value.user === "object" &&
    typeof value.user.id === "string" &&
    typeof value.user.loginName === "string" &&
    typeof value.user.displayName === "string" &&
    typeof value.user.createdAt === "string"
  );
}
