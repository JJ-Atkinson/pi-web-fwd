import type { Server } from "node:http";

export type HubAddress = {
  host: string;
  port: number;
};

const DEFAULT_HUB_HOST = "127.0.0.1";
const DEFAULT_HUB_PORT = 30142;

export function parseHubAddress(value?: string): HubAddress {
  const input = value?.trim();
  if (!input) return { host: DEFAULT_HUB_HOST, port: DEFAULT_HUB_PORT };
  let url: URL;
  try {
    url = new URL(input.includes("://") ? input : `http://${input}`);
  } catch {
    throw new Error(`Invalid PI_FWD_HUB_ADDR: ${input}`);
  }
  const port = url.port ? Number(url.port) : DEFAULT_HUB_PORT;
  if (
    url.protocol !== "http:" ||
    !url.hostname ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(`Invalid PI_FWD_HUB_ADDR: ${input}`);
  }
  return { host: url.hostname, port };
}

export function hubClientUrl(address: HubAddress): string {
  const host = address.host === "0.0.0.0"
    ? "127.0.0.1"
    : address.host === "::"
      ? "::1"
      : address.host;
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `http://${bracketed}:${address.port}`;
}

export function parseAgentSeriesStart(value?: string): number | undefined {
  if (value == null || !value.trim()) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PI_FWD_AGENT_SERIES_START: ${value}`);
  }
  return port;
}

function listenOnce(
  server: Server,
  host: string,
  port: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Server did not expose a TCP address"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function listenOnAgentPort(
  server: Server,
  host: string,
  seriesStart?: number,
): Promise<number> {
  if (seriesStart === undefined) return listenOnce(server, host, 0);
  for (let port = seriesStart; port <= 65535; port++) {
    try {
      return await listenOnce(server, host, port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
      throw error;
    }
  }
  throw new Error(`No free agent port at or above ${seriesStart}`);
}
