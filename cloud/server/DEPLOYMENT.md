# requirements-service 部署说明

本服务的 compose 构建上下文是 `cloud/` 工作区，因此请在 `cloud/` 目录下执行以下命令。

## 启动与健康检查

1. 创建运行配置：

   ```bash
   cp server/.env.example server/.env
   ```

2. 编辑 `.env`：替换 `REQUIREMENTS_AUTH_SECRET`，并确认 `POSTGRES_*` 凭据。`REQUIREMENTS_ATTACHMENT_ROOT` 必须保持为绝对路径。compose 会根据 `POSTGRES_*` 生成容器内的 `REQUIREMENTS_DATABASE_URL`；单独运行服务时则使用 `.env` 中的 `REQUIREMENTS_DATABASE_URL`。
3. 构建并启动：

   ```bash
   docker compose --env-file server/.env \
     -f server/compose.yaml up --build -d
   ```

4. 检查健康状态：

   ```bash
   curl --fail http://127.0.0.1:4100/v2/health
   ```

`/v2/health` 会执行 PostgreSQL 查询并读取 schema 版本；数据库不可达时它返回 HTTP 503。因此 Docker healthcheck 和上述请求都不是仅验证 HTTP 进程存活。

PostgreSQL 没有 `ports` 映射，不能从宿主机直接访问。数据存于 `requirements_postgres_data`，附件存于 `requirements_attachments`，房间文件（聊天里的图片 / 文件 / 视频）存于 `requirements_room_files`；三者是可独立管理的具名持久卷。

### 房间文件与实时推送（项目聊天房间与共享 Agent）

- `REQUIREMENTS_ROOM_FILE_ROOT`：房间文件根目录，绝对路径、SuDuo 独占（首次启动写入所有权标记 `.suduo-room-files-v1`），不能与 `REQUIREMENTS_ATTACHMENT_ROOT` 相同或互相嵌套。未设置时为 `<REQUIREMENTS_ATTACHMENT_ROOT>-rooms`；compose 里固定为 `/var/lib/suduo/room-files`（具名卷）。**单独运行服务并使用缺省值时，确保服务进程能在附件根目录的上级目录里创建该目录。**
- `REQUIREMENTS_ALLOWED_ROOM_FILE_EXTENSIONS`：房间文件允许的扩展名，缺省含常见图片、文档、压缩包与视频（mp4 / webm / mov / m4v）。
- 房间文件只增不删：启动时只清理 `.staging/` 里的半截上传，不删除任何对象。
- 房间事件推送在服务进程内存里（最近 2000 条，用于断线补发），服务重启后客户端按房间序号补拉；首期只支持单实例部署。到期共享、掉线 Agent 的扫描每 30 秒在进程内运行一次。

## 备份与恢复

备份前先识别卷名（Compose 会加上项目名前缀）：

```bash
docker compose --env-file server/.env \
  -f server/compose.yaml config --volumes
```

**禁止把在线单独执行的 `pg_dump` 与在线附件卷拷贝当作同一个可恢复备份。**附件与房间文件的元数据在 PostgreSQL、对象文件在附件卷与房间文件卷（`requirements_room_files`，备份 / 恢复方式与附件卷相同，需一并处理）；两次在线采集之间仍可能发生上传或删除，恢复后会产生元数据与文件错位。必须先停服务后同时备份，或使用能同时覆盖 PostgreSQL 与附件卷的一致性存储快照。

### 停服后的卷备份示例

先停掉写入服务，再保留 PostgreSQL 容器以便通过其本地 socket/网络导出：

```bash
docker compose --env-file server/.env \
  -f server/compose.yaml stop requirements-service
docker compose --env-file server/.env \
  -f server/compose.yaml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > requirements-service.pg.dump
docker run --rm \
  -v suduo-requirements-service_requirements_attachments:/data:ro \
  -v "$PWD":/backup alpine:3.21 \
  tar -C /data -czf /backup/requirements-service-attachments.tar.gz .
```

将示例中的附件卷名替换为 `config --volumes` 输出的实际名称。

### 恢复示例

恢复应在服务保持停止时进行，目标 PostgreSQL 和附件卷必须为空或已按发布流程替换：

```bash
docker compose --env-file server/.env \
  -f server/compose.yaml stop requirements-service
docker compose --env-file server/.env \
  -f server/compose.yaml exec -T postgres \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < requirements-service.pg.dump
docker run --rm \
  -v suduo-requirements-service_requirements_attachments:/data \
  -v "$PWD":/backup alpine:3.21 \
  tar -C /data -xzf /backup/requirements-service-attachments.tar.gz
docker compose --env-file server/.env \
  -f server/compose.yaml start requirements-service
```

恢复后重新执行 `/v2/health` 并抽样下载附件，确认 PostgreSQL 元数据与附件卷对象一致。
