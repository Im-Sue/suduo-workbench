// 中英双语迁移期的「待迁移文件」清单（技术设计 §三）：这些文件里还有写死的中文，暂时只查品牌写法。
// 一个文件迁完就从这里删掉，并把 I18N_PENDING_MAX 调成新的条数。清单只减不增：
// server/test/i18n-pending.test.ts 检查条数等于上限、每个文件都还有中文（迁完了却没删会报出来）。
export const I18N_PENDING_MAX = 12;

export const I18N_PENDING_FILES = [
  "scripts/doctor.ts",
  "scripts/install.mjs",
  "scripts/start.mjs",
  "scripts/uninstall.mjs",
  "server/src/application/approval-mode-cap.ts",
  "server/src/infrastructure/db/better-sqlite3-database.ts",
  "server/src/infrastructure/db/migration-runner.ts",
  "server/src/infrastructure/platform/codex-bin.ts",
  "server/src/infrastructure/platform/runtime-config.ts",
  "server/src/infrastructure/requirements-v2/local-json-store.ts",
  "server/src/infrastructure/requirements-v2/settings-store.ts",
  "server/src/main.ts",
];
