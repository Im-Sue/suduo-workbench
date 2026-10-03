import { randomUUID } from "node:crypto";
import type { CurrentUserDto } from "@suduo/cloud-contracts";
import type { Database, QueryExecutor } from "./database.js";

interface UserRow {
  id: string;
  login_name: string;
  display_name: string;
  password_hash: string;
  created_at: Date;
}

export interface AuthUserRecord {
  user: CurrentUserDto;
  passwordHash: string;
}

export class UserRepository {
  constructor(private readonly database: Database) {}

  async create(input: {
    loginName: string;
    displayName: string;
    passwordHash: string;
  }): Promise<CurrentUserDto> {
    const result = await this.database.query<UserRow>(
      `
        INSERT INTO users (id, login_name, display_name, password_hash)
        VALUES ($1, $2, $3, $4)
        RETURNING id, login_name, display_name, password_hash, created_at
      `,
      [randomUUID(), input.loginName, input.displayName, input.passwordHash],
    );
    return mapUser(requiredRow(result.rows[0]));
  }

  async findForAuthentication(loginName: string): Promise<AuthUserRecord | null> {
    const result = await this.database.query<UserRow>(
      `
        SELECT id, login_name, display_name, password_hash, created_at
        FROM users
        WHERE login_name = $1
      `,
      [loginName],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { user: mapUser(row), passwordHash: row.password_hash };
  }

  async findById(id: string, executor: QueryExecutor = this.database): Promise<CurrentUserDto | null> {
    const result = await executor.query<UserRow>(
      `
        SELECT id, login_name, display_name, password_hash, created_at
        FROM users
        WHERE id = $1
      `,
      [id],
    );
    return result.rows[0] === undefined ? null : mapUser(result.rows[0]);
  }
}

function mapUser(row: UserRow): CurrentUserDto {
  return {
    id: row.id,
    loginName: row.login_name,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
  };
}

function requiredRow<T>(row: T | undefined): T {
  if (row === undefined) throw new Error("数据库写入未返回记录");
  return row;
}
