import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
rmSync(resolve(root, ".build", "dist-win"), {
  recursive: true,
  force: true,
});
rmSync(resolve(root, "dist-installer"), {
  recursive: true,
  force: true,
});
process.stdout.write(
  "已清理构建目录；.cache/dist-win 离线缓存已保留。\n",
);
