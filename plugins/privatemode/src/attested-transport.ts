import { AsyncLocalStorage } from "node:async_hooks";
import type { AttestationRecord } from "../../../shared/audit-types.js";
// Attested transport for Privatemode (Edgeless Systems).
//
// The `privatemode-ai` SDK verifies the deployment's attestation (AMD SEV-SNP
// or Intel TDX, through Edgeless Contrast) against a manifest of reference
// values, establishes an encryption secret with the enclave, and routes every
// OpenAI-style request through its own encrypted transport. This module owns
// the client lifetime: one client per gateway, re-verified after `maxAgeMs`,
// the verifier WASM pinned by hash, the manifest optionally pinned, and every
// verification outcome written to the privacy audit log. Nothing is sent when
// verification fails.
import { recordPrivacyAuditEvent, type PrivacyAuditEvent } from "../../../shared/audit.js";

/** SHA-256 of `privatemode.wasm` shipped with privatemode-ai 1.55.0. */
export const PRIVATEMODE_WASM_SHA256 =
  "75b59677d2e656a5734446423e4768bce2a2a2ff0e50af9be553ddecea720ac2";
export const PRIVATEMODE_SDK_VERSION = "1.55.0";
export const PRIVATEMODE_DEFAULT_ATTESTATION_MAX_AGE_MS = 15 * 60_000;

type SnpReferenceValue = { TrustedMeasurement?: string; ProductName?: string };
type ManifestLike = { ReferenceValues?: { snp?: SnpReferenceValue[] } } | null | undefined;

/** The subset of `PrivatemodeAI` this transport relies on. */
export type PrivatemodeClientLike = {
  verify(): Promise<{ manifest: ManifestLike }>;
  close(): void;
  readonly manifestBytes: Uint8Array | null;
  /** The SDK's OpenAI-compatible fetch adapter; requests are routed by path. */
  transportFetch: typeof fetch;
};

export type PrivatemodeAttestedTransportOptions = {
  maxAgeMs: number;
  /** `strict` refuses a verified manifest that differs from the pinned bytes. */
  manifestPin: "auto" | "strict";
  /** Previously pinned manifest bytes, if any. */
  pinnedManifest?: Uint8Array;
  /** Called with the manifest bytes after a successful verification, for persisting the pin. */
  persistManifest?: (bytes: Uint8Array) => void;
  createClient?: (options: {
    manifestBytes?: Uint8Array;
    expectedWasmHash: string;
    onManifestUpdate: (bytes: Uint8Array) => void;
  }) => Promise<PrivatemodeClientLike>;
  now?: () => number;
  record?: (event: PrivacyAuditEvent) => void;
  /** How long a replaced client keeps serving streams already running on it. */
  retireGraceMs?: number;
};

const DEFAULT_RETIRE_GRACE_MS = 10 * 60_000;

export type PrivatemodeAttestedTransport = {
  ensureAttested(): Promise<AttestationRecord>;
  fetch: typeof fetch;
  lastAttestation(): AttestationRecord | undefined;
};

/**
 * `PrivatemodeAI` extends the OpenAI client and installs its encrypted
 * transport as that client's fetch. The field is private on the OpenAI client,
 * so it is read at runtime and checked to be a function; anything else fails
 * closed rather than falling back to plain fetch.
 */
function readTransportFetch(client: object): typeof fetch {
  const candidate = Reflect.get(client, "fetch");
  if (typeof candidate !== "function") {
    throw new Error("privatemode-ai client does not expose its encrypted transport fetch");
  }
  return candidate as typeof fetch;
}

/**
 * The API key of the request being served. The relay runs each request inside
 * `runWithPrivatemodeCredential`, and the SDK asks for the credential before
 * every network operation, so each request is authenticated with the key its
 * caller sent. No key lives in the process environment, so the relay never
 * lends the operator's key to a caller that did not present it.
 */
const credentialStore = new AsyncLocalStorage<string | undefined>();

export function runWithPrivatemodeCredential<T>(apiKey: string | undefined, run: () => T): T {
  return credentialStore.run(apiKey?.trim() || undefined, run);
}

/** The key of the request currently being served, as handed to the SDK. */
export function currentPrivatemodeCredential(): string | undefined {
  return credentialStore.getStore();
}

/** The bearer token from an Authorization header, if any. */
export function bearerToken(headers: HeadersInit | undefined): string | undefined {
  const value = new Headers(headers).get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/iu.exec(value.trim());
  return match?.[1]?.trim() || undefined;
}

