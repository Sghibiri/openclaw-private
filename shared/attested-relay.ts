// Loopback relay in front of an attested provider transport.
//
// OpenClaw's shared OpenAI-compatible transport talks plain HTTP to this relay
// on 127.0.0.1. The relay forwards each request through the provider plugin's
// attested transport, which verifies the enclave before sending and seals the
// body to it. When verification fails or cannot run, the relay answers with an
// error and nothing leaves the machine. This keeps attestation inside the
// plugin, so stock OpenClaw needs no transport hook.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { markServiceDown, markServiceUp, type PackServiceId } from "./rules/service-registry.js";

/** Hop-by-hop and host-bound headers the relay never forwards. */
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
  "expect",
  "origin",
  "referer",
  "cookie",
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
]);
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

export type AttestedRelayOptions = {
  /** Provider id, used in error messages. */
  provider: string;
  /** Registry id the relay reports itself under once it holds its port. */
  serviceId?: PackServiceId;
  /**
   * Called before every request. A message means "refuse": the relay answers
   * 503 with it and sends nothing. Used to stop all traffic while the privacy
   * config is unsafe, independently of privacy-core's hooks.
   */
  guard?: () => string | undefined;
  /** Upstream base the attested transport accepts, e.g. https://inference.tinfoil.sh/v1 */
  upstreamBaseUrl: string;
  /** The attested fetch. Must refuse to send when verification fails. */
  fetch: typeof fetch;
  port: number;
  host?: string;
  onError?: (message: string) => void;
};

export type AttestedRelay = {
  start(): Promise<string>;
  stop(): Promise<void>;
  /** Base URL to configure as `models.providers.<id>.baseUrl`, once started. */
  baseUrl(): string | undefined;
};

export function relayBaseUrl(port: number, host = "127.0.0.1"): string {
  return `http://${host}:${port}/v1`;
}

class BodyTooLargeError extends Error {}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) {
        return;
      }
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        // Stop buffering and answer; the socket is closed after the 413 is written.
        rejected = true;
        reject(new BodyTooLargeError("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", reject);
  });
}

/** `/v1/...` with no dot segments, encoded dots or slashes, or backslashes. */
function isPlainV1Path(path: string): boolean {
  if (!path.startsWith("/v1/") || path.includes("\\")) {
    return false;
  }
  const pathname = path.split("?")[0] ?? "";
  if (/%2e|%2f|%5c/iu.test(pathname)) {
    return false;
  }
  return !pathname.split("/").some((segment) => segment === "." || segment === "..");
}

function sendError(
  res: http.ServerResponse,
  status: number,
  message: string,
  options: { close?: boolean } = {},
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json",
    ...(options.close ? { connection: "close" } : {}),
  });
  res.end(JSON.stringify({ error: { message, type: "attested_relay_error" } }));
}

export function createAttestedRelay(options: AttestedRelayOptions): AttestedRelay {
  const host = options.host ?? "127.0.0.1";
  const upstreamBase = options.upstreamBaseUrl.replace(/\/+$/u, "");
  let server: http.Server | undefined;
  let url: string | undefined;

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse, port: number) => {
    // Only OpenClaw on this machine may call the relay: a browser page reaching
    // 127.0.0.1 through DNS rebinding carries a foreign Host or an Origin header.
    const hostHeader = (req.headers.host ?? "").toLowerCase();
    if (
      req.headers.origin !== undefined ||
      (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}`)
    ) {
      sendError(res, 403, `The ${options.provider} relay only serves local callers.`);
      return;
    }
    const path = req.url ?? "/";
    if (!isPlainV1Path(path)) {
      sendError(res, 404, `The ${options.provider} relay only serves plain /v1/ paths.`);
      return;
    }
    const refusal = options.guard?.();
    if (refusal) {
      sendError(res, 503, `${options.provider}: request not sent: ${refusal}`);
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) {
        continue;
      }
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    let body: Buffer | undefined;
    try {
      body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendError(res, 413, error.message, { close: true });
      } else {
        res.destroy();
      }
      return;
    }
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) {
        controller.abort();
      }
    });
    let upstream: Response;
    try {
      upstream = await options.fetch(`${upstreamBase}${path.slice(3)}`, {
        method: req.method,
        headers,
        ...(body && body.length > 0 ? { body: new Uint8Array(body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      const message = `${options.provider}: request not sent: ${(error as Error)?.message ?? String(error)}`;
      options.onError?.(message);
      sendError(res, 502, message);
      return;
    }
    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
        responseHeaders[name] = value;
      }
    });
    res.writeHead(upstream.status, responseHeaders);
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body as never)
      .on("error", () => res.destroy())
      .pipe(res);
  };

  return {
    async start() {
      if (url) {
        return url;
      }
      let boundPort = options.port;
      server = http.createServer((req, res) => {
        handle(req, res, boundPort).catch((error: unknown) =>
          sendError(res, 500, `${options.provider} relay failed: ${String(error)}`),
        );
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server!.once("error", reject);
          server!.listen(options.port, host, () => resolve());
        });
      } catch (error) {
        server = undefined;
        if (options.serviceId) {
          markServiceDown(options.serviceId, String((error as Error)?.message ?? error));
        }
        throw error;
      }
      boundPort = (server.address() as AddressInfo).port;
      url = relayBaseUrl(boundPort, host);
      if (options.serviceId) {
        markServiceUp(options.serviceId, url);
      }
      return url;
    },
    async stop() {
      const current = server;
      server = undefined;
      url = undefined;
      if (options.serviceId) {
        markServiceDown(options.serviceId, "stopped");
      }
      if (current) {
        current.closeAllConnections();
        await new Promise<void>((resolve) => current.close(() => resolve()));
      }
    },
    baseUrl: () => url,
  };
}
