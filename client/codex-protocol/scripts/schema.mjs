import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "..");
const expectedVersion = readFileSync(resolve(packageRoot, "VERSION"), "utf8").trim();
const baselinePath = resolve(packageRoot, "baseline-manifest.json");
const mode = process.argv[2];

if (!["generate", "baseline", "diff"].includes(mode)) {
  throw new Error("usage: schema.mjs <generate|baseline|diff>");
}

const codexBin =
  process.env.CODEX_PROTOCOL_BIN ??
  resolve(
    workspaceRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "codex.cmd" : "codex",
  );

assertCodexVersion(codexBin, expectedVersion);

if (mode === "generate") {
  const output = resolve(packageRoot, "generated");
  const manifest = generateBundle(codexBin, output);
  writeFileSync(
    resolve(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        status: "generated",
        codexVersion: manifest.codexVersion,
        files: Object.keys(manifest.files).length,
        output,
      },
      null,
      2,
    ),
  );
} else {
  const temporary = resolve(
    tmpdir(),
    "suduo-codex-protocol-" + process.pid + "-" + Date.now(),
  );
  try {
    const manifest = generateBundle(codexBin, temporary);
    if (mode === "baseline") {
      writeFileSync(baselinePath, JSON.stringify(manifest, null, 2) + "\n");
      console.log(
        JSON.stringify(
          {
            status: "baseline-written",
            codexVersion: manifest.codexVersion,
            files: Object.keys(manifest.files).length,
            baselinePath,
          },
          null,
          2,
        ),
      );
    } else {
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
      const difference = compareManifests(baseline, manifest);
      if (
        difference.added.length > 0 ||
        difference.removed.length > 0 ||
        difference.changed.length > 0 ||
        baseline.codexVersion !== manifest.codexVersion
      ) {
        console.error(
          JSON.stringify(
            {
              status: "protocol-drift",
              expectedVersion: baseline.codexVersion,
              actualVersion: manifest.codexVersion,
              ...difference,
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
      } else {
        console.log(
          JSON.stringify(
            {
              status: "clean",
              codexVersion: manifest.codexVersion,
              files: Object.keys(manifest.files).length,
            },
            null,
            2,
          ),
        );
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function assertCodexVersion(binary, version) {
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error("failed to execute pinned codex: " + (result.stderr || result.stdout));
  }
  const actual = result.stdout.trim();
  if (actual !== "codex-cli " + version) {
    throw new Error(
      "Codex protocol binary version mismatch; expected " +
        version +
        ", received " +
        actual,
    );
  }
}

function generateBundle(binary, output) {
  rmSync(output, { recursive: true, force: true });
  const schemaDir = resolve(output, "schema");
  const typesDir = resolve(output, "types");
  mkdirSync(schemaDir, { recursive: true });
  mkdirSync(typesDir, { recursive: true });
  run(binary, [
    "app-server",
    "generate-json-schema",
    "--experimental",
    "--out",
    schemaDir,
  ]);
  run(binary, [
    "app-server",
    "generate-ts",
    "--experimental",
    "--out",
    typesDir,
  ]);
  return {
    schemaVersion: 1,
    codexVersion: expectedVersion,
    experimental: true,
    files: manifestFiles(output),
  };
}

function manifestFiles(root) {
  const files = {};
  for (const path of walk(root)) {
    const relativePath = relative(root, path).replaceAll("\\", "/");
    const content = readFileSync(path);
    const comparableContent = relativePath.endsWith(".json")
      ? Buffer.from(canonicalJson(JSON.parse(content.toString("utf8"))))
      : content;
    files[relativePath] = {
      sha256: createHash("sha256").update(comparableContent).digest("hex"),
      bytes: comparableContent.byteLength,
    };
  }
  return files;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
      .join(",") +
    "}"
  );
}

function walk(root) {
  const entries = [];
  for (const name of readdirSync(root).sort()) {
    const path = resolve(root, name);
    if (statSync(path).isDirectory()) {
      entries.push(...walk(path));
    } else if (name !== "manifest.json") {
      entries.push(path);
    }
  }
  return entries;
}

function compareManifests(expected, actual) {
  const expectedFiles = expected.files;
  const actualFiles = actual.files;
  const expectedNames = Object.keys(expectedFiles);
  const actualNames = Object.keys(actualFiles);
  return {
    added: actualNames.filter((name) => !(name in expectedFiles)).sort(),
    removed: expectedNames.filter((name) => !(name in actualFiles)).sort(),
    changed: expectedNames
      .filter(
        (name) =>
          name in actualFiles &&
          expectedFiles[name].sha256 !== actualFiles[name].sha256,
      )
      .sort(),
  };
}

function run(binary, args) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      binary +
        " " +
        args.join(" ") +
        " failed:\n" +
        result.stdout +
        "\n" +
        result.stderr,
    );
  }
}
