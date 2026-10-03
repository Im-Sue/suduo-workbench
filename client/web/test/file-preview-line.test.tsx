// @vitest-environment jsdom

import type { FileContentDto } from "@suduo/client-contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Monaco 在 jsdom 里起不来：换成假的编辑器 API，只记录定位行为。 */
const monacoMocks = vi.hoisted(() => {
  const editors: Array<{ revealLineInCenter: ReturnType<typeof vi.fn>; setSelection: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = [];
  class Selection {
    constructor(
      readonly startLineNumber: number,
      readonly startColumn: number,
      readonly endLineNumber: number,
      readonly endColumn: number,
    ) {}
  }
  const createModel = vi.fn((text: string) => {
    const lines = text.split("\n");
    return {
      getLineCount: () => lines.length,
      getLineMaxColumn: (line: number) => (lines[line - 1]?.length ?? 0) + 1,
      dispose: vi.fn(),
    };
  });
  const create = vi.fn((_host: unknown, options: { model: ReturnType<typeof createModel> }) => {
    const editor = { revealLineInCenter: vi.fn(), setSelection: vi.fn(), dispose: vi.fn(), getModel: () => options.model };
    editors.push(editor);
    return editor;
  });
  return {
    editors,
    api: {
      Selection,
      Uri: { parse: (value: string) => value },
      editor: { create, createModel, createDiffEditor: vi.fn(), defineTheme: vi.fn(), setTheme: vi.fn() },
    },
  };
});

vi.mock("monaco-editor/esm/vs/editor/editor.all.js", () => ({}));
vi.mock("monaco-editor/esm/vs/editor/editor.worker.js?worker", () => ({ default: class {} }));
vi.mock("monaco-editor/esm/vs/editor/editor.api.js", () => monacoMocks.api);
vi.mock("../src/components/monaco-basic-languages.js", () => ({}));

import MonacoSurface from "../src/components/MonacoImpl.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

beforeEach(() => {
  monacoMocks.editors.length = 0;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const TEXT = "line 1\nline 2\nline three\nline 4";

describe("只读编辑器定位到行", () => {
  it("打开时滚到这一行居中并选中整行；只改行号时不重建编辑器", async () => {
    await render(<MonacoSurface mode="read" text={TEXT} path="src/a.ts" revealLine={3} />);
    expect(monacoMocks.api.editor.create).toHaveBeenCalledTimes(1);
    const editor = monacoMocks.editors[0];
    expect(editor?.revealLineInCenter).toHaveBeenLastCalledWith(3);
    expect(editor?.setSelection).toHaveBeenLastCalledWith(expect.objectContaining({ startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 11 }));

    await act(async () => root?.render(<MonacoSurface mode="read" text={TEXT} path="src/a.ts" revealLine={1} />));
    expect(monacoMocks.api.editor.create).toHaveBeenCalledTimes(1);
    expect(editor?.revealLineInCenter).toHaveBeenLastCalledWith(1);
  });

  it("行号超出文件时夹到最后一行；没有行号不定位", async () => {
    await render(<MonacoSurface mode="read" text={TEXT} path="src/a.ts" revealLine={99} />);
    expect(monacoMocks.editors[0]?.revealLineInCenter).toHaveBeenLastCalledWith(4);
    await act(async () => root?.unmount());
    root = null;
    monacoMocks.editors.length = 0;
    await render(<MonacoSurface mode="read" text={TEXT} path="src/b.ts" />);
    expect(monacoMocks.editors[0]?.revealLineInCenter).not.toHaveBeenCalled();
  });
});

describe("文件预览把行号交给编辑器", () => {
  it("代码文件带行号；Markdown 文件按渲染预览显示，忽略行号", async () => {
    const { Drawer } = await import("../src/components/Drawer.js");
    const code: FileContentDto = { path: "src/a.ts", type: "text", text: TEXT, mediaType: "text/plain", size: TEXT.length, truncated: false } as FileContentDto;
    const node = await render(
      <Drawer state={{ mode: "preview", content: code, line: 2 }} projectId="p1" targets={[]} onClose={vi.fn()} onSystemOpen={vi.fn()} />,
    );
    // MonacoView 是懒加载：等它装上。
    await vi.waitFor(() => expect(monacoMocks.api.editor.create).toHaveBeenCalled());
    expect(monacoMocks.editors[0]?.revealLineInCenter).toHaveBeenLastCalledWith(2);

    const markdown: FileContentDto = { path: "docs/a.md", type: "text", text: "# 标题\n\n正文", mediaType: "text/markdown", size: 12, truncated: false } as FileContentDto;
    monacoMocks.api.editor.create.mockClear();
    await act(async () =>
      root?.render(<Drawer state={{ mode: "preview", content: markdown, line: 2 }} projectId="p1" targets={[]} onClose={vi.fn()} onSystemOpen={vi.fn()} />),
    );
    expect(node.querySelector(".md h1")?.textContent).toBe("标题");
    expect(monacoMocks.api.editor.create).not.toHaveBeenCalled();
  });
});
