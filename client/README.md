# Running the SuDuo client

[中文](README.zh-CN.md) · [Back to the main README](../README.md)

The SuDuo client runs on each person's computer: a local service on `127.0.0.1` and the web interface it serves, plus the Codex CLI. There is no installer yet, so you run it from source. This guide covers setup, updating, where your data is kept, and troubleshooting.

Your team also needs a SuDuo server; see the [deployment guide](../cloud/DEPLOYMENT.md).

## Requirements

- **macOS 13.5 or later** (Apple silicon or Intel), or **Windows 10 / 11** (x64)
- **Node.js 24 LTS** (24.10 or later in the 24.x line): from <https://nodejs.org/>, or with a version manager such as mise, nvm or fnm. Newer major versions are not tested, and from Node 25 on `corepack` is no longer included
- **pnpm 10.25**: `corepack enable pnpm` (run it as administrator on Windows, or with `sudo` on macOS when Node is installed system-wide), or `npm install -g pnpm@10.25.0`
- **git**

## Install and start

macOS (Terminal) or Windows (PowerShell):

```bash
git clone https://github.com/Im-Sue/suduo-workbench.git
cd suduo-workbench
git checkout "$(git describe --tags --abbrev=0)"   # the latest release
cd client
pnpm install
pnpm start
```

Use the same release as your team's server. SuDuo shows a hint in **Settings → About (关于)** when the versions differ. The interface is in Chinese for now, so menu names below include the current Chinese label.

`pnpm start` checks your environment, builds SuDuo the first time (about 1–2 minutes), starts the local service on `http://127.0.0.1:8787` and opens your browser. If SuDuo is already running, it just opens the browser. Press `Ctrl+C` to stop it.

| Option | |
|---|---|
| `pnpm start --port 18787` | Use another port |
| `pnpm start --no-open` | Do not open the browser |
| `pnpm start --rebuild` | Rebuild before starting |

## Set up Codex

SuDuo runs the Codex CLI version pinned in `client/` with your own Codex configuration in `~/.codex`, the same directory your own Codex CLI uses. Either:

- sign in from the `client/` directory: `pnpm exec codex login`; or
- configure a model service in SuDuo under **Settings → Model service (模型服务)**: SuDuo passes the base URL and API key to Codex, which saves them in `~/.codex`. This changes the configuration your own Codex CLI uses too, and can replace an existing ChatGPT sign-in.

SuDuo itself does not keep a copy of your key, and sends nothing to SuDuo's authors.

## Connect to your team

1. **Settings → Requirements service (需求服务)**: enter your team's server address, then register or sign in.
2. For each project, choose the folder on your computer where its code lives.
3. Open a requirement and start a session.

## Updating

Stop SuDuo first (`Ctrl+C` in the window running `pnpm start`; on Windows `pnpm install` fails while SuDuo still has its files open), then in the `client/` directory:

```bash
git fetch --tags
git checkout v0.8.0     # the release your team uses
pnpm install
pnpm start              # rebuilds automatically
```

Your local data is migrated on start. Going back to an older version is not supported for the local database: back up the data directory first if you might need to.

## Where things are

| | macOS | Windows |
|---|---|---|
| Local data (sessions, settings) | `~/Library/Application Support/SuDuo` (before 0.7: `~/.local/share/suduo`) | `%LOCALAPPDATA%\SuDuo` |
| Logs | `<data directory>/logs/suduo.log` | `<data directory>\logs\suduo.log` |
| Codex configuration | `~/.codex` | `%USERPROFILE%\.codex` |

Set `SUDUO_DATA_DIR` to use another data directory, and `SUDUO_CODEX_HOME` (or `CODEX_HOME`) to use another Codex directory. [`server/.env.example`](server/.env.example) lists all settings.

## Troubleshooting

| Problem | What to do |
|---|---|
| Something is wrong and you don't know what | `pnpm run doctor` in `client/`, or **Settings → Diagnostics (诊断)**, or open `http://127.0.0.1:8787/doctor` |
| `pnpm install` fails on `better-sqlite3` | It downloads a prebuilt binary; behind a firewall it falls back to compiling. Install build tools: `xcode-select --install` on macOS, or Visual Studio Build Tools with "Desktop development with C++" on Windows. Then run `pnpm install` again |
| Downloads from npm are slow or fail (for example in mainland China) | `pnpm config set registry https://registry.npmmirror.com`, then `pnpm install` |
| You are behind a company proxy | Set `HTTPS_PROXY` for `pnpm install`. For Codex, set the proxy in **Settings → Network proxy (网络代理)** |
| Port 8787 is in use | `pnpm start --port 18787` |
| Codex keeps warning about `preferred_auth_method` | Delete that line from `~/.codex/config.toml`; current Codex versions do not use it |

## What is in this directory

```text
web/             the interface (React)
server/          the local service (Fastify + SQLite); runs Codex sessions
contracts/       types shared by web and server
codex-protocol/  the pinned Codex protocol schema and drift checks
scripts/         pnpm start, doctor and development scripts
```

Linux is not a supported client platform, but the client runs there for development and testing; see [CONTRIBUTING.md](../CONTRIBUTING.md).
