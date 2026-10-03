// @vitest-environment jsdom

import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markRequestNetworkFailure,
  markRequestReachedServer,
  resetConnectivityForTest,
} from "../src/api/connectivity.js";
import { createQueryClient } from "../src/app/queries.js";
import { ConnectionBanner } from "../src/app/shell/ConnectionBanner.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  resetConnectivityForTest();
  vi.useRealTimers();
});

describe("断线横幅", () => {
  it("断开时持续显示，恢复后提示「已恢复」并在 2 秒后消失", async () => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <QueryClientProvider client={createQueryClient()}>
          <ConnectionBanner />
        </QueryClientProvider>,
      ),
    );
    expect(container.querySelector('[data-testid="connection-banner"]')).toBeNull();

    await act(async () => markRequestNetworkFailure(new TypeError("Failed to fetch")));
    expect(container.textContent).toContain("连接已断开");

    await act(async () => markRequestReachedServer());
    expect(container.textContent).toContain("连接已恢复");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(container.querySelector('[data-testid="connection-banner"]')).toBeNull();
  });

  it("主动取消的请求不算断线", async () => {
    markRequestNetworkFailure(new DOMException("aborted", "AbortError"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <QueryClientProvider client={createQueryClient()}>
          <ConnectionBanner />
        </QueryClientProvider>,
      ),
    );
    expect(container.querySelector('[data-testid="connection-banner"]')).toBeNull();
  });
});
