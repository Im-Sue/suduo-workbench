# Contributing to SuDuo

[中文](CONTRIBUTING.zh-CN.md)

Thanks for your interest in SuDuo. Issues and pull requests are welcome in English or Chinese.

## Before you start

- **Bugs**: open an issue with steps to reproduce, what you expected, and what happened. Include versions (SuDuo, Node, Codex CLI, OS).
- **Features and larger changes**: open an issue first so we can agree on the approach before you write code. Requirements and design decisions are kept in [`docs/`](docs/) (written in Chinese): requirements in `docs/02_需求设计/`, technical designs in `docs/03_开发计划/`, decisions (ADRs) in `docs/06_决策记录/`.
- **Security issues**: do not open a public issue. Email im.suyejian@gmail.com.

## Contributor License Agreement

SuDuo is source-available under the [PolyForm Noncommercial License](LICENSE) and is also licensed commercially. Every pull request needs your agreement to the [Contributor License Agreement](CLA.md): tick the CLA box in the pull request description. A check on the pull request confirms it. You keep the copyright in your contribution.

## Repository layout

The repository is split by where things run. Each part is an independent pnpm workspace; run every command inside `client/` or `cloud/`.

```text
client/   runs on each user's computer: web (frontend), server (local backend), contracts, codex-protocol, scripts
cloud/    runs on the team's server: server (requirements service, with Dockerfile / compose), contracts (cloud API contracts), scripts
docs/     requirements, architecture, technical designs, ADRs
```

`client/` uses `cloud/contracts` through a `link:` dependency and compiles it during its own build. `cloud/` never depends on `client/`.

## Development environment

Tool versions are pinned in each workspace's `mise.toml`: Node 24.10.0 and pnpm 10.25.0 in both; PostgreSQL 17.4 for `cloud/`. Run `mise install` inside `client/` or `cloud/`. Machine-specific paths go in `mise.local.toml`, which is not committed:

```toml
# cloud/mise.local.toml
[env]
SUDUO_DEV_PGDATA = "/path/to/suduo/postgres-17"   # PostgreSQL data directory for development
TMPDIR = "/path/to/suduo/tmp"                      # on macOS this must be a real path (/tmp is a symlink)

# client/mise.local.toml
[env]
SUDUO_DEV_DATA = "/path/to/suduo/stack"            # data for the local dev stack (scripts/dev-local.sh)
TMPDIR = "/path/to/suduo/tmp"
```

Cloud tests need PostgreSQL. Run `sh scripts/dev-postgres.sh start` inside `cloud/`; it listens on 127.0.0.1:15432.

## Quality gates

Run these in the workspace you changed. If you change `cloud/contracts`, run them in both.

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm build && pnpm lint && pnpm test
```

In `client/`, also run `pnpm protocol:diff` when you touch the Codex integration. The end-to-end gates (`pnpm gate:a`, `gate:b`, `gate:c`) drive a real Codex CLI and need a `CODEX_HOME` with a working model configuration. `gate:c` needs Linux with systemd; on macOS, `sh scripts/gate-c-vm.sh` runs it in a Lima VM.

## Design principles

- **People arbitrate, not the system** ([ADR-0004](docs/06_决策记录/ADR-0004-人机协作系统的一致性边界.md)). By default we do not add locks, version checks or other guards that refuse a user's action. Detect conflicts and tell people what changed. Refusing is reserved for irreversible data loss and irreversible external side effects.
- **Shared requirements, private code.** Requirements and room discussions live on the team server. Code, repositories and Codex sessions stay on each user's machine.

## Pull requests

- Keep each pull request focused on one change, and describe what changed and why.
- Add or update tests for behavior changes.
- Make sure the quality gates above pass.
- Tick the CLA box in the pull request template.
