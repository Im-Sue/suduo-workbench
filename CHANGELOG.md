# Changelog

[中文](CHANGELOG.zh-CN.md)

## Unreleased

### Fixed

- In a requirement's attachment list, the names of PDFs and other files that open in a new tab showed as blue underlined links. They now look like the other file names and are underlined only on hover.

## 0.10.0 — 2026-10-07

Adds requirement priorities and files in comments, makes attachments a plain list again, and keeps project folder links apart for each server.

### Added

- Requirement priority: urgent, high, medium, low or none (the default). Set it when creating a requirement, on the requirement page, on a board card or in the list. Board columns and the list sort by priority by default (then by last update); you can switch back to last updated, and filter by priority. It needs a server on 0.10.0 or later.
- Files in comments: attach files or paste screenshots in the comment box. They're uploaded when you send, belong to that comment, and can be saved as attachments of the requirement. A comment can be just files. It needs a server on 0.10.0 or later.

### Changed

- Attachments are one list again, newest first: the place for the final PRD, third-party material, screenshots and archives. When files overlap, the newer one wins. Publishing new confirmed versions has stopped; earlier confirmed versions stay readable under “Past confirmed versions”, and older clients can still publish to the server.
- The requirement tools Codex uses no longer publish confirmed versions; sessions that still call them get a reply saying the tool has been retired.
- Requirements accept the same file types as room files (archives, videos, logs and more), up to 100 attachments each.
- Project folder links are kept per server. Moving to another server no longer leaves your folders tied to the old server's projects, and you can unlink a folder without reaching the server.
- One folder can be linked to several projects. When you choose a folder that other projects already use, SuDuo tells you which ones instead of refusing.
- Project sessions remember which project they belong to (local database migration 018), so sessions and requirement context follow the project even when projects share a folder.

### Upgrading

- Upgrade the server first, then each client. Settings → About shows a hint while the two versions differ; a 0.10.0 client hides priorities and files in comments until the server supports them.
- Cloud: `git fetch --tags && git checkout v0.10.0`, then `sudo ./scripts/suduo-cloud.sh upgrade`. It backs up first; database migrations 014 (priority) and 015 (comment files) run when the service starts. If `server/.env` still has the attachment extension list or the limit of 20 attachments that earlier versions wrote there unchanged, the script comments them out so the new defaults apply; values you changed are kept. See [cloud/DEPLOYMENT.md](cloud/DEPLOYMENT.md).
- Client from source: `git fetch --tags && git checkout v0.10.0`, `pnpm install`, then `pnpm start`. Local database migration 018 runs when the local service starts; your existing folder links are kept and tied to the server you're connected to.
- Desktop app: install the 0.10.0 installer from this release over the old version (on macOS, quit SuDuo from the menu bar first and replace it in Applications). Your data is kept.

### Known limitations

- The desktop app is a trial: it isn't signed yet (see the [client guide](client/README.md#desktop-app-trial) for opening it the first time) and doesn't update itself. The Intel Mac and Windows packages haven't been tested on real hardware yet.
- Codex can't post comments with files yet.
- The cloud has no administrator or invitation system: anyone who can reach it can register. Keep it on a private network or VPN, or behind a reverse proxy with access control.

## 0.9.0 — 2026-10-07

Adds a desktop app for macOS and Windows, as a trial. Download it from this release and open it; you don't need Node.js, pnpm or git. Running from source still works.

### Added

