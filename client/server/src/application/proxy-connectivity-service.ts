import { lookup } from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import type { ProxyConnectivityDto } from "@suduo/client-contracts";
import type { ProxySettings } from "./proxy-settings.js";
import type { SettingsService } from "./settings-service.js";

const REQUEST_TIMEOUT_MS = 10_000;

export interface ModelGatewayBaseUrlProvider {
  modelGatewayBaseUrl(): Promise<string>;
}

export type ProxyConnectivityResult = ProxyConnectivityDto;

export type ModelGatewayProbe = (
  baseUrl: string,
  proxy: ProxySettings,
) => Promise<ProxyConnectivityResult>;

/**
 * 模型网关连通性检查。请求不会保存草稿代理，也不会发送模型回合；/models 的
 * 任意 HTTP 响应都证明 DNS、代理和网关路径可达（401 同样是可达）。
 */
export class ProxyConnectivityService {
  constructor(
    private readonly settings: SettingsService,
    private readonly modelGateway: ModelGatewayBaseUrlProvider,
    private readonly probe: ModelGatewayProbe = probeModelGateway,
  ) {}

  async test(input: Record<string, unknown>): Promise<ProxyConnectivityResult> {
    const proxy = inheritUnsetProxySettings(this.settings.proxySettings(input));
    return await this.probe(await this.modelGateway.modelGatewayBaseUrl(), proxy);
  }
}

/** 空设置代表不覆盖服务进程环境；自检也应按同一继承规则发起请求。 */
function inheritUnsetProxySettings(settings: ProxySettings): ProxySettings {
  return {
    httpProxy: settings.httpProxy || process.env["HTTP_PROXY"] || process.env["http_proxy"] || "",
    httpsProxy:
      settings.httpsProxy || process.env["HTTPS_PROXY"] || process.env["https_proxy"] || "",
    allProxy: settings.allProxy || process.env["ALL_PROXY"] || process.env["all_proxy"] || "",
    noProxy: settings.noProxy || process.env["NO_PROXY"] || process.env["no_proxy"] || "",
  };
}

export async function probeModelGateway(
  baseUrl: string,
  proxySettings: ProxySettings,
): Promise<ProxyConnectivityResult> {
  let target: URL;
  try {
    target = modelListUrl(baseUrl);
  } catch {
    return {
      reachable: false,
      targetOrigin: "",
      usingProxy: false,
      message: "当前模型网关地址无效，无法进行连通性检查",
      failure: { reason: "invalid-base-url" },
    };
  }
  let proxy: URL | null;
  try {
    proxy = selectProxy(target, proxySettings);
  } catch {
    return {
      reachable: false,
      targetOrigin: target.origin,
      usingProxy: false,
      message: "当前代理环境变量无效，无法进行连通性检查",
      failure: { reason: "invalid-proxy" },
    };
  }
  try {
    const statusCode = await requestModelList(target, proxy);
    return {
      reachable: true,
      targetOrigin: target.origin,
      statusCode,
      usingProxy: proxy !== null,
      message:
        "已到达模型网关（HTTP " +
        String(statusCode) +
        "；401/403 仅表示网关仍需 Codex 凭据）",
    };
  } catch (error) {
    return {
      reachable: false,
      targetOrigin: target.origin,
      usingProxy: proxy !== null,
      message: "无法连接模型网关：" + readableNetworkError(error),
      failure: { reason: "unreachable", networkCode: networkErrorCode(error) },
    };
  }
}

function modelListUrl(baseUrl: string): URL {
  const normalized = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const target = new URL("models", normalized);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("unsupported model gateway protocol");
  }
  return target;
}

function selectProxy(target: URL, settings: ProxySettings): URL | null {
  if (isNoProxyTarget(target, settings.noProxy)) {
    return null;
  }
  const raw =
    target.protocol === "https:"
      ? settings.httpsProxy || settings.allProxy
      : settings.httpProxy || settings.allProxy;
  return raw === "" ? null : new URL(raw);
}

