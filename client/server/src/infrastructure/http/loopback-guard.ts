import type { FastifyRequest } from "fastify";
import { ApiError } from "../../application/api-error.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** SuDuo 不提供登录机制；只接受 loopback Host，并拒绝浏览器跨源写请求。 */
export class LoopbackGuard {
  guard(request: FastifyRequest): void {
    assertLoopbackHost(request.headers.host);
    if (WRITE_METHODS.has(request.method)) {
      assertSameLoopbackOrigin(request.headers.origin, request.headers.host);
    }
  }
}

function assertLoopbackHost(host: string | undefined): void {
  if (!host) {
    throw new ApiError(403, "ORIGIN_REJECTED", (t) => t.http.hostMissing);
  }
  let hostname: string;
  try {
    hostname = new URL("http://" + host).hostname;
  } catch (error) {
    throw new ApiError(403, "ORIGIN_REJECTED", (t) => t.http.hostInvalid, undefined, {
      cause: error,
    });
  }
  if (!isLoopback(hostname)) {
    throw new ApiError(403, "ORIGIN_REJECTED", (t) => t.http.hostNotLoopback);
  }
}

function assertSameLoopbackOrigin(
  origin: string | undefined,
  host: string | undefined,
): void {
  if (!origin || origin === "null" || !host) {
    throw new ApiError(403, "ORIGIN_REJECTED", (t) => t.http.originRequired);
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch (error) {
    throw new ApiError(403, "ORIGIN_REJECTED", (t) => t.http.originInvalid, undefined, {
      cause: error,
    });
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !isLoopback(url.hostname) ||
    url.host !== host
  ) {
    throw new ApiError(403, "ORIGIN_REJECTED", (t) => t.http.originMismatch);
  }
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}
