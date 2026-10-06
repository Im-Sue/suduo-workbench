// What goes into each desktop package besides the shell itself, pinned by version and digest
// (technical design §3 decision 4). Digests come from the publishers: Node's SHASUMS256.txt, npm's `dist.integrity`
// for the Codex platform packages, and the GitHub release asset digests for better-sqlite3.
// Integrity strings use the Subresource Integrity format (`sha256-<base64>` / `sha512-<base64>`).

export const NODE_VERSION = "24.21.0";
/** Must match client/codex-protocol/VERSION (checked by test/assets.test.ts). */
export const CODEX_VERSION = "0.159.2";
export const BETTER_SQLITE3_VERSION = "12.11.1";
/** NODE_MODULE_VERSION of Node 24; the better-sqlite3 prebuild has to match the bundled Node, not Electron. */
export const NODE_ABI = "137";

const hexToSri = (algorithm, hex) => `${algorithm}-${Buffer.from(hex, "hex").toString("base64")}`;

/** Targets the desktop packages are built for (requirement R1). */
export const TARGETS = {
  "darwin-arm64": {
    platform: "darwin",
    arch: "arm64",
    codexTriple: "aarch64-apple-darwin",
    node: {
      fileName: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
      url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
      integrity: hexToSri("sha256", "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"),
    },
    codex: {
      fileName: `codex-${CODEX_VERSION}-darwin-arm64.tgz`,
      url: `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION}-darwin-arm64.tgz`,
      integrity: "sha512-7SPaPFU0tdqapQ5VEgrF+wb+p9dxfWfLMXMKZMRKoWPn/tLMajlMjYBBnu8o6VtaVH2DHQ6kpnp5TMkv5bqvrg==",
    },
    betterSqlite3: {
      fileName: `better-sqlite3-v${BETTER_SQLITE3_VERSION}-node-v${NODE_ABI}-darwin-arm64.tar.gz`,
      url: `https://github.com/WiseLibs/better-sqlite3/releases/download/v${BETTER_SQLITE3_VERSION}/better-sqlite3-v${BETTER_SQLITE3_VERSION}-node-v${NODE_ABI}-darwin-arm64.tar.gz`,
      integrity: hexToSri("sha256", "6eaefc8a9c088fea873365f7db2c0f89be6ea021ede62f6a71832f5130826a93"),
    },
  },
  "darwin-x64": {
    platform: "darwin",
    arch: "x64",
    codexTriple: "x86_64-apple-darwin",
    node: {
      fileName: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
      url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-x64.tar.gz`,
      integrity: hexToSri("sha256", "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097"),
    },
    codex: {
      fileName: `codex-${CODEX_VERSION}-darwin-x64.tgz`,
      url: `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION}-darwin-x64.tgz`,
      integrity: "sha512-VPZGYHH2yVn8S3IuxJk38vxhBADJZp68IBL8hr4quJ2R7jM16l43TLCwRemN+1J27V/cs771fbx63aGRf5F8JA==",
    },
    betterSqlite3: {
      fileName: `better-sqlite3-v${BETTER_SQLITE3_VERSION}-node-v${NODE_ABI}-darwin-x64.tar.gz`,
      url: `https://github.com/WiseLibs/better-sqlite3/releases/download/v${BETTER_SQLITE3_VERSION}/better-sqlite3-v${BETTER_SQLITE3_VERSION}-node-v${NODE_ABI}-darwin-x64.tar.gz`,
      integrity: hexToSri("sha256", "f9fe570a2ef7d6069196dd595f49bc8592574963dd1f249dcaa8878626773fc9"),
    },
  },
  "win32-x64": {
    platform: "win32",
    arch: "x64",
    codexTriple: "x86_64-pc-windows-msvc",
    node: {
      fileName: `node-v${NODE_VERSION}-win-x64.zip`,
      url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
      integrity: hexToSri("sha256", "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541"),
    },
    codex: {
      fileName: `codex-${CODEX_VERSION}-win32-x64.tgz`,
      url: `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION}-win32-x64.tgz`,
      integrity: "sha512-1ZJVTO40/ZaHPUUWc3uCX73jwzJRaDxAjRQEf37dC5Q3h1fp/Z7+1L8oX3bPlXgjhEY6kHW3rm0wz2sdQ5rxNw==",
    },
    betterSqlite3: {
      fileName: `better-sqlite3-v${BETTER_SQLITE3_VERSION}-node-v${NODE_ABI}-win32-x64.tar.gz`,
      url: `https://github.com/WiseLibs/better-sqlite3/releases/download/v${BETTER_SQLITE3_VERSION}/better-sqlite3-v${BETTER_SQLITE3_VERSION}-node-v${NODE_ABI}-win32-x64.tar.gz`,
      integrity: hexToSri("sha256", "4ee5e653174d6ddd301605d351798cdae2613da06c4f37ecdce263021fcf1255"),
    },
  },
};

export function targetFor(platform, arch) {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) throw new Error(`Unsupported desktop target: ${platform}-${arch} (supported: ${Object.keys(TARGETS).join(", ")})`);
  return target;
}
