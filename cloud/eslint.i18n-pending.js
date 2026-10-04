// 中英双语迁移期的「待迁移文件」清单（技术设计 §三）：这些文件里还有写死的中文，暂时只查品牌写法。
// 一个文件迁完就从这里删掉，并把 I18N_PENDING_MAX 调成新的条数。清单只减不增：
// server/test/i18n-pending.test.ts 检查条数等于上限、每个文件都还有中文（迁完了却没删会报出来）。
export const I18N_PENDING_MAX = 7;

export const I18N_PENDING_FILES = [
  "contracts/src/status.ts",
  "server/src/application/publish-comment.ts",
  "server/src/application/rooms/constants.ts",
  "server/src/application/rooms/room-service.ts",
  "server/src/application/rooms/run-service.ts",
  "server/src/infrastructure/rooms/room-repository.ts",
  "server/src/infrastructure/rooms/sql.ts",
];
