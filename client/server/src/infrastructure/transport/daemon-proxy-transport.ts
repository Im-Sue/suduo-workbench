import type { CodexTransportFactory, RpcConnection } from "@suduo/client-contracts";

export class DaemonProxyTransportUnavailableError extends Error {
  constructor() {
    super(
      "daemon-proxy transport is reserved for M2 and is not available in M1",
    );
    this.name = "DaemonProxyTransportUnavailableError";
  }
}

export class DaemonProxyCodexTransport implements CodexTransportFactory {
  readonly kind = "daemon-proxy" as const;

  async connect(options: {
    codexBin: string;
    env: Record<string, string>;
    signal: AbortSignal;
  }): Promise<RpcConnection> {
    void options;
    throw new DaemonProxyTransportUnavailableError();
  }
}
