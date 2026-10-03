import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 设置 › 关于 显示的版本号：与 client/package.json 保持一致。
const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __SUDUO_VERSION__: JSON.stringify(rootPackage.version ?? ""),
  },
  build: {
    // 服务端 CSP 为 default-src 'self'（未放行 data: 字体）：字体一律输出为同源文件，不内联。
    assetsInlineLimit: (filePath) => (/\.(woff2?|ttf|otf)$/i.test(filePath) ? false : undefined),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