- Desktop app (trial) for macOS 13.5+ (Apple silicon and Intel) and Windows 10 / 11 (x64). The installers are attached to this release; see the [client guide](client/README.md#desktop-app-trial).
  - It includes the local service, the Codex CLI version SuDuo is tested with (0.159.2) and Node.js. It uses your `~/.codex`, so an existing Codex sign-in or model setup works as it is.
  - Closing the window keeps SuDuo running in the menu bar (macOS) or the notification area (Windows), so sessions keep going and Agents you share in rooms keep responding. Quit from that icon or with ⌘Q; if sessions are in progress, SuDuo asks first.
  - If the local service stops unexpectedly, SuDuo restarts it. If it can't start, the window says why, shows where the log is and offers to run diagnostics.
  - Opened from Finder on macOS, it reads your login shell's environment, so commands Codex runs in your project find the same tools as in your terminal.
  - It keeps its own data (`~/Library/Application Support/SuDuo Desktop` on macOS, `%LOCALAPPDATA%\SuDuo Desktop` on Windows) and listens on port 8790, so it can run next to a source run.

### Changed

- Diagnostics accept any Node.js 24 from 24.10.0 on, matching what SuDuo requires. Before, any version other than 24.10.0 was reported as a failure.
- `pnpm start` says when its port is used by the SuDuo desktop app and leaves it alone.
- Commands that Codex runs no longer inherit the local service's own `SUDUO_*` settings (only `SUDUO_LOCALE` is passed on), so running SuDuo's scripts inside a Codex session doesn't pick up the running service's port or data folder.

### Fixed

- Image attachments in the requirement side panel couldn't be opened. They now open in a preview, and PDFs and other previewable files open in a new tab. Clicking a file's name works as well as the preview button, here and on the requirement page.

### Upgrading

- No database changes, on the server or on your computer.
- Cloud: `git fetch --tags && git checkout v0.9.0`, then `sudo ./scripts/suduo-cloud.sh upgrade`. The cloud has no functional changes in this release; upgrading keeps the version hint in Settings → About quiet.
- Client from source: `git fetch --tags && git checkout v0.9.0`, `pnpm install`, then `pnpm start`.
- Desktop app: install it from this release. It starts with its own data: connect to your team's server, sign in and choose your project folders again. Requirements and rooms are on the server, so they're all there; sessions from a source run stay in the source run.

### Known limitations

- The desktop app isn't signed yet.
  - macOS: the first time you open each version, macOS says it can't verify the developer. Click **Done**, then **Open Anyway** under **System Settings → Privacy & Security**.
  - Windows: SmartScreen may say “Windows protected your PC”; click **More info**, then **Run anyway**. Some antivirus programs may flag it.
- The desktop app doesn't update itself yet. Download the new version: on macOS quit SuDuo from the menu bar and replace it in Applications; on Windows run the new installer.
- The Intel Mac and Windows packages were built and tested automatically on GitHub's machines but haven't been tested on real hardware yet.
- There's no ChatGPT sign-in inside the app yet: use an existing Codex sign-in, an API key under Settings → Model service, or sign in with the bundled Codex from a terminal (see the client guide).
- The cloud has no administrator or invitation system: anyone who can reach it can register. Keep it on a private network or VPN, or behind a reverse proxy with access control.

## 0.8.0 — 2026-10-05

Adds an English interface. SuDuo's own text (the interface, what it tells Codex, command-line output) now comes in English and Chinese; what people write and Codex's answers are never translated.

### Added

- English interface. Switch it under Settings → Appearance → Language; by default SuDuo follows your system language. Only SuDuo's own text changes: what people write (requirements, comments, room messages, file names) and Codex's answers are shown as written, never translated.
- The instructions SuDuo gives Codex (requirement card, rules, tool descriptions and tool results) are written in the session's language, chosen when the session is created. SuDuo asks Codex to reply in the language you write in, whatever the interface language.
- Command-line output (`pnpm start`, `pnpm run doctor`, local service startup errors and `suduo-cloud.sh`) follows the system language. Set `SUDUO_LOCALE=zh-CN` or `SUDUO_LOCALE=en` to choose; with `sudo`, put it after `sudo`.

### Changed

- **If your browser's language isn't Chinese, the interface switches to English after you upgrade**, because the language follows your system by default. Choose 简体中文 under Settings → Appearance → Language to switch back. New sessions created while the interface is in English give Codex English instructions; existing sessions don't change.
- The requirement list view shows icons for the materials, comments and sessions column headers, so they fit in both languages.
- System text that other people see is stored as a type with parameters, so each person sees it in their own language: shared agent run reasons and progress (cloud database migration 013), @everyone mentions, the last message shown for a room, and runtime notices in a session.
- The last message shown in a requirement's room section now matches the room itself: an agent appears without its device name, and attachments read like “[Image]” or “[File] spec.pdf and 2 more”.
- The checkpoint name in the “Restore to before this turn?” dialog now matches the environment panel.
- Cloud error messages are in English; the client still shows its own message for each error code, in your language.
- Local sessions remember their language (local database migration 017); existing sessions stay Chinese.
- Dates older than yesterday in the session list, the overview timeline and the checkpoint list now read like the rest of the app (for example 9月27日, or 2025年9月27日 for earlier years, instead of 09-27).
- A publish note that happens to read exactly like the automatic "published version" comment is now shown as a note in the activity feed.
- Git checkpoints that SuDuo writes now end with a `SuDuo-Checkpoint:` line, so SuDuo recognises them whatever language their title is in. Older checkpoints are still recognised.
- Cloud: comments that SuDuo writes when a confirmed version is published without a note are now stored as a type with parameters (database migration 012), so every client can show them in its own language.

### Upgrading

- Upgrade the cloud first, then each client. Settings → About shows a hint while the two versions differ.
- Cloud: `git fetch --tags && git checkout v0.8.0`, then `sudo ./scripts/suduo-cloud.sh upgrade`. It backs up first; database migrations 012 and 013 run when the service starts. See [cloud/DEPLOYMENT.md](cloud/DEPLOYMENT.md).
- Client: `git fetch --tags && git checkout v0.8.0`, `pnpm install`, then `pnpm start`. It rebuilds, and local database migration 017 runs when the local service starts.

### Known limitations

- There is no installer yet; run the client from source.
- The cloud has no administrator or invitation system: anyone who can reach it can register. Keep it on a private network or VPN, or behind a reverse proxy with access control.

## 0.7.0 — 2026-10-02

The first public release. SuDuo is now source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE); companies can start right away and register within 30 days (see [COMMERCIAL.md](COMMERCIAL.md)).

