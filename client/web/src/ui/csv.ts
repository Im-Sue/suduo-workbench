export interface CsvResult {
  rows: string[][];
  truncatedRows: boolean;
  truncatedCols: boolean;
}

/** RFC4180 子集解析：双引号转义、引号内换行/逗号；行列封顶保护渲染。 */
export function parseCsv(text: string, maxRows = 500, maxCols = 60): CsvResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let truncatedRows = false;
  let truncatedCols = false;

  const pushCell = () => {
    if (row.length < maxCols) {
      row.push(cell);
    } else {
      truncatedCols = true;
    }
    cell = "";
  };
  const pushRow = (): boolean => {
    pushCell();
    if (row.length > 0 && !(row.length === 1 && row[0] === "")) {
      if (rows.length >= maxRows) {
        truncatedRows = true;
        return false;
      }
      rows.push(row);
    }
    row = [];
    return true;
  };

  const source = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell === "") {
      quoted = true;
      continue;
    }
    if (char === ",") {
      pushCell();
      continue;
    }
    if (char === "\n") {
      if (!pushRow()) {
        return { rows, truncatedRows, truncatedCols };
      }
      continue;
    }
    cell += char;
  }
  pushRow();
  return { rows, truncatedRows, truncatedCols };
}
