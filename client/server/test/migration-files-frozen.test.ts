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
  "001_m1_initial.sql": "4c4543dafb77077597c7586864cf8db15ca35d01f102b543a22db55778dbe1ae",
  "002_approval_modes.sql": "fed40717325420337bea3bc2c0788583d63ed796fd440ca72bdcea406b6438ae",
  "010_v2_clean_local_state.sql": "b38e346d502359c781997de02bd476188e54cb25828da762e7996cd58adca72e",
  "011_v2_session_observation_state.sql": "33ce18f8eb40ad456209c0514ce7f8f17f698e68422a481bff47bfdfced3299d",
  "012_v2_session_observation_health.sql": "37d31cb25d011a2f0075a08b6ffc8f9312f31fc34ca35a6bc5a3a0c159c7d768",
  "013_session_model_overrides.sql": "d6f558f88ba5d33a500477c81c34ea1b200ef62793371095f68f624cc4da5e53",
  "014_session_list_metadata.sql": "e26d7534c7f781e3d027fb5b79ccf116af0a45bfeae88066825d5798df247cd2",
  "015_session_context_tools.sql": "6dd4c55d38d648e9b1e59338b2589004d9af6b033f3295a52cf70a54e4e13d5f",
  "016_room_tasks.sql": "292e38686cb3d7754cb61cf2e7eab73b0924bf2016f94ae741553a40feadfe8b",
};

const MIGRATIONS = new URL("../src/infrastructure/db/migrations/", import.meta.url);

describe("已执行的迁移文件保持不变", () => {
  it.each(Object.entries(FROZEN))("%s", (file, sha256) => {
    const content = readFileSync(fileURLToPath(new URL(file, MIGRATIONS)));
    expect(createHash("sha256").update(content).digest("hex")).toBe(sha256);
  });
});
