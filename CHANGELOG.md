# Changelog

[中文](CHANGELOG.zh-CN.md)

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
