import { useEffect, useRef } from "react";
// 细粒度入口：编辑器全功能 + monarch 全语言高亮（均为小文件），
// 不走默认入口 editor.main —— 它会把 ts/css/html/json 四个语言智能
// worker（约 9MB）打进产物，只读预览用不到却会放大离线安装包。
import "monaco-editor/esm/vs/editor/editor.all.js";
import "./monaco-basic-languages.js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";

// 只装核心 editor worker：只读预览与 diff 用不到语言智能 worker，
// monarch 语法高亮不依赖 worker（最小 worker 控制体积，ADR-0002 第 9 条）。
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

let modelSeq = 0;
const DARK_THEME_NAME = "suduo-cockpit-dark";
const LIGHT_THEME_NAME = "suduo-cockpit-light";

/** 每次挂载生成唯一 URI：保留扩展名让 Monaco 自动推断语言，且避免同路径 model 冲突。 */
function nextModelUri(path: string): monaco.Uri {
  modelSeq += 1;
  return monaco.Uri.parse(
    `inmemory://suduo/${String(modelSeq)}/${encodeURI(path)}`,
  );
}

function darkThemeActive(): boolean {
  const forced = document.documentElement.dataset["theme"];
  return (
    forced === "dark" ||
    (forced !== "light" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
  );
}

function byteHex(value: number): string {
  return Math.round(Math.max(0, Math.min(255, value)))
    .toString(16)
    .padStart(2, "0");
}

/** Monaco theme 只稳定接受 hex；把浏览器解析后的 rgb/rgba 转成同值 hex。 */
function monacoColor(value: string): string {
  const match = value.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/,
  );
  if (!match) {
    return value;
  }
  const red = Number(match[1]);
  const green = Number(match[2]);
  const blue = Number(match[3]);
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  return `#${byteHex(red)}${byteHex(green)}${byteHex(blue)}${
    alpha < 1 ? byteHex(alpha * 255) : ""
  }`;
}

function cockpitThemeData(dark: boolean): monaco.editor.IStandaloneThemeData {
  const probe = document.createElement("span");
  probe.hidden = true;
  document.body.append(probe);
  const read = (name: string) => {
    probe.style.color = `var(${name})`;
    return monacoColor(getComputedStyle(probe).color);
  };
  const colors = {
    background: read("--workspace-surface"),
    foreground: read("--foreground"),
    muted: read("--foreground-muted"),
    faint: read("--foreground-faint"),
    panel: read("--panel"),
    border: read("--border-soft"),
    primary: read("--primary"),
    selection: read("--primary-subtle"),
    inserted: read("--ok-bg"),
    insertedGutter: read("--ok"),
    removed: read("--danger-bg"),
    removedGutter: read("--danger"),
    keyword: read("--code-kw"),
    string: read("--code-str"),
    number: read("--code-num"),
    fn: read("--code-fn"),
    comment: read("--code-cm"),
    attribute: read("--code-attr"),
  };
  probe.remove();
  const token = (color: string) => color.replace(/^#/, "");
  return {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: token(colors.comment) },
      { token: "keyword", foreground: token(colors.keyword) },
      { token: "string", foreground: token(colors.string) },
      { token: "number", foreground: token(colors.number) },
      { token: "type.identifier", foreground: token(colors.attribute) },
      { token: "attribute.name", foreground: token(colors.attribute) },
      { token: "function", foreground: token(colors.fn) },
    ],
    colors: {
      "editor.background": colors.background,
      "editor.foreground": colors.foreground,
      "editorLineNumber.foreground": colors.faint,
      "editorLineNumber.activeForeground": colors.muted,
      "editorCursor.foreground": colors.primary,
      "editor.selectionBackground": colors.selection,
      "editor.inactiveSelectionBackground": colors.panel,
      "editor.lineHighlightBackground": colors.panel,
      "editor.lineHighlightBorder": colors.border,
      "editorGutter.background": colors.background,
      "editorWidget.background": colors.panel,
      "editorWidget.border": colors.border,
      "editorHoverWidget.background": colors.panel,
      "editorHoverWidget.border": colors.border,
      "editorIndentGuide.background1": colors.border,
      "editorWhitespace.foreground": colors.border,
      "editorOverviewRuler.border": colors.border,
      "scrollbarSlider.background": colors.border,
      "scrollbarSlider.hoverBackground": colors.muted,
      "scrollbarSlider.activeBackground": colors.primary,
      "diffEditor.border": colors.border,
      "diffEditor.insertedTextBackground": colors.inserted,
      "diffEditor.removedTextBackground": colors.removed,
      "diffEditor.insertedLineBackground": colors.inserted,
      "diffEditor.removedLineBackground": colors.removed,
      "diffEditorGutter.insertedLineBackground": colors.insertedGutter,
      "diffEditorGutter.removedLineBackground": colors.removedGutter,
      "diffEditor.diagonalFill": colors.border,
    },
  };
}