function isNoProxyTarget(target: URL, noProxy: string): boolean {
  const host = target.hostname.toLowerCase();
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  return noProxy.split(",").some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === "") return false;
    if (entry === "*") return true;
    const [entryHost, entryPort] = entry.startsWith("[")
      ? splitIpv6NoProxyEntry(entry)
      : splitHostPort(entry);
    if (entryPort !== null && entryPort !== port) return false;
    const normalized = entryHost.startsWith(".") ? entryHost.slice(1) : entryHost;
    return host === normalized || host.endsWith("." + normalized);
  });
}

function splitHostPort(entry: string): [string, string | null] {
  const match = /^(.*):(\d+)$/u.exec(entry);
  return match ? [match[1]!, match[2]!] : [entry, null];
}

function splitIpv6NoProxyEntry(entry: string): [string, string | null] {
  const match = /^(\[[^\]]+\])(?::(\d+))?$/u.exec(entry);
  return match ? [match[1]!.slice(1, -1), match[2] ?? null] : [entry, null];
}

async function requestModelList(target: URL, proxy: URL | null): Promise<number> {
  if (proxy === null) {
    return await requestOverSocket(
      target,
      await connectTarget(target),
      target.pathname + target.search,
    );
  }
  if (proxy.protocol === "http:" || proxy.protocol === "https:") {
    if (target.protocol === "http:") {
      return await requestOverSocket(target, await connectSocket(proxy), target.toString());
    }
    const socket = await connectHttpTunnel(target, proxy);
    return await requestOverSocket(target, socket, target.pathname + target.search);
  }
  const socket = await connectSocksTunnel(target, proxy);
  return await requestOverSocket(target, socket, target.pathname + target.search);
}

async function requestOverSocket(
  target: URL,
  socket: net.Socket,
  requestTarget: string,
): Promise<number> {
  const reader = new BufferedSocket(socket);
  try {
    socket.write(
      "GET " +
        requestTarget +
        " HTTP/1.1\r\nHost: " +
        target.host +
        "\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
    );
    const header = (await reader.readUntil("\r\n\r\n", 16_384)).toString("ascii");
    const match = /^HTTP\/1\.[01] (\d{3})\b/u.exec(header);
    if (!match) throw new Error("模型网关返回无效 HTTP 响应");
    return Number(match[1]);
  } finally {
    reader.release();
    socket.destroy();
  }
}

async function connectHttpTunnel(target: URL, proxy: URL): Promise<net.Socket> {
  const socket = await connectSocket(proxy);
  const reader = new BufferedSocket(socket);
  try {
    socket.write(
      "CONNECT " + target.hostname + ":" + targetPort(target) + " HTTP/1.1\r\n" +
        "Host: " + target.hostname + ":" + targetPort(target) + "\r\n\r\n",
    );
    const header = (await reader.readUntil("\r\n\r\n", 16_384)).toString("ascii");
    if (!/^HTTP\/1\.[01] 2\d\d\b/u.test(header)) {
      throw new Error("代理拒绝 CONNECT 隧道");
    }
    return await upgradeForTarget(target, socket, reader.release());
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function connectSocksTunnel(target: URL, proxy: URL): Promise<net.Socket> {
  const socket = await connectSocket(proxy);
  const reader = new BufferedSocket(socket);
  try {
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    const greeting = await reader.read(2);
    if (greeting[0] !== 0x05 || greeting[1] !== 0x00) {
      throw new Error("SOCKS 代理不支持无鉴权连接");
    }
    const address = await socksTargetAddress(target, proxy.protocol === "socks5h:");
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), address, socksPort(target)]));
    const response = await reader.read(4);
    if (response[0] !== 0x05 || response[1] !== 0x00) {
      throw new Error("SOCKS 代理拒绝连接模型网关");
    }
    const addressLength = response[3] === 0x01 ? 4 : response[3] === 0x04 ? 16 : null;
    if (addressLength === null) {
      const domainLength = (await reader.read(1))[0]!;
      await reader.read(domainLength + 2);
    } else {
      await reader.read(addressLength + 2);
    }
    return await upgradeForTarget(target, socket, reader.release());
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function connectSocket(proxy: URL): Promise<net.Socket> {
  const port = Number(proxy.port || (proxy.protocol === "https:" ? "443" : "1080"));
  const socket =
    proxy.protocol === "https:"
      ? tls.connect({ host: proxy.hostname, port, servername: proxy.hostname })
      : net.connect({ host: proxy.hostname, port });
  await onceConnected(socket);
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy(new Error("代理连接超时")));
  return socket;
}

