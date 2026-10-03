import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@suduo/client-contracts";
import {
  StdioCodexTransport,
  initializeCodexConnection,
} from "../src/infrastructure/transport/stdio-codex-transport.js";

const workspaceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const codexBin = resolve(
  workspaceRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "codex.cmd" : "codex",
);
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex Config RPC · 隔离真实配置夹具", () => {
  it.runIf(existsSync(codexBin))(
    "在嵌套 model_providers 配置上逐字段 batchWrite 并读回",
    async () => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "suduo-config-rpc-"));
      fixtureRoots.push(fixtureRoot);
      const codexHome = join(fixtureRoot, "codex-home");
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        join(codexHome, "config.toml"),
        `model_provider = "myapi"
model = "gpt-5.5"
model_reasoning_effort = "high"
model_context_window = 400000

[model_providers.myapi]
name = "My API"
base_url = "https://old.example.com/v1"
wire_api = "responses"
`,
        "utf8",
      );
      const transport = new StdioCodexTransport();
      const controller = new AbortController();
      const connection = await transport.connect({
        codexBin,
        env: isolatedEnvironment(codexHome),
        signal: controller.signal,
      });
      try {
        await initializeCodexConnection(connection, { signal: controller.signal });
        const before = asObject(
          await connection.request(
            "config/read",
            { includeLayers: true },
            { timeoutMs: 20_000, signal: controller.signal },
          ),
        );
        const userLayer = requireUserLayer(before["layers"]);
        const written = asObject(
          await connection.request(
            "config/batchWrite",
            {
              expectedVersion: userLayer.version,
              reloadUserConfig: true,
              edits: [
                {
                  keyPath: "model_providers.myapi.base_url",
                  mergeStrategy: "upsert",
                  value: "https://new.example.com/v1",
                },
                { keyPath: "model", mergeStrategy: "upsert", value: "gpt-5.6-sol" },
                {
                  keyPath: "model_reasoning_effort",
                  mergeStrategy: "upsert",
                  value: "medium",
                },
                {
                  keyPath: "model_context_window",
                  mergeStrategy: "upsert",
                  value: 1_000_000,
                },
              ],
            },
            { timeoutMs: 20_000, signal: controller.signal },
          ),
        );
        expect(written["status"]).toBe("ok");

        const after = asObject(
          await connection.request(
            "config/read",
            { includeLayers: true },
            { timeoutMs: 20_000, signal: controller.signal },
          ),
        );
        const config = asObject(after["config"]);
        const providers = asObject(config["model_providers"]);
        const provider = asObject(providers["myapi"]);
        expect({
          providerId: config["model_provider"],
          baseUrl: provider["base_url"],
          model: config["model"],
          reasoningEffort: config["model_reasoning_effort"],
          contextWindow: config["model_context_window"],
        }).toEqual({
          providerId: "myapi",
          baseUrl: "https://new.example.com/v1",
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          contextWindow: 1_000_000,
        });
      } finally {
        controller.abort();
        await connection.close("fixture complete");
      }
    },
  );
});