function applyCockpitTheme(host: HTMLDivElement): string {
  const dark = darkThemeActive();
  const name = dark ? DARK_THEME_NAME : LIGHT_THEME_NAME;
  monaco.editor.defineTheme(name, cockpitThemeData(dark));
  monaco.editor.setTheme(name);
  host.dataset["monacoTheme"] = name;
  return name;
}

export type MonacoSurfaceProps =
  | { mode: "diff"; original: string; modified: string; path: string }
  /** revealLine：打开后滚到这一行（居中）并选中整行；从 1 开始，超出范围按首尾行算。 */
  | { mode: "read"; text: string; path: string; revealLine?: number | null };

/** 只读编辑器定位到某行：居中显示并选中整行。行号越界时夹到首尾行。 */
export function revealEditorLine(editor: monaco.editor.IStandaloneCodeEditor, line: number): void {
  const model = editor.getModel();
  if (model === null) return;
  const target = Math.min(Math.max(1, Math.trunc(line)), model.getLineCount());
  editor.revealLineInCenter(target);
  editor.setSelection(new monaco.Selection(target, 1, target, model.getLineMaxColumn(target)));
}

export default function MonacoSurface(props: MonacoSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const readEditorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const original = props.mode === "diff" ? props.original : null;
  const modified = props.mode === "diff" ? props.modified : null;
  const text = props.mode === "read" ? props.text : null;
  const revealLine = props.mode === "read" ? (props.revealLine ?? null) : null;
  const revealLineRef = useRef(revealLine);
  revealLineRef.current = revealLine;
  const path = props.path;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const apply = () => applyCockpitTheme(host);
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", apply);
    return () => {
      observer.disconnect();
      scheme.removeEventListener("change", apply);
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const theme = applyCockpitTheme(host);
    if (original !== null && modified !== null) {
      const originalModel = monaco.editor.createModel(
        original,
        undefined,
        nextModelUri(path),
      );
      const modifiedModel = monaco.editor.createModel(
        modified,
        undefined,
        nextModelUri(path),
      );
      const editor = monaco.editor.createDiffEditor(host, {
        readOnly: true,
        automaticLayout: true,
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: true,
        theme,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderOverviewRuler: false,
      });
      editor.setModel({ original: originalModel, modified: modifiedModel });
      return () => {
        // StrictMode 双执行下必须成对释放，否则 model 泄漏（consult 风险项）。
        editor.dispose();
        originalModel.dispose();
        modifiedModel.dispose();
      };
    }
    const model = monaco.editor.createModel(
      text ?? "",
      undefined,
      nextModelUri(path),
    );
    const editor = monaco.editor.create(host, {
      model,
      readOnly: true,
      automaticLayout: true,
      theme,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "on",
    });
    readEditorRef.current = editor;
    // 内容重建时按当前要定位的行再定位一次（行号变化由下面的 effect 处理）。
    if (revealLineRef.current !== null) revealEditorLine(editor, revealLineRef.current);
    return () => {
      readEditorRef.current = null;
      editor.dispose();
      model.dispose();
    };
  }, [original, modified, text, path]);

  // 同一份文件再次从链接打开、只是行号不同：不重建编辑器，直接跳过去。
  useEffect(() => {
    const editor = readEditorRef.current;
    if (editor !== null && revealLine !== null) revealEditorLine(editor, revealLine);
  }, [revealLine]);

  return <div ref={hostRef} className="h-full min-h-[320px] w-full flex-1 bg-card" data-testid="monaco-surface" />;
}
