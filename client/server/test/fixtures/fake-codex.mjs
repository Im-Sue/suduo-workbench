import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(
      JSON.stringify({
        id: message.id,
        result: {
          userAgent: "fake-codex",
        },
      }) + "\n",
    );
    return;
  }

  if (message.method === "initialized" && message.id === undefined) {
    process.stdout.write(
      JSON.stringify({
        method: "thread/started",
        params: {
          thread: {
            id: "fake-thread",
          },
        },
      }) + "\n",
    );
    return;
  }

  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: message.params ?? null,
    }) + "\n",
  );
});
