import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ATTRIBUTE = "data-testid";
const SCOPE = "web/src/**/*.tsx";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(scriptDirectory, "../../..");
const defaultBaselinePath = resolve(scriptDirectory, "data-testid-baseline.json");

export interface TestIdEntry {
  file: string;
  id: string;
}

export interface DynamicTestIdEntry {
  file: string;
  line: number;
}

export interface TestIdScan {
  staticEntries: TestIdEntry[];
  dynamicEntries: DynamicTestIdEntry[];
}

export interface TestIdBaseline {
  scope: string;
  attribute: string;
  total: number;
  files: Record<string, string[]>;
}

export interface TestIdComparison {
  missingFromSource: TestIdEntry[];
  missingFromBaseline: TestIdEntry[];
}

function entryKey(entry: TestIdEntry): string {
  return `${entry.file}\u0000${entry.id}`;
}

function compareEntries(left: TestIdEntry, right: TestIdEntry): number {
  return left.file.localeCompare(right.file) || left.id.localeCompare(right.id);
}

function uniqueEntries(entries: TestIdEntry[]): TestIdEntry[] {
  const byKey = new Map(entries.map((entry) => [entryKey(entry), entry]));
  return [...byKey.values()].sort(compareEntries);
}

function listTsxFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsxFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".tsx")) {
      files.push(path);
    }
  }
  return files.sort();
}

export function scanTestIdSource(file: string, text: string): TestIdScan {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const staticEntries: TestIdEntry[] = [];
  const dynamicEntries: DynamicTestIdEntry[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === ATTRIBUTE) {
      if (node.initializer !== undefined && ts.isStringLiteral(node.initializer)) {
        staticEntries.push({ file, id: node.initializer.text });
      } else {
        dynamicEntries.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return { staticEntries: uniqueEntries(staticEntries), dynamicEntries };
}

export function scanWorkspace(workspaceRoot = defaultWorkspaceRoot): TestIdScan {
  const sourceRoot = resolve(workspaceRoot, "web/src");
  const staticEntries: TestIdEntry[] = [];
  const dynamicEntries: DynamicTestIdEntry[] = [];

  for (const absoluteFile of listTsxFiles(sourceRoot)) {
    const file = relative(workspaceRoot, absoluteFile).split("\\").join("/");
    const scan = scanTestIdSource(file, readFileSync(absoluteFile, "utf8"));
    staticEntries.push(...scan.staticEntries);
    dynamicEntries.push(...scan.dynamicEntries);
  }

  return {
    staticEntries: uniqueEntries(staticEntries),
    dynamicEntries: dynamicEntries.sort(
      (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readBaseline(path = defaultBaselinePath): TestIdBaseline {
  if (!existsSync(path)) {
    throw new Error(`Baseline not found: ${path}`);
  }
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) {
    throw new Error(`Invalid baseline metadata in ${path}`);
  }
  const scope = value["scope"];
  const attribute = value["attribute"];
  const total = value["total"];
  const rawFiles = value["files"];
  if (scope !== SCOPE || attribute !== ATTRIBUTE) {
    throw new Error(`Invalid baseline metadata in ${path}`);
  }
  if (typeof total !== "number" || !Number.isInteger(total) || !isRecord(rawFiles)) {
    throw new Error(`Invalid baseline shape in ${path}`);
  }

  const files: Record<string, string[]> = {};
  for (const [file, ids] of Object.entries(rawFiles)) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw new Error(`Invalid testid list for ${file} in ${path}`);
    }
    files[file] = ids;
  }
  const entryCount = Object.values(files).reduce((total, ids) => total + ids.length, 0);
  if (entryCount !== total) {
    throw new Error(`Baseline total ${total} does not match ${entryCount} entries in ${path}`);
  }
  return { scope, attribute, total, files };
}

export function baselineEntries(baseline: TestIdBaseline): TestIdEntry[] {
  return uniqueEntries(
    Object.entries(baseline.files).flatMap(([file, ids]) => ids.map((id) => ({ file, id }))),
  );
}

export function createBaseline(entries: TestIdEntry[]): TestIdBaseline {
  const files: Record<string, string[]> = {};
  const staticEntries = uniqueEntries(entries);
  for (const entry of staticEntries) {
    (files[entry.file] ??= []).push(entry.id);
  }
  return { scope: SCOPE, attribute: ATTRIBUTE, total: staticEntries.length, files };
}

export function compareTestIdEntries(
  baseline: TestIdEntry[],
  source: TestIdEntry[],
): TestIdComparison {
  const baselineKeys = new Set(baseline.map(entryKey));
  const sourceKeys = new Set(source.map(entryKey));
  return {
    missingFromSource: baseline.filter((entry) => !sourceKeys.has(entryKey(entry))),
    missingFromBaseline: source.filter((entry) => !baselineKeys.has(entryKey(entry))),
  };
}

function formatEntries(entries: TestIdEntry[]): string {
  return entries.map((entry) => `  - ${entry.file}: ${entry.id}`).join("\n");
}

function usage(): string {
  return [
    "Usage:",
    "  pnpm testid:check      # verify static data-testid pairs without writing",
    "  pnpm testid:baseline   # regenerate the baseline after intentional testid changes",
    "",
    "The baseline is generated. When integrating branches, resolve its conflicts by rerunning",
    "pnpm testid:baseline instead of editing JSON by hand.",
  ].join("\n");
}

function parseMode(args: string[]): "check" | "write" {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const unsupported = args.filter((arg) => arg !== "--check" && arg !== "--write");
  const modes = new Set(args.filter((arg) => arg === "--check" || arg === "--write"));
  if (unsupported.length > 0 || modes.size !== 1) {
    throw new Error(`${usage()}\n\nPass exactly one of --check or --write.`);
  }
  return modes.has("--write") ? "write" : "check";
}

async function main(args: string[]): Promise<void> {
  const mode = parseMode(args);
  const scan = scanWorkspace();
  if (mode === "write") {
    const baseline = createBaseline(scan.staticEntries);
    writeFileSync(defaultBaselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(
      `WROTE testid baseline: ${baseline.total} static pairs; ${scan.dynamicEntries.length} dynamic attributes excluded.\n`,
    );
    return;
  }

  const comparison = compareTestIdEntries(baselineEntries(readBaseline()), scan.staticEntries);
  if (comparison.missingFromSource.length > 0 || comparison.missingFromBaseline.length > 0) {
    process.stderr.write("FAIL data-testid baseline drift detected.\n");
    if (comparison.missingFromSource.length > 0) {
      process.stderr.write("Baseline entries missing from source:\n");
      process.stderr.write(`${formatEntries(comparison.missingFromSource)}\n`);
    }
    if (comparison.missingFromBaseline.length > 0) {
      process.stderr.write("Source entries missing from baseline:\n");
      process.stderr.write(`${formatEntries(comparison.missingFromBaseline)}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `PASS testid baseline: ${scan.staticEntries.length} static pairs; ${scan.dynamicEntries.length} dynamic attributes excluded.\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
