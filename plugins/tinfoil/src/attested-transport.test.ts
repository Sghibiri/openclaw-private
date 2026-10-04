import { describe, expect, it, vi } from "vitest";
import type { PrivacyAuditEvent } from "../../../shared/audit.js";
import {
  createTinfoilAttestedTransport,
  type TinfoilSecureClientLike,
} from "./attested-transport.js";

const CONFIGURED_BASE = "https://inference.tinfoil.sh/v1";
const ATTESTED_BASE = "https://router.inf6.tinfoil.sh/v1/";

function fakeClient(params: {
  readyError?: Error;
  verified?: boolean;
}): TinfoilSecureClientLike & { fetch: ReturnType<typeof vi.fn>; ready: ReturnType<typeof vi.fn> } {
  const ready = vi.fn(async () => {
    if (params.readyError) {
      throw params.readyError;
    }
  });
  const fetch = vi.fn(async () => new Response("ok"));
  return {
    ready,
    reset: vi.fn(),
    fetch: fetch as unknown as typeof globalThis.fetch,
    getBaseURL: () => ATTESTED_BASE,
    getVerificationDocument: () => ({
      enclaveHost: "router.inf6.tinfoil.sh",
      codeFingerprint: "abc123",
      releaseDigest: "sha256:def",
      securityVerified: params.verified ?? true,
      verifiedAt: "2026-09-19T10:00:00.000Z",
      verifier: { name: "@tinfoilsh/verifier", version: "1.2.1" },
    }),
  } as never;
}

describe("createTinfoilAttestedTransport", () => {
  it("sends zero bytes and records a failed attestation when verification throws", async () => {
    const client = fakeClient({ readyError: new Error("Code measurement mismatch") });
    const events: PrivacyAuditEvent[] = [];
    const transport = createTinfoilAttestedTransport({
      configuredBaseUrl: CONFIGURED_BASE,
      maxAgeMs: 60_000,
      createClient: async () => client,
      record: (event) => events.push(event),
    });
    await expect(
      transport.fetch(`${CONFIGURED_BASE}/chat/completions`, { method: "POST", body: "{}" }),
    ).rejects.toThrow("Code measurement mismatch");
    expect(client.fetch).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: "attestation", provider: "tinfoil", ok: false, error: "Code measurement mismatch" },
    ]);
    expect(transport.lastAttestation()?.ok).toBe(false);
  });

  it("refuses to send when the verification document is not marked verified", async () => {
    const client = fakeClient({ verified: false });
    const transport = createTinfoilAttestedTransport({
      configuredBaseUrl: CONFIGURED_BASE,
      maxAgeMs: 60_000,
      createClient: async () => client,
      record: () => {},
    });
    await expect(transport.fetch(`${CONFIGURED_BASE}/models`)).rejects.toThrow(/not verified/);
    expect(client.fetch).not.toHaveBeenCalled();
  });

  it("rebases requests onto the attested router and records the measurement", async () => {
    const client = fakeClient({});
    const events: PrivacyAuditEvent[] = [];
    const transport = createTinfoilAttestedTransport({
      configuredBaseUrl: CONFIGURED_BASE,
      maxAgeMs: 60_000,
      createClient: async () => client,
      record: (event) => events.push(event),
    });
    const response = await transport.fetch(`${CONFIGURED_BASE}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer k" },
      body: "{}",
    });
    expect(await response.text()).toBe("ok");
    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(client.fetch.mock.calls[0]?.[0]).toBe(
      "https://router.inf6.tinfoil.sh/v1/chat/completions",
    );
    expect(events).toEqual([
      {
        kind: "attestation",
        provider: "tinfoil",
        ok: true,
        enclaveHost: "router.inf6.tinfoil.sh",
        measurement: "abc123",
        releaseDigest: "sha256:def",
        verifierVersion: "1.2.1",
      },
    ]);
  });

  it("refuses URLs outside the configured base", async () => {
    const client = fakeClient({});
    const transport = createTinfoilAttestedTransport({
      configuredBaseUrl: CONFIGURED_BASE,
      maxAgeMs: 60_000,
      createClient: async () => client,
      record: () => {},
    });
    await expect(transport.fetch("https://api.openai.com/v1/chat/completions")).rejects.toThrow(
      /outside its configured base/,
    );
    expect(client.fetch).not.toHaveBeenCalled();
  });

  it("re-attests after maxAge and reuses the verification within it", async () => {
    const client = fakeClient({});
    let clock = 0;
    const transport = createTinfoilAttestedTransport({
      configuredBaseUrl: CONFIGURED_BASE,
      maxAgeMs: 1000,
      createClient: async () => client,
      now: () => clock,
      record: () => {},
    });
    await transport.fetch(`${CONFIGURED_BASE}/models`);
    await transport.fetch(`${CONFIGURED_BASE}/models`);
    expect(client.ready).toHaveBeenCalledTimes(1);
    clock = 1500;
    await transport.fetch(`${CONFIGURED_BASE}/models`);
    expect(client.ready).toHaveBeenCalledTimes(2);
    expect(client.reset).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent first requests into one attestation", async () => {
    const client = fakeClient({});
    const transport = createTinfoilAttestedTransport({
      configuredBaseUrl: CONFIGURED_BASE,
      maxAgeMs: 60_000,
      createClient: async () => client,
      record: () => {},
    });
    await Promise.all([
      transport.fetch(`${CONFIGURED_BASE}/models`),
      transport.fetch(`${CONFIGURED_BASE}/models`),
    ]);
    expect(client.ready).toHaveBeenCalledTimes(1);
  });
});
