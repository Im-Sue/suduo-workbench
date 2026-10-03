// SuDuo 云端冒烟检查：只给部署验收与 CI 用，会在目标服务上创建一个测试账号和一批测试数据，不要对生产环境运行。
//
// 在服务容器里运行（容器自带 Node，宿主机不需要额外工具）：
//   docker compose --env-file server/.env -f server/compose.yaml exec -T requirements-service \
//     node --input-type=module - seed < scripts/smoke.mjs > smoke-state.json
//   docker compose ... exec -T -e SMOKE_STATE="$(cat smoke-state.json)" requirements-service \
//     node --input-type=module - verify < scripts/smoke.mjs
//
// seed：注册账号 → 建项目 → 建需求 → 评论 → 上传附件 → 建需求房间 → 上传房间文件，输出状态 JSON。
// verify：用 seed 的账号重新登录，确认需求、评论都在，附件与房间文件下载后逐字节一致（备份恢复后用）。
import { createHash, randomBytes, randomUUID } from "node:crypto";

const base = process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${process.env.REQUIREMENTS_PORT ?? "4100"}`;
const mode = process.argv[2];

async function call(method, path, { token, json, body, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(json === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: json === undefined ? body : JSON.stringify(json),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} → HTTP ${response.status}: ${await response.text()}`);
  }
  return response;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function upload(path, token, fileName, bytes, headers = {}) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/octet-stream" }), fileName);
  return (await call("POST", path, { token, body: form, headers })).json();
}

async function seed() {
  const loginName = `smoke-${Date.now().toString(36)}`;
  const password = randomBytes(12).toString("hex");
  const session = await (await call("POST", "/v2/auth/register", {
    json: { loginName, displayName: "Smoke Test", password },
  })).json();
  const token = session.accessToken;
  const project = await (await call("POST", "/v2/projects", { token, json: { name: `Smoke ${loginName}` } })).json();
  const requirement = await (await call("POST", `/v2/projects/${project.id}/requirements`, {
    token,
    json: { title: "Smoke requirement", summary: "Created by scripts/smoke.mjs" },
  })).json();
  await call("POST", `/v2/requirements/${requirement.id}/comments`, { token, json: { body: "Smoke comment" } });

  const attachmentBytes = randomBytes(256 * 1024);
  const attachment = await upload(`/v2/requirements/${requirement.id}/attachments`, token, "smoke.txt", attachmentBytes, {
    "idempotency-key": randomUUID(),
  });

  const room = await (await call("POST", `/v2/requirements/${requirement.id}/rooms`, { token, json: {} })).json();
  const roomFileBytes = randomBytes(128 * 1024);
  const roomFile = await upload(`/v2/rooms/${room.id}/files`, token, "smoke-room.txt", roomFileBytes);

  return {
    loginName,
    password,
    projectId: project.id,
    requirementId: requirement.id,
    attachmentId: attachment.attachment.id,
    attachmentSha256: sha256(attachmentBytes),
    roomFileId: roomFile.id,
    roomFileSha256: sha256(roomFileBytes),
  };
}

async function verify(state) {
  const session = await (await call("POST", "/v2/auth/login", {
    json: { loginName: state.loginName, password: state.password },
  })).json();
  const token = session.accessToken;
  const requirement = await (await call("GET", `/v2/requirements/${state.requirementId}`, { token })).json();
  if (requirement.title !== "Smoke requirement") throw new Error("requirement title mismatch");
  const comments = await (await call("GET", `/v2/requirements/${state.requirementId}/comments`, { token })).json();
  const commentBodies = (comments.items ?? comments).map((comment) => comment.body);
  if (!commentBodies.includes("Smoke comment")) throw new Error("comment missing");

  const attachment = new Uint8Array(await (await call("GET", `/v2/attachments/${state.attachmentId}/content`, { token })).arrayBuffer());
  if (sha256(attachment) !== state.attachmentSha256) throw new Error("attachment content mismatch");
  const roomFile = new Uint8Array(await (await call("GET", `/v2/room-files/${state.roomFileId}/content`, { token })).arrayBuffer());
  if (sha256(roomFile) !== state.roomFileSha256) throw new Error("room file content mismatch");
  return { ok: true, requirement: requirement.title, comments: commentBodies.length, attachmentBytes: attachment.length, roomFileBytes: roomFile.length };
}

try {
  if (mode === "seed") {
    process.stdout.write(JSON.stringify(await seed()) + "\n");
  } else if (mode === "verify") {
    const state = JSON.parse(process.env.SMOKE_STATE ?? "");
    process.stdout.write(JSON.stringify(await verify(state)) + "\n");
  } else {
    throw new Error("usage: node --input-type=module - seed|verify < scripts/smoke.mjs");
  }
} catch (error) {
  process.stderr.write(`smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
