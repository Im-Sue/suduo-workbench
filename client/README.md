# Running the SuDuo client

[中文](README.zh-CN.md) · [Back to the main README](../README.md)

The SuDuo client runs on each person's computer: a local service on `127.0.0.1` and the web interface it serves, plus the Codex CLI. You can install the [desktop app](#desktop-app-trial) (a trial, from 0.9.0) or [run it from source](#requirements). This guide covers both, plus updating, where your data is kept, and troubleshooting.

Your team also needs a SuDuo server; see the [deployment guide](../cloud/DEPLOYMENT.md).

## Desktop app (trial)

The desktop app includes everything the client needs, so you don't need Node.js or pnpm (git is only used for checkpoints and branch status). It's a trial: it isn't signed yet.

1. Download the installer for your computer from the [latest release](https://github.com/Im-Sue/suduo-workbench/releases/latest). `SHA256SUMS.txt` in the same release lists the checksums.

   | Computer | File |
   |---|---|
   | macOS 13.5+, Apple silicon | `SuDuo-<version>-mac-arm64.dmg` |
   | macOS 13.5+, Intel | `SuDuo-<version>-mac-x64.dmg` |
   | Windows 10 / 11 (x64) | `SuDuo-Setup-<version>-x64.exe` |

2. Install it.
   - **macOS**: open the `.dmg` and drag SuDuo to Applications. The first time you open it, macOS says it can't verify the developer. Click **Done**, open **System Settings → Privacy & Security**, click **Open Anyway** next to SuDuo, enter your password and click **Open**. You do this once for each new version.
   - **Windows**: run the installer. If SmartScreen says "Windows protected your PC", click **More info**, then **Run anyway**. It installs for you only, without administrator rights, and adds Start menu and desktop shortcuts.
3. SuDuo opens its own window and walks you through connecting to your team's server, Codex and your project folders.

Good to know:

- **Closing the window doesn't quit SuDuo.** It keeps running in the menu bar (macOS) or the notification area (Windows), so sessions keep going and Agents you share in rooms keep responding. Quit from that icon, or with ⌘Q on macOS. If sessions are in progress, SuDuo asks first.
- **Codex.** The app includes the Codex CLI version SuDuo is tested with and uses your `~/.codex`, so an existing Codex sign-in or model setup works as it is. Otherwise set an API key under **Settings → Model service**, or click **Sign in with ChatGPT** there: you authorize in your browser, and Codex keeps the sign-in itself.
- **Open at login** and the data and log folders are under **Settings → Desktop app**. Open at login is off by default; when it's on, SuDuo starts in the background without a window. On macOS you may also need to allow SuDuo under **System Settings → General → Login Items**.
- **Your data** is kept in `~/Library/Application Support/SuDuo Desktop` (macOS) or `%LOCALAPPDATA%\SuDuo Desktop` (Windows). It is separate from a source run, and the app listens on port 8790 instead of 8787, so you can use both. Requirements and rooms are on your team's server either way; sessions you had in a source run stay there.
- **Updating**: SuDuo checks for a new version when it starts and once a day (you can turn this off or check now under **Settings → Desktop app**), and shows a bar at the top of the window. It never updates on its own. On Windows, click **Update**: SuDuo downloads the new version, asks first if sessions are in progress, then quits, installs and reopens. On macOS (the unsigned trial can't replace itself), **Download** opens the release page: quit SuDuo from the menu bar, then replace it in Applications. Your data is kept.
- **Uninstalling**: on macOS, quit SuDuo and move it from Applications to the Trash; the data folder above stays until you delete it. On Windows, use **Settings → Apps → SuDuo → Uninstall**; it asks whether to delete your local data too (kept by default).
- If SuDuo can't start, its window says why and shows where the log is (`logs` in the data folder), with a button to run diagnostics.

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

Use the same release as your team's server. SuDuo shows a hint in **Settings → About** when the versions differ.

`pnpm start` checks your environment, builds SuDuo the first time (about 1–2 minutes), starts the local service on `http://127.0.0.1:8787` and opens your browser. If SuDuo is already running, it just opens the browser. Press `Ctrl+C` to stop it.

| Option | |
|---|---|
| `pnpm start --port 18787` | Use another port |
| `pnpm start --no-open` | Do not open the browser |
| `pnpm start --rebuild` | Rebuild before starting |

## Set up Codex

SuDuo runs the Codex CLI version pinned in `client/` with your own Codex configuration in `~/.codex`, the same directory your own Codex CLI uses. Either:

- sign in from the `client/` directory: `pnpm exec codex login`; or
- configure a model service in SuDuo under **Settings → Model service**: SuDuo passes the base URL and API key to Codex, which saves them in `~/.codex`. This changes the configuration your own Codex CLI uses too, and can replace an existing ChatGPT sign-in.

SuDuo itself does not keep a copy of your key, and sends nothing to SuDuo's authors.

## Connect to your team

1. **Settings → Requirements service**: enter your team's server address, then register or sign in.
2. For each project, choose the folder on your computer where its code lives.
3. Open a requirement and start a session.

## Language

**Interface.** SuDuo follows your system language by default (as your browser reports it). To pick English or Simplified Chinese yourself, go to **Settings → Appearance → Language**. The choice is saved in this browser.

**Terminal output.** `pnpm start`, `pnpm run doctor` and the local service's startup errors follow the system locale: Chinese when it is Chinese, English otherwise. SuDuo reads `LC_ALL`, `LC_MESSAGES` and `LANG`, and the first one that is set decides; on Windows, where these are usually not set, it uses the Windows region settings. To choose a language, set `SUDUO_LOCALE` to `zh-CN` or `en`:

```bash
SUDUO_LOCALE=en pnpm start                # macOS
```

```powershell
$env:SUDUO_LOCALE = "en"; pnpm start      # Windows PowerShell (applies to this window)
```

`SUDUO_LOCALE` only changes terminal output; the interface keeps its own setting. The diagnostics page at `http://127.0.0.1:8787/doctor` uses the language you last used in the interface; add `?lang=en` or `?lang=zh-CN` to choose.

## Updating

Stop SuDuo first (`Ctrl+C` in the window running `pnpm start`; on Windows `pnpm install` fails while SuDuo still has its files open), then in the `client/` directory:

```bash
git fetch --tags
git checkout v0.10.0    # the release your team uses
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
| Something is wrong and you don't know what | `pnpm run doctor` in `client/`, or **Settings → Diagnostics**, or open `http://127.0.0.1:8787/doctor` |
| `pnpm install` fails on `better-sqlite3` | It downloads a prebuilt binary; behind a firewall it falls back to compiling. Install build tools: `xcode-select --install` on macOS, or Visual Studio Build Tools with "Desktop development with C++" on Windows. Then run `pnpm install` again |
| Downloads from npm are slow or fail (for example in mainland China) | `pnpm config set registry https://registry.npmmirror.com`, then `pnpm install` |
| You are behind a company proxy | Set `HTTPS_PROXY` for `pnpm install`. For Codex, set the proxy in **Settings → Network proxy** |
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
