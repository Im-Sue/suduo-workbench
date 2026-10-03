# 部署速舵 SuDuo 云端

[English](DEPLOYMENT.md)

SuDuo 云端是团队共用的服务器：项目、需求、评论、附件和讨论房间存在 PostgreSQL 和两个文件卷里。代码、仓库和 Codex 会话不会到这里来，它们只在每个人自己的电脑上，由 SuDuo 客户端负责。

本文介绍如何在一台装有 Docker 的 Linux 服务器上，用一个脚本从源码装好云端。

> 本页为中文版。若与英文版 [DEPLOYMENT.md](DEPLOYMENT.md) 有出入，以英文版为准。

## 系统要求

| | |
|---|---|
| 操作系统 | **Ubuntu 22.04 或 24.04（x86_64）：正式支持。** 其他装了 Docker 的 Linux 发行版（含 arm64 服务器）：尽力支持 |
| 硬件 | 至少 2 核 CPU、4 GB 内存、20 GB 磁盘。构建镜像时内存占用最高，更少可能构建失败 |
| 软件 | Docker Engine 与 Compose 插件（`docker compose`），以及 git |
| 网络 | 构建时要能访问 Docker Hub 和 npm，或你能访问的镜像源（见[镜像源](#镜像源)）。团队成员要能访问服务端口（默认 4100） |

## 1. 安装 Docker

在 Ubuntu 上，可以用 Ubuntu 自带的软件包：

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 docker-buildx git
```

也可以用 Docker 官方的软件包：<https://docs.docker.com/engine/install/ubuntu/>（国内可用阿里云、清华等镜像站提供的 docker-ce 安装源）。想不加 `sudo` 运行 `docker`，把自己加入 `docker` 组（`sudo usermod -aG docker $USER`）后重新登录；否则下面的脚本用 `sudo` 运行。

## 2. 获取代码

```bash
git clone https://github.com/Im-Sue/suduo-workbench.git
cd suduo-workbench
git checkout "$(git describe --tags --abbrev=0)"   # 最新的发布标签
cd cloud
```

仓库还没有发布标签时，留在 `main` 即可。

请用发布标签，不要直接用 `main`。客户端和云端应使用相同版本，版本不一致时客户端会给出提示。

## 3. 安装

```bash
sudo ./scripts/suduo-cloud.sh install
```

参数：

- `--port 4100`：服务监听的端口（默认 4100）。
- `--mirror cn`：使用国内镜像源构建（见[镜像源](#镜像源)）。

脚本会：

1. 检查 Docker、Compose 和端口；
2. 生成 `server/.env`，数据库密码和签名密钥都是随机值。**请妥善保管这个文件。** 文件已存在时原样沿用，绝不覆盖；
3. 从源码构建镜像，启动 PostgreSQL 和服务。首次构建约 3–8 分钟；
4. 等 `/v2/health` 报告就绪后，打印访问地址。

```text
  ✓ SuDuo 云端已就绪（版本 x.y.z，数据库 schema 011_rooms_and_shared_agents.sql）

  访问地址：http://10.0.0.12:4100
  下一步：在 SuDuo 客户端的设置里填上这个地址，第一个注册的人即可开始使用。
```

容器随 Docker 自动重启，服务器重启后也会自己起来。

## 4. 连接客户端

团队成员在自己电脑上运行 SuDuo 客户端，打开 **设置 → 需求服务**，填入地址并注册账号。见[客户端指南](../client/README.zh-CN.md)。

## 安全

- **任何能访问到服务的人都能注册账号。** 这一版没有管理员和邀请机制。请只在内网或 VPN 内开放，或放到带访问控制的反向代理后面。
- 用云服务商的安全组或网络防火墙限制谁能访问这个端口。**ufw 在这里不起作用**：Docker 通过自己的 iptables 规则发布容器端口，这些规则先于 ufw 生效。
- 服务需要在可信网络以外被访问时，请使用 HTTPS（见下文）。
- `server/.env` 里有数据库密码和签名密钥，创建时权限为 600，请保持。

### 用反向代理提供 HTTPS

服务本身只提供 HTTP，HTTPS 需要在前面放一个反向代理。有两点要注意：

- **上传**：附件和房间文件最大 **300 MiB**，要调大代理的请求体上限。
- **实时推送**用的是 SSE（Server-Sent Events）：要关闭响应缓冲，并允许长连接。

Nginx：

```nginx
server {
    listen 443 ssl;
    server_name suduo.example.com;
    ssl_certificate     /etc/ssl/suduo/fullchain.pem;
    ssl_certificate_key /etc/ssl/suduo/privkey.pem;

    client_max_body_size 310m;

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

Caddy（公网域名会自动申请证书）：

```caddy
suduo.example.com {
    request_body {
        max_size 310MiB
    }
    reverse_proxy 127.0.0.1:4100 {
        flush_interval -1
    }
}
```

代理和服务在同一台服务器上时，可以让服务端口只对本机开放，所有访问都必须经过代理。新建 `server/compose.override.yaml`（不进 git，脚本会自动带上；需要 Docker Compose 2.24.4 及以上）：

```yaml
services:
  requirements-service:
    ports: !override
      - "127.0.0.1:${REQUIREMENTS_PORT:-4100}:${REQUIREMENTS_PORT:-4100}"
```

然后执行 `sudo ./scripts/suduo-cloud.sh stop && sudo ./scripts/suduo-cloud.sh start` 生效。

## 日常运维

以下命令都在 `cloud/` 目录下执行。

| 命令 | 作用 |
|---|---|
| `sudo ./scripts/suduo-cloud.sh status` | 容器状态、版本、数据库 schema、数据占用、最近一次备份 |
| `sudo ./scripts/suduo-cloud.sh logs` | 跟随服务日志（`--db` 看 PostgreSQL 日志） |
| `sudo ./scripts/suduo-cloud.sh stop` / `start` | 停止 / 启动，不动数据 |
| `sudo ./scripts/suduo-cloud.sh backup` | 备份（见下文） |
| `sudo ./scripts/suduo-cloud.sh restore <目录>` | 先备份当前数据，再从备份恢复，并按当前检出的版本启动（见下文） |
| `sudo ./scripts/suduo-cloud.sh upgrade` | 先备份，再升级到当前检出的版本（见下文） |
| `sudo ./scripts/suduo-cloud.sh uninstall` | 删除容器和镜像，数据与 `server/.env` 保留 |
| `sudo ./scripts/suduo-cloud.sh uninstall --purge` | 连同全部数据一起删除。需要输入 `purge` 确认，无法撤销 |

### 升级

```bash
git fetch --tags
git checkout v0.8.0            # 要升级到的版本
sudo ./scripts/suduo-cloud.sh upgrade
```

脚本会先备份（到 `/var/backups/suduo/<时间戳>-pre-upgrade`，或用 `--backup-to <目录>` 指定）。备份失败就停下来，不会继续升级：可以修好后重试；如果已经有别的退路（例如服务器快照），可以加 `--no-backup`。然后重新构建并启动，服务启动时自动迁移数据库。数据库迁移只能向前。

**回滚**：检出之前的标签，再恢复升级时做的那份备份。`restore` 会按当前检出的版本启动，所以旧版本和它的数据会一起回来：

```bash
git checkout v0.7.0
sudo ./scripts/suduo-cloud.sh restore /var/backups/suduo/<时间戳>-pre-upgrade
```

### 备份

```bash
sudo ./scripts/suduo-cloud.sh backup              # 备份到 /var/backups/suduo/<时间戳>
sudo ./scripts/suduo-cloud.sh backup --to /data/backups
```

一份备份是一个目录，里面有 `database.pgdump`（PostgreSQL）、`files.tar.gz`（附件与房间文件）和 `manifest.txt`（版本、schema、校验值），只有你（root）能读。备份期间脚本会暂停服务，保证数据库和文件对得上；暂停时长随数据量增加，备份失败或被中断时服务也会恢复运行。失败的备份不会留下残缺的目录。

**不要把在线执行的 `pg_dump` 和另外在线拷贝的文件卷拼成一份备份。** 附件和房间文件的元数据在 PostgreSQL 里，文件本身在卷里；两次拷贝之间如果有人上传，恢复后两者就会对不上。要么让脚本停服备份，要么使用能在同一时刻覆盖数据库和两个卷的存储快照。

用 cron 每天备份（以 root 身份），保留 14 天：

```cron
30 3 * * * cd /path/to/suduo-workbench/cloud && ./scripts/suduo-cloud.sh backup >> /var/log/suduo-backup.log 2>&1 && find /var/backups/suduo -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
```

cron 以 root 身份运行脚本，所以代码目录必须归 root 所有、其他用户不可写，否则能改脚本的人就能以 root 身份执行命令。

备份最好再拷一份到其他机器上。

### 恢复

```bash
sudo ./scripts/suduo-cloud.sh restore /var/backups/suduo/<时间戳>
```

恢复会用备份**替换当前全部数据**。脚本会：

1. 核对备份的校验值，并确认数据库导出与文件归档都能读取；备份损坏时，在动任何数据之前就停下来；
2. 要求你输入 `restore` 确认；
3. 把当前数据备份到 `/var/backups/suduo/<时间戳>-pre-restore`，恢复本身也能撤回（`--no-pre-backup` 跳过这一步）；
4. 停服，重建数据库并在单个事务里导入备份，再替换附件和房间文件；
5. 按**当前检出的版本**重新构建并启动。如果当前版本比备份新，数据库会自动迁移到新版本；要回到备份时的版本，请先检出那个版本。

某一步失败时，脚本会说明进行到了哪里。服务保持停止，可以用同一份备份再执行一次 `restore`。恢复后请下载几个附件抽查一下。

也可以在一台新服务器上恢复：先在新服务器上安装（`install`），把备份目录拷过去，再执行 `restore`。

在没有终端的自动化脚本里，用 `sudo SUDUO_ASSUME_YES=1 ./scripts/suduo-cloud.sh restore <目录>` 跳过输入确认（`uninstall --purge` 同理）。

## 镜像源

在国内，Docker Hub 和 npm 经常很慢或连不上。`--mirror cn` 会把下面几行写进 `server/.env`：

```dotenv
SUDUO_IMAGE_REGISTRY=docker.m.daocloud.io/library
SUDUO_NPM_REGISTRY=https://registry.npmmirror.com
```

这里只记镜像仓库；Node.js 与 PostgreSQL 的版本写在 `server/compose.yaml` 里，升级时随代码一起更新。这些是第三方镜像源，可用性会变化。如果构建卡在拉取镜像或下载依赖上，把这两行改成你能访问的镜像源（任何以相同名称提供 Docker Hub 官方镜像的仓库、任何 npm 源都可以），再执行一次 `install`。

## 配置

所有设置都在 `server/.env` 里，每一项的说明见 [`server/.env.example`](server/.env.example)。改完后执行 `sudo ./scripts/suduo-cloud.sh stop && sudo ./scripts/suduo-cloud.sh start` 生效。数据存放在三个 Docker 卷里：`requirements_postgres_data`、`requirements_attachments`、`requirements_room_files`（前缀为 `suduo-requirements-service_`）。

### 不用脚本

脚本只是对 Docker Compose 的封装，也可以手动执行同样的步骤：

```bash
cp server/.env.example server/.env    # 然后替换其中的密码和密钥
docker compose --env-file server/.env -f server/compose.yaml up --build -d
curl --fail http://127.0.0.1:4100/v2/health
```

`/v2/health` 会查询 PostgreSQL，数据库不可达时返回 HTTP 503，所以它检查的不只是进程是否活着。

## 常见问题

| 现象 | 怎么办 |
|---|---|
| `permission denied while trying to connect to the docker API` | 用 `sudo` 运行脚本，或把当前用户加入 `docker` 组后重新登录 |
| 构建卡在拉取镜像或安装依赖上失败 | 网络问题：用 `--mirror cn` 或其他镜像源（见[镜像源](#镜像源)） |
| 构建没有明确报错就停了，或服务器卡死 | 多半是内存不够。至少 4 GB，或加交换空间 |
| 180 秒内没有就绪 | 查看 `sudo ./scripts/suduo-cloud.sh logs` 和 `logs --db` |
| 端口被占用 | `install --port <其他端口>` |
| 客户端连不上 | 检查防火墙 / 安全组，确认客户端设置里的地址在那台电脑上能访问到 |

## 许可

速舵 SuDuo 以 [PolyForm 非商业许可证 1.0.0](../LICENSE) 源码公开。**企业使用属于商业使用：可以直接开始用，请在开始使用后 30 天内登记。** 目前登记免费，见 [COMMERCIAL.zh-CN.md](../COMMERCIAL.zh-CN.md)。
