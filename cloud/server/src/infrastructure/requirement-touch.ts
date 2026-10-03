import { notFound } from "../application/errors.js";
import type { QueryExecutor } from "./database.js";

/** 刷新需求的最近活动元数据，不改变正文版本。 */
export async function touchRequirement(
  executor: QueryExecutor,
  requirementId: string,
  actorId: string,
): Promise<number> {
  const result = await executor.query<{ version: number }>(
    `
      UPDATE requirements
      SET updated_by = $1,
          updated_at = now()
      WHERE id = $2
      RETURNING version
    `,
    [actorId, requirementId],
  );
  const version = result.rows[0]?.version;
  if (version === undefined) throw notFound("需求");
  return version;
}
