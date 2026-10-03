import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { I18N_PENDING_FILES } from "./eslint.i18n-pending.js";

// 品牌写法（ADR-0010）：显示 / 帕斯卡 SuDuo，驼峰开头 suDuo，小写 suduo，全大写 SUDUO；旧品牌 ZJWork 已停用。
const BRAND_RESTRICTIONS = [
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
];

// 中英双语（技术设计 §三）：代码里不写死中文，文字放进字典。CJK 文字与全角标点都算。
// 必须和品牌规则并进同一个数组：flat config 里同名规则后者整体覆盖前者，分开写会把品牌规则冲掉。
const CJK = "/[\\u3000-\\u303f\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]/";
const I18N_MESSAGE = "界面文字放进字典（中英双语技术设计 §4.2）；旧数据兼容常量用 eslint-disable 注明原因。";
const I18N_RESTRICTIONS = [
  { selector: `Literal[value=${CJK}]`, message: I18N_MESSAGE },
  { selector: `TemplateElement[value.raw=${CJK}]`, message: I18N_MESSAGE },
  { selector: `JSXText[value=${CJK}]`, message: I18N_MESSAGE },
];
const I18N_SCOPE = [
  "web/src/**/*.{ts,tsx}",
  "server/src/**/*.ts",
  "contracts/src/**/*.ts",
  "scripts/**/*.{ts,mjs}",
];
// 字典本身、开发用的设计系统页不受约束；Windows 安装器与启动器暂缓，不在双语范围内（技术设计 §一「不覆盖」）。
const I18N_EXEMPT = [
  "web/src/i18n/messages/**",
  "server/src/i18n/messages/**",
  "web/src/dev/**",
  "scripts/dist-win/**",
];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "pnpm-lock.yaml",
      // 与 .gitignore 对齐：构建缓存、Windows 安装包产物、协议生成物不是项目源码。
      ".cache/**",
      ".build/**",
      "dist-installer/**",
      "codex-protocol/generated/**",
      // 把 client/ 当代码目录跑会话时产生的本机运行时目录。
      ".suduo/**",
      // 各片本机留存的验收证据（日志、探针脚本），同样在 .gitignore 里。
      "artifacts/**",
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
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    rules: {
      "no-restricted-syntax": ["error", ...BRAND_RESTRICTIONS],
    },
  },
  {
    files: I18N_SCOPE,
    ...(I18N_EXEMPT.length === 0 ? {} : { ignores: I18N_EXEMPT }),
    rules: {
      "no-restricted-syntax": ["error", ...BRAND_RESTRICTIONS, ...I18N_RESTRICTIONS],
    },
  },
  // 迁移期：还没迁到字典的文件只查品牌写法。清单只减不增，由 server/test/i18n-pending.test.ts 守着；清空后整块消失。
  ...(I18N_PENDING_FILES.length === 0
    ? []
    : [
        {
          files: I18N_PENDING_FILES,
          rules: {
            "no-restricted-syntax": ["error", ...BRAND_RESTRICTIONS],
          },
        },
      ]),
);
