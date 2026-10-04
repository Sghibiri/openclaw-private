import { describe, expect, it, vi } from "vitest";
import type { PrivacyAuditEvent } from "../../../shared/audit.js";
import {
  createPrivatemodeAttestedTransport,
  PRIVATEMODE_WASM_SHA256,
  type PrivatemodeClientLike,
} from "./attested-transport.js";

const MANIFEST_A = new TextEncoder().encode(
  '{"ReferenceValues":{"snp":[{"TrustedMeasurement":"m-a"}]}}',
);
const MANIFEST_B = new TextEncoder().encode(
  '{"ReferenceValues":{"snp":[{"TrustedMeasurement":"m-b"}]}}',
);

function fakeClient(params: { verifyError?: Error; manifest?: Uint8Array }) {
  const manifestBytes = params.manifest ?? MANIFEST_A;
  const transportFetch = vi.fn(async () => new Response("ok"));
  const client: PrivatemodeClientLike & {
    transportFetch: typeof transportFetch;
    close: ReturnType<typeof vi.fn>;
  } = {
    verify: vi.fn(async () => {
      if (params.verifyError) {
        throw params.verifyError;
      }
      return { manifest: JSON.parse(new TextDecoder().decode(manifestBytes)) };
    }),
    close: vi.fn<() => void>(),
    manifestBytes,
    transportFetch: transportFetch as unknown as typeof fetch & typeof transportFetch,
  };
  return client;
}

describe("createPrivatemodeAttestedTransport", () => {
  it("sends zero bytes and records a failure when verification throws", async () => {
    const client = fakeClient({ verifyError: new Error("manifest mismatch") });
    const events: PrivacyAuditEvent[] = [];
    const transport = createPrivatemodeAttestedTransport({
      maxAgeMs: 60_000,
      manifestPin: "auto",
      createClient: async () => client,
      record: (event) => events.push(event),
    });
    await expect(transport.fetch("https://api.privatemode.ai/v1/chat/completions")).rejects.toThrow(
      "manifest mismatch",
    );
    expect(client.transportFetch).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: "attestation", provider: "privatemode", ok: false, error: "manifest mismatch" },
    ]);
  });

  it("pins the verifier hash, persists the manifest, and records the measurement", async () => {
    const client = fakeClient({});
    const createClient = vi.fn(async (_options: unknown) => client);
    const persisted: Uint8Array[] = [];
    const events: PrivacyAuditEvent[] = [];
    const transport = createPrivatemodeAttestedTransport({
      maxAgeMs: 60_000,
      manifestPin: "auto",
      createClient,
      persistManifest: (bytes) => persisted.push(bytes),
      record: (event) => events.push(event),
    });
    await transport.fetch("https://api.privatemode.ai/v1/models");
    expect(createClient.mock.calls[0]?.[0]).toMatchObject({
      expectedWasmHash: PRIVATEMODE_WASM_SHA256,
    });
    expect(persisted).toEqual([MANIFEST_A]);
    expect(client.transportFetch).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      {
        kind: "attestation",
        provider: "privatemode",
        ok: true,
        enclaveHost: "api.privatemode.ai",
        measurement: "m-a",
        verifierVersion: "1.55.0",
      },
    ]);
  });

  it("refuses a rotated manifest in strict mode and accepts it in auto mode", async () => {
    const rotated = fakeClient({ manifest: MANIFEST_B });
    const events: PrivacyAuditEvent[] = [];
    const strict = createPrivatemodeAttestedTransport({
      maxAgeMs: 60_000,
      manifestPin: "strict",
      pinnedManifest: MANIFEST_A,
      createClient: async () => rotated,
      record: (event) => events.push(event),
    });
    await expect(strict.fetch("https://api.privatemode.ai/v1/models")).rejects.toThrow(
      /pinned manifest/,
    );
    expect(rotated.transportFetch).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ ok: false });

    const persisted: Uint8Array[] = [];
    const auto = createPrivatemodeAttestedTransport({
      maxAgeMs: 60_000,
      manifestPin: "auto",
      pinnedManifest: MANIFEST_A,
      createClient: async () => fakeClient({ manifest: MANIFEST_B }),
      persistManifest: (bytes) => persisted.push(bytes),
      record: (event) => events.push(event),
    });
    await auto.fetch("https://api.privatemode.ai/v1/models");
    expect(persisted).toEqual([MANIFEST_B]);
    expect(events.at(-1)).toMatchObject({ ok: true, manifestRotated: true });
  });

  it("re-verifies after maxAge with a fresh client and retires the old one after a grace period", async () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const clients = [fakeClient({}), fakeClient({})];
      const createClient = vi.fn(async () => clients[createClient.mock.calls.length - 1]!);
      const transport = createPrivatemodeAttestedTransport({
        maxAgeMs: 1000,
        manifestPin: "auto",
        createClient,
        now: () => clock,
        record: () => {},
        retireGraceMs: 60_000,
      });
      await transport.fetch("https://api.privatemode.ai/v1/models");
      await transport.fetch("https://api.privatemode.ai/v1/models");
      expect(createClient).toHaveBeenCalledTimes(1);
      clock = 1500;
      await transport.fetch("https://api.privatemode.ai/v1/models");
      expect(createClient).toHaveBeenCalledTimes(2);
      // Streams still running on the old client keep working until the grace period ends.
      expect(clients[0]!.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(clients[0]!.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("authenticates each request with the key of the request being served", async () => {
    const { bearerToken, currentPrivatemodeCredential, runWithPrivatemodeCredential } =
      await import("./attested-transport.js");
    const credentialProbe = () => currentPrivatemodeCredential();
    expect(bearerToken({ authorization: "Bearer key-1" })).toBe("key-1");
    expect(bearerToken({})).toBeUndefined();
    const seen = await Promise.all([
      runWithPrivatemodeCredential("key-a", async () => {
        await Promise.resolve();
        return credentialProbe();
      }),
      runWithPrivatemodeCredential(undefined, async () => credentialProbe()),
    ]);
    expect(seen).toEqual(["key-a", undefined]);
  });
});
