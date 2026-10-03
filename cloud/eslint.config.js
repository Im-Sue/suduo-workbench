import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "pnpm-lock.yaml",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
        },
      ],
    },
  },
  {
    // 品牌写法（ADR-0010）：显示 / 帕斯卡 SuDuo，驼峰开头 suDuo，小写 suduo，全大写 SUDUO；旧品牌 ZJWork 已停用。
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Identifier[name=/Suduo|suduo[A-Z]/]",
          message: "品牌写法见 ADR-0010：帕斯卡写 SuDuo，驼峰开头写 suDuo。",
        },
        {
          selector: "Identifier[name=/[Zz][Jj][Ww][Oo][Rr][Kk]/]",
          message: "旧品牌已停用，统一写 SuDuo（ADR-0010）。",
        },
        {
          selector: "Literal[value=/[Zz][Jj][Ww][Oo][Rr][Kk]/]",
          message: "旧品牌已停用，统一写 SuDuo（ADR-0010）。",
        },
        {
          selector: "TemplateElement[value.raw=/[Zz][Jj][Ww][Oo][Rr][Kk]/]",
          message: "旧品牌已停用，统一写 SuDuo（ADR-0010）。",
        },
      ],
    },
  },
);
