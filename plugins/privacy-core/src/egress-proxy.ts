// Allowlisting forward proxy for a private gateway.
//
// The private gateway's config sets `proxy.proxyUrl` to this proxy, so OpenClaw
// routes every outbound HTTP, HTTPS and WebSocket connection of the gateway
// process (and the proxy env of its child processes) through it. Only HTTPS
// CONNECT tunnels to allowlisted hosts on port 443 are opened (and port 993,
// IMAP over TLS, to the connected mail provider), and only to public addresses. Everything else gets 403 and an audit row. If privacy-core
// is not running, the proxy is absent and the gateway reaches nothing outside
// the machine: the failure mode is closed.
//
// Plain-HTTP forwarding is deliberately absent. OpenClaw's process routing
// would send the proxy's own upstream HTTP requests back into the proxy.
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { isHostAllowed, normalizeHost } from "../../../shared/hosts.js";
import { markServiceDown, markServiceUp } from "../../../shared/rules/service-registry.js";

const TUNNEL_PORT = 443;
const IMAPS_PORT = 993;
const REFUSAL_LOG_INTERVAL_MS = 60_000;
const REFUSAL_LOG_MAX_HOSTS = 1_000;
const CONNECT_TIMEOUT_MS = 15_000;
/** Model streams can sit quiet while the model thinks; close only truly dead tunnels. */
const TUNNEL_IDLE_TIMEOUT_MS = 10 * 60_000;

export type EgressRefusal = "not_allowlisted" | "private_address" | "config_unsafe" | "not_https";

export type EgressProxyOptions = {
  allow: () => readonly string[];
  /** Hosts that may also be reached on port 993 (the connected mail provider's IMAP server). */
  allowImap?: () => readonly string[];
  port: number;
  /** A message means "refuse every connection" (privacy config unsafe). */
  guard?: () => string | undefined;
  onRefused?: (host: string, reason: EgressRefusal) => void;
  /** Test seams. */
  resolve?: (host: string) => Promise<string[]>;
  connect?: (port: number, address: string) => net.Socket;
};

export type EgressProxy = {
  start(): Promise<string>;
  stop(): Promise<void>;
};

function splitHostPort(authority: string): { host: string; port: number } | null {
  const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/u.exec(authority.trim());
  if (!match) {
    return null;
  }
  return { host: normalizeHost(match[1] ?? ""), port: Number(match[2]) };
}

/** Loopback, private, link-local, CGNAT, multicast and unspecified addresses. */
export function isNonPublicAddress(address: string): boolean {
  const ip = normalizeHost(address);
  if (net.isIPv4(ip)) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower.startsWith("::ffff:")) {
      return isNonPublicAddress(lower.slice(7));
    }
    return (
      lower === "::" ||
      lower === "::1" ||
      /^f[cd]/u.test(lower) ||
      /^fe[89ab]/u.test(lower) ||
      lower.startsWith("ff")
    );
  }
  return true;
}

async function defaultResolve(host: string): Promise<string[]> {
  if (net.isIP(host)) {
    return [host];
  }
  const records = await dnsLookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export function createEgressProxy(options: EgressProxyOptions): EgressProxy {
  const resolve = options.resolve ?? defaultResolve;
  const connect = options.connect ?? ((port, address) => net.connect(port, address));
  const lastRefusal = new Map<string, number>();
  const sockets = new Set<net.Socket>();
  let server: http.Server | undefined;

  const refuse = (client: net.Socket, host: string, reason: EgressRefusal, status = 403) => {
    const key = `${reason}:${host}`;
    const now = Date.now();
    if ((lastRefusal.get(key) ?? 0) + REFUSAL_LOG_INTERVAL_MS <= now) {
      if (lastRefusal.size >= REFUSAL_LOG_MAX_HOSTS) {
        lastRefusal.clear();
      }
      lastRefusal.set(key, now);
      options.onRefused?.(host, reason);
    }
    const text = status === 403 ? "Forbidden" : "Bad Gateway";
    client.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  };

  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    let host = "";
    try {
      host = normalizeHost(new URL(req.url ?? "").hostname);
    } catch {
      // Not an absolute-form proxy request; report it under an empty host.
    }
    options.onRefused?.(host || "(invalid request)", "not_https");
    res.writeHead(403, { connection: "close" });
    res.end(
      "privacy egress proxy: only CONNECT tunnels (HTTPS, or IMAPS to the mail provider) are allowed\n",
    );
  };

  const onConnect = (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on("error", () => client.destroy());
    const authority = splitHostPort(req.url ?? "");
    const host = authority?.host ?? String(req.url);
    const unsafe = options.guard?.();
    if (unsafe) {
      refuse(client, host, "config_unsafe");
      return;
    }
    const permitted =
      authority !== null &&
      ((authority.port === TUNNEL_PORT && isHostAllowed(authority.host, options.allow())) ||
        (authority.port === IMAPS_PORT &&
          isHostAllowed(authority.host, options.allowImap?.() ?? [])));
    if (!authority || !permitted) {
      refuse(client, host, "not_allowlisted");
      return;
    }
    void (async () => {
      let addresses: string[];
      try {
        addresses = await resolve(authority.host);
      } catch {
        refuse(client, host, "not_allowlisted", 502);
        return;
      }
      // An allowlisted name must not lead into this machine or its network.
      const target = addresses[0];
      if (!target || addresses.some(isNonPublicAddress)) {
        refuse(client, host, "private_address");
        return;
      }
      const upstream = connect(authority.port, target);
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      let established = false;
      upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error("connect timeout")));
      upstream.once("connect", () => {
        established = true;
        upstream.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => upstream.destroy());
        client.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => client.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
          upstream.write(head);
        }
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => {
        if (established) {
          // Inside an open tunnel only the TLS session speaks; just close it.
          client.destroy();
        } else {
          client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        }
      });
      client.on("close", () => upstream.destroy());
    })();
  };

  return {
    async start() {
      server = http.createServer(onRequest);
      server.on("connect", onConnect);
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      try {
        await new Promise<void>((resolveListen, reject) => {
          server!.once("error", reject);
          server!.listen(options.port, "127.0.0.1", () => resolveListen());
        });
      } catch (error) {
        server = undefined;
        markServiceDown("privacy-egress-proxy", String((error as Error)?.message ?? error));
        throw error;
      }
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      markServiceUp("privacy-egress-proxy", url);
      return url;
    },
    async stop() {
      const current = server;
      server = undefined;
      markServiceDown("privacy-egress-proxy", "stopped");
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      if (current) {
        await new Promise<void>((resolveClose) => current.close(() => resolveClose()));
      }
    },
  };
}