async function connectTarget(target: URL): Promise<net.Socket> {
  const port = targetPort(target);
  const socket =
    target.protocol === "https:"
      ? tls.connect({ host: target.hostname, port, servername: target.hostname })
      : net.connect({ host: target.hostname, port });
  await onceConnected(socket);
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy(new Error("模型网关连接超时")));
  return socket;
}

async function upgradeForTarget(
  target: URL,
  socket: net.Socket,
  remaining: Buffer,
): Promise<net.Socket> {
  if (remaining.length > 0) socket.unshift(remaining);
  if (target.protocol === "http:") return socket;
  const secure = tls.connect({ socket, servername: target.hostname });
  await onceConnected(secure);
  return secure;
}

async function socksTargetAddress(target: URL, remoteDns: boolean): Promise<Buffer> {
  const hostname = target.hostname;
  if (remoteDns) {
    const encoded = Buffer.from(hostname, "utf8");
    if (encoded.length > 255) throw new Error("模型网关主机名过长");
    return Buffer.concat([Buffer.from([0x03, encoded.length]), encoded]);
  }
  const resolved = await lookup(hostname);
  if (net.isIPv4(resolved.address)) {
    return Buffer.from([0x01, ...resolved.address.split(".").map(Number)]);
  }
  const segments = resolved.address.split(":");
  const expanded = expandIpv6(segments);
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(expanded.flatMap((part) => [part >> 8, part & 0xff]))]);
}

function expandIpv6(segments: string[]): number[] {
  const blank = segments.indexOf("");
  const compact = segments.filter((segment) => segment !== "").map((segment) => Number.parseInt(segment, 16));
  if (blank < 0) return compact;
  return [...compact.slice(0, blank), ...Array(8 - compact.length).fill(0), ...compact.slice(blank)];
}

function socksPort(target: URL): Buffer {
  const port = targetPort(target);
  return Buffer.from([port >> 8, port & 0xff]);
}

function targetPort(target: URL): number {
  return Number(target.port || (target.protocol === "https:" ? "443" : "80"));
}

function onceConnected(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onConnect = () => cleanup(resolve);
    const onError = (error: Error) => cleanup(() => reject(error));
    const cleanup = (done: () => void) => {
      socket.off("connect", onConnect);
      socket.off("secureConnect", onConnect);
      socket.off("error", onError);
      done();
    };
    socket.once(socket instanceof tls.TLSSocket ? "secureConnect" : "connect", onConnect);
    socket.once("error", onError);
  });
}

class BufferedSocket {
  private buffer = Buffer.alloc(0);
  private error: Error | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly socket: net.Socket) {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("end", this.onEnd);
  }

  async read(size: number): Promise<Buffer> {
    while (this.buffer.length < size) await this.waitForData();
    const result = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return result;
  }

  async readUntil(marker: string, maxBytes: number): Promise<Buffer> {
    const markerBytes = Buffer.from(marker, "ascii");
    for (;;) {
      const index = this.buffer.indexOf(markerBytes);
      if (index >= 0) return await this.read(index + markerBytes.length);
      if (this.buffer.length > maxBytes) throw new Error("代理响应头过长");
      await this.waitForData();
    }
  }

  release(): Buffer {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("end", this.onEnd);
    const remaining = this.buffer;
    this.buffer = Buffer.alloc(0);
    return remaining;
  }

  private readonly onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.wake?.();
    this.wake = null;
  };

  private readonly onError = (error: Error) => {
    this.error = error;
    this.wake?.();
    this.wake = null;
  };

  private readonly onEnd = () => {
    this.error = new Error("代理提前关闭连接");
    this.wake?.();
    this.wake = null;
  };

  private async waitForData(): Promise<void> {
    if (this.error) throw this.error;
    await new Promise<void>((resolve) => {
      this.wake = resolve;
    });
    if (this.error) throw this.error;
  }
}

function readableNetworkError(error: unknown): string {
  return networkErrorCode(error) ?? "连接失败";
}

/** 网络错误码（ECONNREFUSED 之类）；没有错误码时为 null。 */
function networkErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return null;
}