### Cloud

- One-command self-hosting on Ubuntu / Linux with Docker: `cloud/scripts/suduo-cloud.sh install` builds from source, generates the secrets and starts PostgreSQL and the service.
- `upgrade` backs up first, `backup` / `restore` keep the database and the file volumes consistent, and `restore` backs up the current data first and starts the checked-out version, so rolling back is "check out the previous tag, then restore".
- `--mirror cn` builds with mirrors that are reachable in mainland China.
- The health check reports the product version.
- New deployment guide in English and Chinese: [cloud/DEPLOYMENT.md](cloud/DEPLOYMENT.md).

### Client

- `pnpm start` checks the environment, builds when needed, starts the local service and opens the browser on macOS (Apple silicon and Intel) and Windows 10 / 11. `Ctrl+C` stops it cleanly.
- Settings → About shows the cloud's version and a hint when it differs from the client.
- Settings → About shows the license and how to register commercial use.
- Default local data directory on macOS is now `~/Library/Application Support/SuDuo` (it was `~/.local/share/suduo`; SuDuo tells you if it finds data in the old place).

### Fixes

- Without `CODEX_HOME` set, the local service pointed Codex at a directory inside the repository that does not exist, so Codex could not start. It now uses `~/.codex` and creates it when missing.
- On Windows, Codex now starts even when the repository path contains spaces.
- Pressing `Ctrl+C` in a terminal no longer kills the local service before it finishes shutting down.
- The self-check no longer fails just because SuDuo itself is running.

### Known limitations

- The interface is in Chinese only; English is in progress.
- There is no installer yet; run the client from source.
- The cloud has no administrator or invitation system: anyone who can reach it can register. Keep it on a private network.
