import { cn } from "@/lib/utils";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";
import { RegionError } from "../feedback/components/index.js";
import { classifyFailure } from "../feedback/classify.js";
import type { FailureKind } from "../feedback/types.js";
import { parseCsv } from "../ui/csv.js";

const MAX_ROWS = 500;
const MAX_COLS = 60;

export function CsvPreview({ text }: { text: string }) {
  const result = useMemo(() => parseCsv(text, MAX_ROWS, MAX_COLS), [text]);
  return (
    <SheetTable
      rows={result.rows}
      truncated={result.truncatedRows || result.truncatedCols}
    />
  );
}

interface SheetData {
  name: string;
  rows: string[][];
  truncated: boolean;
}

/** xlsx 预览：SheetJS 动态导入（独立 chunk），raw 流取数，多 sheet 切换。 */
export function SheetPreview({
  projectId,
  path,
}: {
  projectId: string;
  path: string;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [active, setActive] = useState(0);
  const [errorKind, setErrorKind] = useState<FailureKind>("runtime_failed");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setSheets([]);
    setActive(0);
    setErrorKind("runtime_failed");
    void (async () => {
      try {
        const [xlsx, response] = await Promise.all([
          import("xlsx"),
          fetch(api.fileRawUrl(projectId, path)),
        ]);
        if (!response.ok) {
          throw new Error(`HTTP ${String(response.status)}`);
        }
        const buffer = await response.arrayBuffer();
        const workbook = xlsx.read(new Uint8Array(buffer), { type: "array" });
        const parsed: SheetData[] = workbook.SheetNames.map((name) => {
          const sheet = workbook.Sheets[name];
          if (!sheet) {
            return { name, rows: [], truncated: false };
          }
          const raw = xlsx.utils.sheet_to_json<(string | number | boolean | null)[]>(
            sheet,
            { header: 1, blankrows: false, defval: "" },
          );
          const truncated = raw.length > MAX_ROWS;
          const rows = raw
            .slice(0, MAX_ROWS)
            .map((row) =>
              row.slice(0, MAX_COLS).map((cell) => String(cell ?? "")),
            );
          return {
            name,
            rows,
            truncated: truncated || raw.some((row) => row.length > MAX_COLS),
          };
        });
        if (!cancelled) {
          setSheets(parsed);
          setStatus("ready");
        }
      } catch (cause) {
        if (!cancelled) {
          setErrorKind(classifyFailure(cause).kind);
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, path]);

  if (status === "loading") {
    return <p className="m-0 text-small text-subtle-foreground" role="status">正在解析表格…</p>;
  }
  if (status === "error" || sheets.length === 0) {
    return (
      <RegionError
        kind={errorKind}
        message="表格解析失败，请「用系统应用打开」查看完整内容。"
      />
    );
  }
  const current = sheets[Math.min(active, sheets.length - 1)] ?? sheets[0];
  if (!current) {
    return null;
  }
  return (
    <>
      {sheets.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1" role="tablist" aria-label="工作表">
          {sheets.map((sheet, index) => (
            <button
              key={sheet.name}
              type="button"
              role="tab"
              aria-selected={index === active}
              className={cn(
                "h-6 rounded-full border px-2.5 text-caption outline-none focus-visible:ring-2 focus-visible:ring-ring",
                index === active
                  ? "border-transparent bg-primary-soft font-medium text-primary-text"
                  : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
              )}
              onClick={() => setActive(index)}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      )}
      <SheetTable rows={current.rows} truncated={current.truncated} />
    </>
  );
}

function SheetTable({
  rows,
  truncated,
}: {
  rows: string[][];
  truncated: boolean;
}) {
  if (rows.length === 0) {
    return <p className="m-0 text-small text-subtle-foreground">表格为空。</p>;
  }
  const [head, ...body] = rows;
  return (
    <>
      <div className="max-h-[calc(100vh-220px)] overflow-auto rounded-md border border-border bg-card" data-testid="sheet-table">
        <table className="min-w-full border-separate border-spacing-0 text-small">
          <thead className="sticky top-0 bg-muted">
            <tr>
              {(head ?? []).map((cell, index) => (
                <th key={String(index)} className={TABLE_CELL + " font-medium text-foreground"}>{cell}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={String(rowIndex)} className="hover:[&>td]:bg-muted">
                {row.map((cell, cellIndex) => (
                  <td key={String(cellIndex)} title={cell} className={TABLE_CELL + " text-foreground"}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && (
        <p className="m-0 mt-2 text-caption text-subtle-foreground">
          仅显示前 {String(MAX_ROWS)} 行 / {String(MAX_COLS)} 列 ——
          完整内容请「用系统应用打开」。
        </p>
      )}
    </>
  );
}

const TABLE_CELL = "max-w-80 truncate border-r border-b border-border px-2 py-1.5 text-left whitespace-nowrap last:border-r-0";
