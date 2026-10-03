import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // 既有纯逻辑测试保持 Vitest 默认 node 环境；DOM 用例以文件级
    // `@vitest-environment jsdom` 指令选择 jsdom，避免全局环境漂移。
    testTimeout: 30_000,
    setupFiles: ["test/setup-dom.ts"],
  },
});
