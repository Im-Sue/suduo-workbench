import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 已执行过的迁移文件一个字节都不能改（ADR-0001）：已部署 / 本机的库按版本记了执行记录，
 * 改了内容不会重跑，云端还会因校验和漂移拒绝启动。品牌更名（ADR-0010）时就险些误改注释。
 * 新增迁移不受影响；确有必要改动已有迁移时，要先想清楚已执行的库怎么办，再更新这里的哈希。
 */
const FROZEN: Record<string, string> = {
  "001_initial.sql": "0655c8a14f8065a53e9560b37aff46231de5869ac5c808d683de3979dc8a45f5",
  "002_attachments.sql": "a3b0a57393bb6bfdcbd50ba1228eed1c33984e2a0ccb6b069fd39389bf52596c",
  "003_requirement_status_in_refinement.sql": "7447e0dfbfdfb1122aa3a26ab9aa62ee31109d42d2f2ac0f151e40f2b9529ed3",
  "004_requirement_artifact_versions.sql": "7a8a2fae7d968d8ea57926db60773a8374d17d0e15fcac1822350e2e7ac76019",
  "005_audit_project_id.sql": "3ce3b06556cd083c93156fd064673821fc95f16dbb6f822e4e276fc2130e94dd",
  "006_requirement_number_assignee.sql": "9c0571f1cbe5149264a564b6a67f78a359016ce0bb726d657eb1a97874cc75b3",
  "007_audit_requirement_id.sql": "56a2e5e23f58a49ad77aeecf9c8bbca0e61e0eb4bf2866165463ba8bb4eb9daf",
  "008_audit_created_at_clock_timestamp.sql": "94e53728c07152370e030480d42db93ea2414c7cc5a48f77be9f8083653a50b5",
  "009_requirement_reads.sql": "464a67b582e015f4d8e54b46b8eb0f54b8ad18477a118732444a218f8eaf4ea9",
  "010_comment_created_at_clock_timestamp.sql": "d6473d74cfd94176268ec015d0c66aeed3c2c69528ed16904214bd151603c60f",
  "011_rooms_and_shared_agents.sql": "d872268eb9059f79f3fe429a711fcb22fcb989d89a0d5214145fd527b85698e4",
};

const MIGRATIONS = new URL("../migrations/", import.meta.url);

describe("已执行的迁移文件保持不变", () => {
  it.each(Object.entries(FROZEN))("%s", (file, sha256) => {
    const content = readFileSync(fileURLToPath(new URL(file, MIGRATIONS)));
    expect(createHash("sha256").update(content).digest("hex")).toBe(sha256);
  });
});