async function createDefaultClient(options: {
  manifestBytes?: Uint8Array;
  expectedWasmHash: string;
  onManifestUpdate: (bytes: Uint8Array) => void;
}): Promise<PrivatemodeClientLike> {
  const { PrivatemodeAI } = await import("privatemode-ai");
  const client = new PrivatemodeAI({
    auth: () => {
      const apiKey = currentPrivatemodeCredential();
      return apiKey
        ? { type: "apiKey" as const, value: apiKey }
        : { type: "anonymous" as const, value: "" };
    },
    manifestBytes: options.manifestBytes,
    expectedWasmHash: options.expectedWasmHash,
    onManifestUpdate: options.onManifestUpdate,
    enableWasmLogging: false,
  });
  return {
    verify: () => client.verify(),
    close: () => client.close(),
    get manifestBytes() {
      return client.manifestBytes;
    },
    transportFetch: readTransportFetch(client),
  };
}

function bytesEqual(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPrivatemodeAttestedTransport(
  options: PrivatemodeAttestedTransportOptions,
): PrivatemodeAttestedTransport {
  const now = options.now ?? (() => Date.now());
  const record =
    options.record ?? ((event: PrivacyAuditEvent) => void recordPrivacyAuditEvent(event));
  const createClient = options.createClient ?? createDefaultClient;

  let client: PrivatemodeClientLike | undefined;
  let attestedAt = 0;
  let last: AttestationRecord | undefined;
  let inFlight: Promise<AttestationRecord> | undefined;
  let pinned = options.pinnedManifest;

  const fail = (error: string): AttestationRecord => {
    const failure: AttestationRecord = {
      provider: "privatemode",
      ok: false,
      at: new Date(now()).toISOString(),
      error,
    };
    last = failure;
    record({ kind: "attestation", provider: "privatemode", ok: false, error });
    return failure;
  };

  // A re-attestation must not cut off streams still running on the previous
  // client: it stops serving new requests at once and is closed after a grace period.
  const retire = (old: PrivatemodeClientLike | undefined) => {
    if (!old) {
      return;
    }
    const timer = setTimeout(() => old.close(), options.retireGraceMs ?? DEFAULT_RETIRE_GRACE_MS);
    timer.unref?.();
  };

  const attest = async (): Promise<AttestationRecord> => {
    retire(client);
    client = undefined;
    let manifestRotated = false;
    let next: PrivatemodeClientLike;
    try {
      next = await createClient({
        manifestBytes: pinned,
        expectedWasmHash: PRIVATEMODE_WASM_SHA256,
        onManifestUpdate: () => {
          manifestRotated = true;
        },
      });
      const result = await next.verify();
      const verifiedBytes = next.manifestBytes;
      if (pinned && !bytesEqual(pinned, verifiedBytes)) {
        manifestRotated = true;
        if (options.manifestPin === "strict") {
          next.close();
          const failure = fail(
            "verified manifest differs from the pinned manifest (attestation.manifestPin is strict)",
          );
          throw new Error(`Privatemode attestation refused: ${failure.error}`);
        }
      }
      if (verifiedBytes && (!pinned || manifestRotated)) {
        pinned = verifiedBytes;
        options.persistManifest?.(verifiedBytes);
      }
      const measurement = result.manifest?.ReferenceValues?.snp?.[0]?.TrustedMeasurement;
      client = next;
      attestedAt = now();
      const success: AttestationRecord = {
        provider: "privatemode",
        ok: true,
        at: new Date(attestedAt).toISOString(),
        enclaveHost: "api.privatemode.ai",
        measurement,
        verifierVersion: PRIVATEMODE_SDK_VERSION,
      };
      last = success;
      record({
        kind: "attestation",
        provider: "privatemode",
        ok: true,
        enclaveHost: success.enclaveHost,
        measurement,
        verifierVersion: PRIVATEMODE_SDK_VERSION,
        ...(manifestRotated ? { manifestRotated: true } : {}),
      });
      return success;
    } catch (error) {
      if (last?.ok !== false || last.error === undefined) {
        fail(errorMessage(error));
      }
      throw error;
    }
  };

  const ensureAttested = async (): Promise<AttestationRecord> => {
    if (client && last?.ok && now() - attestedAt < options.maxAgeMs) {
      return last;
    }
    if (!inFlight) {
      inFlight = attest().finally(() => {
        inFlight = undefined;
      });
    }
    return await inFlight;
  };

  const attestedFetch: typeof fetch = async (input, init) => {
    await ensureAttested();
    const current = client;
    if (!current) {
      throw new Error("Privatemode attestation is not available; request not sent");
    }
    return await current.transportFetch(input, init);
  };

  return { ensureAttested, fetch: attestedFetch, lastAttestation: () => last };
}
