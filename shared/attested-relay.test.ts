// The attested relay: forwards /v1/ requests through the attested fetch only,
// streams the answer back, and sends nothing when the fetch refuses.
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createAttestedRelay, type AttestedRelay } from "./attested-relay.js";
import { resetServiceRegistryForTest, serviceState } from "./rules/service-registry.js";

const relays: AttestedRelay[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) {
    await relay.stop();
  }
  resetServiceRegistryForTest();
});

async function start(
  fetchImpl: typeof fetch,
  extra: { guard?: () => string | undefined; port?: number } = {},
) {
  const relay = createAttestedRelay({
    provider: "tinfoil",
    serviceId: "tinfoil-attested-relay",
    upstreamBaseUrl: "https://inference.tinfoil.sh/v1",
    fetch: fetchImpl,
    port: extra.port ?? 0,
    guard: extra.guard,
  });
  relays.push(relay);
  return await relay.start();
}

/** Raw request so the test controls Host, Origin and Expect headers. */
function rawRequest(
  base: string,
  params: { path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: Number(url.port),
        method: params.body === undefined ? "GET" : "POST",
        path: params.path,
        headers: params.headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(params.body);
  });
}

describe("attested relay", () => {
  it("rebases the request onto the upstream base and streams the answer", async () => {
    const seen: Array<{ url: string; auth: string | null; host: string | null; body: string }> = [];
    const base = await start(async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input),
        auth: headers.get("authorization"),
        host: headers.get("host"),
        body: new TextDecoder().decode(init?.body as Uint8Array),
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: one\n\n"));
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer key-1", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-oss-120b" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe("data: one\n\ndata: [DONE]\n\n");
    expect(seen).toEqual([
      {
        url: "https://inference.tinfoil.sh/v1/chat/completions",
        auth: "Bearer key-1",
        host: null,
        body: '{"model":"gpt-oss-120b"}',
      },
    ]);
  });

  it("answers 502 and sends nothing when the attested fetch refuses", async () => {
    const base = await start(async () => {
      throw new Error("tinfoil attestation failed: measurement mismatch");
    });
    const res = await fetch(`${base}/chat/completions`, { method: "POST", body: "{}" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: {
        message: "tinfoil: request not sent: tinfoil attestation failed: measurement mismatch",
        type: "attested_relay_error",
      },
    });
  });

  it("serves only /v1/ paths", async () => {
    const base = await start(async () => new Response("never"));
    const res = await fetch(base.replace(/\/v1$/u, "/admin"));
    expect(res.status).toBe(404);
  });

  it("serves only local callers: a foreign Host or any Origin is refused", async () => {
    const base = await start(async () => new Response("{}"));
    const port = new URL(base).port;
    await expect(
      rawRequest(base, { path: "/v1/models", headers: { host: "attacker.example" } }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      rawRequest(base, {
        path: "/v1/models",
        headers: { host: `127.0.0.1:${port}`, origin: "https://attacker.example" },
      }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      rawRequest(base, { path: "/v1/models", headers: { host: `localhost:${port}` } }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("refuses dot segments and encoded separators in the path", async () => {
    const base = await start(async () => new Response("{}"));
    const host = new URL(base).host;
    for (const path of ["/v1/../../attestation", "/v1/%2e%2e/x", "/v1/a%2Fb", "/v1/./models"]) {
      await expect(rawRequest(base, { path, headers: { host } }), path).resolves.toMatchObject({
        status: 404,
      });
    }
  });

  it("drops the Expect header and answers 413 to an oversized body", async () => {
    const seen: Array<string | null> = [];
    const base = await start(async (_input, init) => {
      seen.push(new Headers(init?.headers).get("expect"));
      return new Response("{}");
    });
    const host = new URL(base).host;
    await expect(
      rawRequest(base, {
        path: "/v1/chat/completions",
        headers: { host, expect: "100-continue", "content-type": "application/json" },
        body: JSON.stringify({ text: "x".repeat(2048) }),
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(seen).toEqual([null]);
    const big = await rawRequest(base, {
      path: "/v1/chat/completions",
      headers: { host },
      body: "x".repeat(16 * 1024 * 1024 + 10),
    });
    expect(big.status).toBe(413);
  });

  it("sends nothing while the guard refuses", async () => {
    let calls = 0;
    const base = await start(
      async () => {
        calls += 1;
        return new Response("{}");
      },
      { guard: () => "the privacy config has 2 problems; run openclaw privacy status" },
    );
    const res = await fetch(`${base}/chat/completions`, { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toContain(
      "request not sent: the privacy config has 2 problems",
    );
    expect(calls).toBe(0);
  });

  it("reports itself up only once it holds its port, and down when the port is taken", async () => {
    const base = await start(async () => new Response("{}"));
    expect(serviceState("tinfoil-attested-relay")).toEqual({ up: true, url: base });
    const squatted = createAttestedRelay({
      provider: "tinfoil",
      serviceId: "tinfoil-attested-relay",
      upstreamBaseUrl: "https://inference.tinfoil.sh/v1",
      fetch: async () => new Response("{}"),
      port: Number(new URL(base).port),
    });
    await expect(squatted.start()).rejects.toThrow(/EADDRINUSE/u);
    expect(serviceState("tinfoil-attested-relay")).toMatchObject({ up: false });
  });
});
