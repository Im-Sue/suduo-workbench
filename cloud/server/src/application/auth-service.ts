import type { CurrentUserDto, LoginRequest, RegisterRequest } from "@suduo/cloud-contracts";
import type { UserRepository } from "../infrastructure/user-repository.js";
import { ApplicationError, notFound } from "./errors.js";
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from "./password-service.js";

interface DatabaseError extends Error {
  code?: string;
}

export class AuthService {
  constructor(private readonly users: UserRepository) {}

  async register(request: RegisterRequest): Promise<CurrentUserDto> {
    const loginName = normalizeLoginName(request.loginName);
    const displayName = nonBlank(request.displayName, "Display name");
    const passwordHash = await hashPassword(request.password);
    try {
      return await this.users.create({ loginName, displayName, passwordHash });
    } catch (error) {
      if (isDatabaseError(error) && error.code === "23505") {
        throw new ApplicationError(409, "LOGIN_NAME_TAKEN", "This username is already taken");
      }
      throw error;
    }
  }

  async login(request: LoginRequest): Promise<CurrentUserDto> {
    const loginName = normalizeLoginName(request.loginName);
    const record = await this.users.findForAuthentication(loginName);
    const passwordMatches = await verifyPassword(
      request.password,
      record?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (record === null || !passwordMatches) {
      throw new ApplicationError(401, "LOGIN_CREDENTIALS_INVALID", "Incorrect username or password");
    }
    return record.user;
  }

  async currentUser(userId: string): Promise<CurrentUserDto> {
    const user = await this.users.findById(userId);
    if (user === null) throw notFound("User");
    return user;
  }
}

function normalizeLoginName(value: string): string {
  return value.trim().toLowerCase();
}

function nonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ApplicationError(400, "VALIDATION_ERROR", `${label} must not be empty`);
  }
  return normalized;
}

function isDatabaseError(error: unknown): error is DatabaseError {
  return error instanceof Error && "code" in error;
}
