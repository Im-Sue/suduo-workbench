import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // 每个测试文件收尾时强制删掉自己的临时库（DROP DATABASE 要等检查点）；文件并行多了会排队，10 秒的缺省不够。
    hookTimeout: 30_000,
  },
});
