// monaco-editor 的 esm 细粒度模块（basic-languages 等）不带 .d.ts；
// 这些均为纯 side-effect import（注册 monarch 高亮），按通配声明放行。
declare module "monaco-editor/esm/vs/basic-languages/*";