describe("Codex Config RPC · 第一次改用团队模型服务（逐字段写、逐字段还原）", () => {
  const createEdits = (baseUrl: string) => [
    {
      keyPath: "model_providers.suduo",
      mergeStrategy: "upsert",
      value: { name: "SuDuo 模型服务", base_url: baseUrl, wire_api: "responses" },
    },
    { keyPath: "model_provider", mergeStrategy: "upsert", value: "suduo" },
  ];
  const updateEdits = (baseUrl: string) => [
    { keyPath: "model_providers.suduo.base_url", mergeStrategy: "upsert", value: baseUrl },
    { keyPath: "model_provider", mergeStrategy: "upsert", value: "suduo" },
  ];

  async function withCodex(initialToml: string, run: (request: (method: string, params: Record<string, JsonValue>) => Promise<JsonValue>) => Promise<void>) {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "suduo-config-rpc-first-"));
    fixtureRoots.push(fixtureRoot);
    const codexHome = join(fixtureRoot, "codex-home");
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), initialToml, "utf8");
    const transport = new StdioCodexTransport();
    const controller = new AbortController();
    const connection = await transport.connect({ codexBin, env: isolatedEnvironment(codexHome), signal: controller.signal });
    try {
      await initializeCodexConnection(connection, { signal: controller.signal });
      await run((method, params) => connection.request(method, params, { timeoutMs: 20_000, signal: controller.signal }));
    } finally {
      controller.abort();
      await connection.close("fixture complete");
    }
  }

  const userLayer = (read: JsonValue) => {
    const layers = asObject(read)["layers"];
    if (!Array.isArray(layers)) throw new Error("没有 layers");
    const user = layers.map((layer) => asObject(layer)).find((layer) => asObject(layer["name"])["type"] === "user");
    if (user === undefined) throw new Error("没有 user layer");
    return { version: String(user["version"]), config: asObject(user["config"] ?? {}) };
  };

  it.runIf(existsSync(codexBin))("空配置：整表建立提供方并设为当前；整表写 null 即还原成空", async () => {
    await withCodex("", async (request) => {
      const before = userLayer(await request("config/read", { includeLayers: true }));
      const written = asObject(
        await request("config/batchWrite", { expectedVersion: before.version, reloadUserConfig: true, edits: createEdits("https://gateway.example.com/v1") }),
      );
      expect(written["status"]).toBe("ok");
      const after = userLayer(await request("config/read", { includeLayers: true }));
      expect(after.config["model_provider"]).toBe("suduo");
      expect(asObject(asObject(after.config["model_providers"])["suduo"])).toMatchObject({
        name: "SuDuo 模型服务",
        base_url: "https://gateway.example.com/v1",
        wire_api: "responses",
      });
      await request("config/batchWrite", {
        expectedVersion: String(written["version"]),
        reloadUserConfig: true,
        edits: [
          { keyPath: "model_providers.suduo", mergeStrategy: "upsert", value: null },
          { keyPath: "model_provider", mergeStrategy: "upsert", value: null },
        ],
      });
      const restored = userLayer(await request("config/read", { includeLayers: true })).config;
      expect(restored["model_provider"] ?? null).toBeNull();
      const providers = restored["model_providers"];
      const table = providers === undefined || providers === null ? null : (asObject(providers)["suduo"] ?? null);
      expect(table === null || Object.keys(asObject(table)).length === 0).toBe(true);
    });
  });

  it.runIf(existsSync(codexBin))("用户文件里已有 suduo 表：只改地址与当前指向，用户的字段不动；按改前值写回即原样", async () => {
    await withCodex(
      `[model_providers.suduo]
name = "我自己的网关"
base_url = "https://mine.example.com/v1"
wire_api = "responses"
env_key = "MY_KEY"
http_headers = { "X-Team" = "a" }
`,
      async (request) => {
        const before = userLayer(await request("config/read", { includeLayers: true }));
        const written = asObject(
          await request("config/batchWrite", { expectedVersion: before.version, reloadUserConfig: true, edits: updateEdits("https://gateway.example.com/v1") }),
        );
        expect(written["status"]).toBe("ok");
        const changed = asObject(asObject(userLayer(await request("config/read", { includeLayers: true })).config["model_providers"])["suduo"]);
        expect(changed).toMatchObject({ name: "我自己的网关", base_url: "https://gateway.example.com/v1", wire_api: "responses", env_key: "MY_KEY" });

        const rolledBack = asObject(
          await request("config/batchWrite", {
            expectedVersion: String(written["version"]),
            reloadUserConfig: true,
            edits: [
              { keyPath: "model_providers.suduo.base_url", mergeStrategy: "upsert", value: "https://mine.example.com/v1" },
              { keyPath: "model_provider", mergeStrategy: "upsert", value: null },
            ],
          }),
        );
        expect(rolledBack["status"]).toBe("ok");
        const restored = userLayer(await request("config/read", { includeLayers: true })).config;
        expect(restored["model_provider"] ?? null).toBeNull();
        expect(asObject(asObject(restored["model_providers"])["suduo"])).toEqual(asObject(asObject(before.config["model_providers"])["suduo"]));
      },
    );
  });
});

function isolatedEnvironment(codexHome: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env["OPENAI_API_KEY"];
  delete env["CODEX_ACCESS_TOKEN"];
  env["CODEX_HOME"] = codexHome;
  return env;
}

function requireUserLayer(value: JsonValue | undefined): { version: string } {
  if (!Array.isArray(value)) {
    throw new Error("config/read 没有返回 layers");
  }
  for (const layer of value) {
    const item = asObject(layer);
    const source = asObject(item["name"]);
    if (source["type"] === "user" && typeof item["version"] === "string") {
      return { version: item["version"] };
    }
  }
  throw new Error("config/read 没有可写 user layer");
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected JSON object");
  }
  return value;
}
