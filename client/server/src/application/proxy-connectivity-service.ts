import { lookup } from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import type { Locale, ProxyConnectivityDto } from "@suduo/client-contracts";
import { messagesFor, type ServerMessages } from "../i18n/messages/index.js";
import type { ProxySettings } from "./proxy-settings.js";
import type { SettingsService } from "./settings-service.js";

const REQUEST_TIMEOUT_MS = 10_000;

export interface ModelGatewayBaseUrlProvider {
  modelGatewayBaseUrl(): Promise<string>;
}

export type ProxyConnectivityResult = ProxyConnectivityDto;

/** t：结果说明（message）用的字典，按请求语言。 */
export type ModelGatewayProbe = (
  baseUrl: string,
  proxy: ProxySettings,
  t: ServerMessages,
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

  async test(input: Record<string, unknown>, locale: Locale): Promise<ProxyConnectivityResult> {
    const proxy = inheritUnsetProxySettings(this.settings.proxySettings(input));
    return await this.probe(await this.modelGateway.modelGatewayBaseUrl(), proxy, messagesFor(locale));
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
  t: ServerMessages,
): Promise<ProxyConnectivityResult> {
  const text = t.config.connectivity;
  let target: URL;
  try {
    target = modelListUrl(baseUrl);
  } catch {
    return {
      reachable: false,
      targetOrigin: "",
      usingProxy: false,
      message: text.invalidBaseUrl,
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
      message: text.invalidProxy,
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
      message: text.reached(statusCode),
    };
  } catch (error) {
    return {
      reachable: false,
      targetOrigin: target.origin,
      usingProxy: proxy !== null,
      message: text.unreachable(networkErrorCode(error) ?? text.connectionFailed),
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

/**
 * 下面各步抛出的 Error 只用来中断这次试连：probeModelGateway 接住后只取错误码（networkErrorCode），
 * 说明文字不会进响应，所以直接写英文。
 */
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
    if (!match) throw new Error("model gateway returned an invalid HTTP response");
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
      throw new Error("proxy refused the CONNECT tunnel");
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
      throw new Error("SOCKS proxy does not allow unauthenticated connections");
    }
    const address = await socksTargetAddress(target, proxy.protocol === "socks5h:");
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), address, socksPort(target)]));
    const response = await reader.read(4);
    if (response[0] !== 0x05 || response[1] !== 0x00) {
      throw new Error("SOCKS proxy refused to connect to the model gateway");
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
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy(new Error("proxy connection timed out")));
  return socket;
}

async function connectTarget(target: URL): Promise<net.Socket> {
  const port = targetPort(target);
  const socket =
    target.protocol === "https:"
      ? tls.connect({ host: target.hostname, port, servername: target.hostname })
      : net.connect({ host: target.hostname, port });
  await onceConnected(socket);
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy(new Error("model gateway connection timed out")));
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
    if (encoded.length > 255) throw new Error("model gateway hostname is too long");
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
      if (this.buffer.length > maxBytes) throw new Error("proxy response header is too long");
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
    this.error = new Error("proxy closed the connection early");
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

/** 网络错误码（ECONNREFUSED 之类）；没有错误码时为 null。 */
function networkErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return null;
}
