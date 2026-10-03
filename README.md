# SuDuo

**Requirements with your team. Code on your machine.**

[中文](README.zh-CN.md) · Source-available · [Commercial use](COMMERCIAL.md) · [Contributing](CONTRIBUTING.md)

SuDuo (速舵) connects a team's shared requirements and discussions with the Codex CLI running on each developer's own computer. The team keeps requirements, attachments and discussion rooms on a server it hosts itself. Each person starts a local Codex session straight from a requirement, and their code, repositories and sessions never leave their computer.

## How it works

```text
 Team server (cloud/, self-hosted)            Each person's computer (client/)
┌──────────────────────────────────┐        ┌──────────────────────────────────────┐
│ Projects · requirements          │        │ SuDuo in the browser                  │
│ Comments · attachments · rooms   │ ◀────▶ │ Local service (127.0.0.1 only)        │
│ PostgreSQL + file volumes        │  HTTP  │ Your repositories · Codex sessions    │
└──────────────────────────────────┘        │ Codex CLI with your own model account │
                                            └──────────────────────────────────────┘
```

- **Shared requirements and discussion**: a requirements board, requirement details with comments and attachments, project and requirement rooms, and activity history.
- **Start work from a requirement**: open a local Codex session from a requirement, with tools that let Codex read the requirement and record conclusions.
- **Shared agents**: share your Codex in a room so teammates can ask it questions. It runs read-only on your machine and posts its answers in the room.
- **Self-hosted**: the server runs on your own infrastructure. SuDuo has no central service and never sees your code.

## Quick start

### 1. Deploy the cloud (once per team)

Follow the [deployment guide](cloud/DEPLOYMENT.md). On an Ubuntu server with Docker it is one command:

```bash
sudo ./scripts/suduo-cloud.sh install
```

### 2. Run the client (each person)

Requirements:

- **macOS 13.5 or later** (Apple silicon or Intel), or **Windows 10 / 11** (x64)
- **Node.js 24** (24.10 or later): from <https://nodejs.org/>, or with a version manager such as mise, nvm or fnm
- **pnpm 10.25**: `corepack enable pnpm` (run it as administrator on Windows, or with `sudo` on macOS when Node is installed system-wide), or `npm install -g pnpm@10.25.0`
- **git**

macOS (Terminal):

```bash
git clone https://github.com/Im-Sue/suduo-workbench.git
cd suduo-workbench
git checkout "$(git describe --tags --abbrev=0)"   # the latest release
cd client
pnpm install
pnpm start
```

Windows (PowerShell):

```powershell
git clone https://github.com/Im-Sue/suduo-workbench.git
cd suduo-workbench
git checkout (git describe --tags --abbrev=0)      # the latest release
cd client
pnpm install
pnpm start
```

`pnpm start` checks your environment, builds SuDuo the first time (about 1–2 minutes), starts the local service on `http://127.0.0.1:8787` and opens your browser. If SuDuo is already running, it just opens the browser. Press `Ctrl+C` to stop it. Options: `pnpm start --port 18787`, `--no-open`, `--rebuild`.

Use the same release as your team's cloud. SuDuo shows a hint in **Settings → About** when the versions differ.

### 3. Set up Codex

SuDuo runs the Codex CLI version pinned in `client/` with your own Codex configuration in `~/.codex`. SuDuo never reads or stores your keys. Either:

- configure a model service in SuDuo under **Settings → Model service**, or
- sign in from the `client/` directory: `pnpm exec codex login`

### 4. Connect and start

1. **Settings → Requirements service**: enter your team's cloud address, then register or sign in.
2. For each project, choose the folder on your computer where its code lives.
3. Open a requirement and start a session.

## Updating

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
| Local data (sessions, settings) | `~/Library/Application Support/SuDuo` | `%LOCALAPPDATA%\SuDuo\data` |
| Logs | `<data directory>/logs/suduo.log` | `<data directory>\logs\suduo.log` |
| Codex configuration | `~/.codex` | `%USERPROFILE%\.codex` |

Set `SUDUO_DATA_DIR` to use another data directory, and `SUDUO_CODEX_HOME` (or `CODEX_HOME`) to use another Codex directory. [`client/server/.env.example`](client/server/.env.example) lists all settings.

## Troubleshooting

| Problem | What to do |
|---|---|
| Something is wrong and you don't know what | `pnpm run doctor` in `client/`, or **Settings → Diagnostics**, or open `http://127.0.0.1:8787/doctor` |
| `pnpm install` fails on `better-sqlite3` | It downloads a prebuilt binary; behind a firewall it falls back to compiling. Install build tools: `xcode-select --install` on macOS, or Visual Studio Build Tools with "Desktop development with C++" on Windows. Then run `pnpm install` again |
| Downloads from npm are slow or fail (for example in mainland China) | `pnpm config set registry https://registry.npmmirror.com`, then `pnpm install` |
| You are behind a company proxy | Set `HTTPS_PROXY` for `pnpm install`. For Codex, set the proxy in **Settings → Network proxy** |
| Port 8787 is in use | `pnpm start --port 18787` |
| Codex keeps warning about `preferred_auth_method` | Delete that line from `~/.codex/config.toml`; current Codex versions do not use it |

## Repository

```text
client/   runs on each person's computer: web (frontend), server (local service), contracts, codex-protocol, scripts
cloud/    runs on the team's server: server (requirements service, Docker), contracts, scripts
docs/     requirements, architecture, technical designs and decisions (in Chinese)
```

Linux is not a supported client platform, but the client runs there for development and testing; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

SuDuo is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE), copyright sue.

- Noncommercial personal use (study, research, hobby projects with no anticipated commercial application) and use by educational, public research, charitable and government institutions is free, with no registration.
- Use by a company or other for-profit organization, including internal-only use, is generally commercial use: **start right away and register within 30 days of first use** by emailing im.suyejian@gmail.com. Registration is currently free. See [COMMERCIAL.md](COMMERCIAL.md).
- Contributions require agreeing to the [Contributor License Agreement](CLA.md).
- Third-party licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Codex and OpenAI are trademarks of OpenAI. SuDuo is not affiliated with OpenAI. See [TRADEMARKS.md](TRADEMARKS.md).
