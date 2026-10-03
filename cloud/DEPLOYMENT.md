# Deploying the SuDuo cloud

[中文](DEPLOYMENT.zh-CN.md)

The SuDuo cloud is the server your team shares. It stores projects, requirements, comments, attachments and discussion rooms in PostgreSQL and two file volumes. Code, repositories and Codex sessions never reach it: they stay on each person's computer, where the SuDuo client runs.

This guide installs the cloud on a Linux server with Docker, from source, with one script.

## Requirements

| | |
|---|---|
| Operating system | **Ubuntu 22.04 or 24.04 (x86_64): supported.** Other Linux distributions with Docker, including arm64 servers: best effort. |
| Hardware | At least 2 CPU cores, 4 GB RAM and 20 GB disk. Building the image needs most of the memory; with less, the build may fail. |
| Software | Docker Engine with the Compose plugin (`docker compose`), and git |
| Network | Outbound access to Docker Hub and npm while building, or mirrors you can reach (see [Mirrors](#mirrors)). Team members must be able to reach the service port (4100 by default). |

## 1. Install Docker

On Ubuntu, either use Ubuntu's own packages:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 docker-buildx git
```

or Docker's official packages: <https://docs.docker.com/engine/install/ubuntu/>. To run `docker` without `sudo`, add yourself to the `docker` group (`sudo usermod -aG docker $USER`) and log in again. Otherwise run the script below with `sudo`.

## 2. Get the code

```bash
git clone https://github.com/Im-Sue/suduo-workbench.git
cd suduo-workbench
git checkout "$(git describe --tags --abbrev=0)"   # the latest release tag
cd cloud
```

Use a release tag rather than `main`. Clients and the cloud should run the same version; the client shows a hint when they differ.

## 3. Install

```bash
sudo ./scripts/suduo-cloud.sh install
```

Options:

- `--port 4100`: the port the service listens on (default 4100).
- `--mirror cn`: build with mirrors in mainland China (see [Mirrors](#mirrors)).

The script:

1. checks Docker, Compose and the port;
2. creates `server/.env` with a random database password and signing secret. **Keep this file safe.** If it already exists, it is kept as is and never overwritten;
3. builds the image from source and starts PostgreSQL and the service. The first build takes about 3–8 minutes;
4. waits until `/v2/health` reports ready, then prints the address.

```text
  ✓ SuDuo cloud is ready (version 0.7.0, database schema 011_rooms_and_shared_agents.sql)

  Address: http://10.0.0.12:4100
  Next: enter this address in the SuDuo client settings. Anyone can then register and start.
```

The containers restart automatically with Docker, including after a server reboot.

## 4. Connect the clients

Each team member runs the SuDuo client on their own computer, opens **Settings → Requirements service**, enters the address and registers an account. See the [client quick start](../README.md).

## Security

- **Anyone who can reach the service can register an account.** This version has no administrator or invitation system. Keep the service on a private network or VPN, or put it behind a reverse proxy with access control.
- Limit who can reach the port with your cloud provider's security group or network firewall. **ufw does not help here**: Docker publishes container ports through its own iptables rules, which take effect before ufw's.
- Use HTTPS when the service is reachable beyond a trusted network (see below).
- `server/.env` contains the database password and the signing secret. It is created with mode 600; keep it that way.

### HTTPS with a reverse proxy

The service speaks plain HTTP. Put a reverse proxy in front of it for HTTPS. Two things matter:

- **Uploads**: attachments and room files can be up to **300 MiB**. Raise the proxy's body size limit.
- **Live updates** use Server-Sent Events: turn off response buffering and allow long-lived connections.

Nginx:

```nginx
server {
    listen 443 ssl;
    server_name suduo.example.com;
    ssl_certificate     /etc/ssl/suduo/fullchain.pem;
    ssl_certificate_key /etc/ssl/suduo/privkey.pem;

    client_max_body_size 300m;

    location / {
        proxy_pass http://127.0.0.1:4100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

Caddy (gets a certificate automatically for a public domain):

```caddy
suduo.example.com {
    request_body {
        max_size 300MB
    }
    reverse_proxy 127.0.0.1:4100 {
        flush_interval -1
    }
}
```

With a proxy on the same server, publish the service port on the loopback address only, so the proxy is the only way in. Create `server/compose.override.yaml` (it stays out of git, and the script picks it up automatically; it needs Docker Compose 2.24 or later):

```yaml
services:
  requirements-service:
    ports: !override
      - "127.0.0.1:4100:4100"
```

Then apply it with `sudo ./scripts/suduo-cloud.sh stop && sudo ./scripts/suduo-cloud.sh start`. Use the same port as `REQUIREMENTS_PORT` in `server/.env`.

## Operations

All commands run in the `cloud/` directory.

| Command | What it does |
|---|---|
| `sudo ./scripts/suduo-cloud.sh status` | Containers, version, database schema, data size and the latest backup |
| `sudo ./scripts/suduo-cloud.sh logs` | Follow the service logs (`--db` for PostgreSQL) |
| `sudo ./scripts/suduo-cloud.sh stop` / `start` | Stop / start without touching data |
| `sudo ./scripts/suduo-cloud.sh backup` | Back up (see below) |
| `sudo ./scripts/suduo-cloud.sh restore <dir>` | Restore a backup (see below) |
| `sudo ./scripts/suduo-cloud.sh upgrade` | Upgrade to the checked-out version (see below) |
| `sudo ./scripts/suduo-cloud.sh uninstall` | Remove containers and the image; data and `server/.env` stay |
| `sudo ./scripts/suduo-cloud.sh uninstall --purge` | Also delete all data. Asks you to type `purge`. Cannot be undone |

### Upgrade

```bash
git fetch --tags
git checkout v0.8.0            # the release you want
sudo ./scripts/suduo-cloud.sh upgrade
```

The script backs up first. If the backup fails, it stops and does not upgrade. Then it rebuilds, starts, and the service migrates the database on start. Database migrations only go forward.

**To roll back**, check out the previous tag and restore the backup the upgrade made:

```bash
git checkout v0.7.0
sudo ./scripts/suduo-cloud.sh restore /var/backups/suduo/<timestamp>
```

### Backup

```bash
sudo ./scripts/suduo-cloud.sh backup              # to /var/backups/suduo/<timestamp>
sudo ./scripts/suduo-cloud.sh backup --to /data/backups
```

A backup is a directory with `database.pgdump` (PostgreSQL), `files.tar.gz` (attachments and room files) and `manifest.txt` (version, schema and checksums). The script stops the service for the few seconds the backup takes, so the database and the files match.

**Do not combine an online `pg_dump` with a separate online copy of the file volumes.** Attachment and room file metadata live in PostgreSQL, the files live in the volumes; uploads between the two copies leave them out of step after a restore. Either let the script stop the service, or use a storage snapshot that covers the database and both volumes at the same instant.

Daily backup with cron (as root), keeping 14 days:

```cron
30 3 * * * cd /path/to/suduo-workbench/cloud && ./scripts/suduo-cloud.sh backup >> /var/log/suduo-backup.log 2>&1 && find /var/backups/suduo -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
```

Copy backups to another machine as well.

### Restore

```bash
sudo ./scripts/suduo-cloud.sh restore /var/backups/suduo/<timestamp>
```

Restoring **replaces all current data** with the backup. The script checks the backup's checksums, asks you to type `restore`, stops the service, restores the database and the files, and starts the service again. Afterwards, download a few attachments to check them.

You can restore on a new server too: install SuDuo there first (`install`), copy the backup directory over, then run `restore`.

For scripted use without a terminal, `SUDUO_ASSUME_YES=1` skips the typed confirmation of `restore` and `uninstall --purge`.

## Mirrors

In mainland China, Docker Hub and npm are often slow or unreachable. `--mirror cn` writes these settings into `server/.env`:

```dotenv
SUDUO_NODE_IMAGE=docker.m.daocloud.io/library/node:24.10.0-bookworm-slim
SUDUO_POSTGRES_IMAGE=docker.m.daocloud.io/library/postgres:17.4-bookworm
SUDUO_NPM_REGISTRY=https://registry.npmmirror.com
```

These are third-party mirrors and their availability changes. If a build fails while pulling, edit these lines to point at a mirror you can reach (any registry that serves the same Docker Hub images, and any npm registry), then run `install` again. Upgrades keep using the same settings.

## Configuration

`server/.env` holds all settings; [`server/.env.example`](server/.env.example) documents every key. After editing it, apply the change with `sudo ./scripts/suduo-cloud.sh stop && sudo ./scripts/suduo-cloud.sh start`. The data lives in three Docker volumes: `requirements_postgres_data`, `requirements_attachments` and `requirements_room_files` (prefixed with `suduo-requirements-service_`).

### Without the script

The script only wraps Docker Compose. To run the same steps by hand:

```bash
cp server/.env.example server/.env    # then replace the password and the secret
docker compose --env-file server/.env -f server/compose.yaml up --build -d
curl --fail http://127.0.0.1:4100/v2/health
```

`/v2/health` queries PostgreSQL and returns HTTP 503 when the database is unreachable, so it checks more than whether the process is alive.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `permission denied while trying to connect to the docker API` | Run the script with `sudo`, or add your user to the `docker` group and log in again |
| The build fails while pulling images or installing packages | Network: use `--mirror cn` or other mirrors (see [Mirrors](#mirrors)) |
| The build stops with no clear error, or the server becomes unresponsive | Usually not enough memory. Use at least 4 GB, or add swap |
| Not ready within 180 seconds | `sudo ./scripts/suduo-cloud.sh logs` and `logs --db` |
| Port already in use | `install --port <another port>` |
| Clients cannot connect | Check the firewall and that the address in the client settings is reachable from that computer |

## License

SuDuo is source-available under the [PolyForm Noncommercial License 1.0.0](../LICENSE). **Use by a company is commercial use: start right away and register within 30 days of first use.** Registration is currently free; see [COMMERCIAL.md](../COMMERCIAL.md).
