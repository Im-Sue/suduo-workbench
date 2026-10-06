# Contributing to SuDuo

[中文](CONTRIBUTING.zh-CN.md)

Thanks for your interest in SuDuo. Issues and pull requests are welcome in English or Chinese.

## Before you start

- **Bugs**: open an issue with steps to reproduce, what you expected, and what happened. Include versions (SuDuo, Node, Codex CLI, OS).
- **Features and larger changes**: open an issue first so we can agree on the approach before you write code. Requirements and design decisions are kept in [`docs/`](docs/) (written in Chinese): requirements in `docs/02_需求设计/`, technical designs in `docs/03_开发计划/`, decisions (ADRs) in `docs/06_决策记录/`.
- **Security issues**: do not open a public issue. Email security@suduo.dev.

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

## Interface text and languages

SuDuo ships in Simplified Chinese and English. Everything SuDuo itself shows to users exists in both languages.

- **Put text in the dictionaries, not in code.** Every piece of user-facing text, including `aria-label`, placeholders, empty states and error messages, goes into a dictionary:
  - web interface: `client/web/src/i18n/messages/zh-CN/<area>.ts` and `client/web/src/i18n/messages/en/<area>.ts`
  - local service (errors, diagnostics, text given to Codex, terminal output): `client/server/src/i18n/messages/zh-CN/` and `client/server/src/i18n/messages/en/`
  - scripts that run before the build (`pnpm start`, `install:m1`, `uninstall:m1`): `client/scripts/i18n/messages/zh-CN.mjs` and `client/scripts/i18n/messages/en.mjs`
- **The Chinese dictionary is the template.** The English one must have the same entries with the same parameters (`satisfies`), so a missing, extra or mismatched entry fails `pnpm typecheck`; for the script messages, a test checks the same. `pnpm lint` rejects Chinese text written directly in source code.
- **The cloud server writes English only.** Its error messages are English and carry an error code; the client shows its own text for each code. System text that is stored or seen by other people (such as the comment SuDuo writes when a confirmed version is published without a note, or a shared agent's status) is saved as a code with parameters and shown in each reader's language.
- **Do not translate what people write.** Requirements, comments, room messages, file names, names and Codex's answers are shown as written. Only text that SuDuo generates follows the interface language.
- **Text for Codex follows the session.** Instructions, tool descriptions and tool replies use the language the session was created in, not the current interface language.
- **English style.** Use the glossary and writing rules in §12 of the [bilingual technical design](docs/03_开发计划/产品中英双语-技术设计.md) (in Chinese, with the English term for each entry): sentence case, short and direct, and `plural()` for counts. Add new terms to the glossary before using them.
- **Tests** run in Chinese by default (`client/web/test/setup-dom.ts`). Switch to English explicitly in English test cases, for example with `applyLocalePreference("en")`.
- **Not translated:** messages that only go to the logs (write them in English, outside the dictionaries), developer-only scripts (`dev-local.sh`, `dev-postgres.sh`, `gate-c-vm.sh`) and the unreleased Windows installer.

## Running the client on Linux (development)

Linux is not a supported client platform for users, but development and the gate-c end-to-end check run there. `pnpm start` works as on macOS. To install the client as a systemd user service (this is what gate-c uses):

```bash
cd client
pnpm install:m1 -- --codex-home "$HOME/.codex"     # builds, runs doctor, registers suduo.service
pnpm uninstall:m1                                   # keeps local data; add -- --purge-data to delete it
```

Codex sandboxes commands on Linux with bubblewrap. Follow OpenAI's [sandbox prerequisites](https://developers.openai.com/codex/concepts/sandboxing):

```bash
sudo apt install bubblewrap
# Ubuntu 24.04 restricts unprivileged user namespaces with AppArmor; load the official allowance profile:
sudo apt install apparmor-profiles apparmor-utils
sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

`pnpm run doctor` checks the sandbox and explains what to do when it fails. Terminal output follows the system locale; many Linux systems and CI runners default to `C.UTF-8`, which gives English. Set `SUDUO_LOCALE=zh-CN` or `SUDUO_LOCALE=en` to choose. The Windows installer is not released yet; see [client/scripts/dist-win/README.md](client/scripts/dist-win/README.md) (in Chinese).

## Design principles

- **People arbitrate, not the system** ([ADR-0004](docs/06_决策记录/ADR-0004-人机协作系统的一致性边界.md)). By default we do not add locks, version checks or other guards that refuse a user's action. Detect conflicts and tell people what changed. Refusing is reserved for irreversible data loss and irreversible external side effects.
- **Shared requirements, private code.** Requirements and room discussions live on the team server. Code, repositories and Codex sessions stay on each user's machine.

## Pull requests

- Keep each pull request focused on one change, and describe what changed and why.
- Add or update tests for behavior changes.
- Make sure the quality gates above pass.
- Tick the CLA box in the pull request template.
