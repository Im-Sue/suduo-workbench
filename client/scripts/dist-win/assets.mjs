export const WINDOWS_BUNDLE = {
  architecture: "x64",
  node: {
    version: "24.10.0",
    fileName: "node-v24.10.0-win-x64.zip",
    url: "https://nodejs.org/dist/v24.10.0/node-v24.10.0-win-x64.zip",
    sha256: "adc1a2d5ca79c92e94f3a58c3ec0efa76bdb488769ba4d4b50990e4c84896060",
  },
  codex: {
    version: "0.159.2",
    fileName: "codex-0.159.2-win32-x64.tgz",
    url: "https://registry.npmjs.org/@openai/codex/-/codex-0.159.2-win32-x64.tgz",
    sha256: "a71d5560d56189969350cf42c0121b57d69ae88405fcdab89fc3fa3d704f6bb6",
    executable:
      "vendor/x86_64-pc-windows-msvc/bin/codex.exe",
  },
  betterSqlite3: {
    version: "12.11.1",
    nodeAbi: "137",
    fileName:
      "better-sqlite3-v12.11.1-node-v137-win32-x64.tar.gz",
    url: "https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.1/better-sqlite3-v12.11.1-node-v137-win32-x64.tar.gz",
    sha256: "4ee5e653174d6ddd301605d351798cdae2613da06c4f37ecdce263021fcf1255",
    addonSha256:
      "e75b8c024a85179d8e0e51203a8b8867916e9a51327ce3953db5f8483cc9a91e",
  },
  nsis: {
    version: "3.09-4ubuntu1",
    packages: [
      {
        fileName: "nsis_3.09-4ubuntu1_amd64.deb",
        url: "https://archive.ubuntu.com/ubuntu/pool/universe/n/nsis/nsis_3.09-4ubuntu1_amd64.deb",
        sha256:
          "9e061bef1a8b611aeb2ea76d9a3bd7722b960ca1a9dff8e38d2ab51e5a8f5e5b",
      },
      {
        fileName: "nsis-common_3.09-4ubuntu1_all.deb",
        url: "https://archive.ubuntu.com/ubuntu/pool/universe/n/nsis/nsis-common_3.09-4ubuntu1_all.deb",
        sha256:
          "49471b9debdee4751ebb4caf6b705cc4c678eebfaecefbe56362258893f85859",
      },
    ],
  },
  unzip: {
    version: "6.0-28ubuntu4.1",
    fileName: "unzip_6.0-28ubuntu4.1_amd64.deb",
    url: "https://archive.ubuntu.com/ubuntu/pool/main/u/unzip/unzip_6.0-28ubuntu4.1_amd64.deb",
    sha256: "a505b9d491386167bd8e14e3383315a4a7d6539e4406745901ccf009a7988271",
  },
};

export function allAssets() {
  return [
    WINDOWS_BUNDLE.node,
    WINDOWS_BUNDLE.codex,
    WINDOWS_BUNDLE.betterSqlite3,
    ...WINDOWS_BUNDLE.nsis.packages,
    WINDOWS_BUNDLE.unzip,
  ];
}
