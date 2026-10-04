import type { AttestationRecord } from "../../../shared/audit-types.js";
// Attested transport for Tinfoil: verify the enclave before any byte is sent.
//
// The SecureClient from the `tinfoil` SDK verifies AMD SEV-SNP attestation, the
// Sigstore-signed release of the router code and the enclave key binding, then
// exposes a fetch that HPKE-seals request bodies to that enclave and refuses
// every other origin. This module owns the client lifetime: one client per
// gateway, re-verified after `maxAgeMs`, and every verification outcome is
// written to the privacy audit log. Nothing is sent when verification fails.
import { recordPrivacyAuditEvent, type PrivacyAuditEvent } from "../../../shared/audit.js";

/** The subset of `tinfoil`'s SecureClient this transport relies on. */
export type TinfoilSecureClientLike = {
  ready(): Promise<void>;
  reset(): void;
  fetch: typeof fetch;
  getBaseURL(): string | undefined;
  getVerificationDocument(): {
    enclaveHost?: string;
    codeFingerprint?: string;
    enclaveFingerprint?: string;
    releaseDigest?: string;
    releaseTag?: string;
    securityVerified?: boolean;
    verifiedAt?: string;
    verifier?: { name?: string; version?: string };
  };
};

export type TinfoilAttestedTransportOptions = {
  /** Base URL the shared transport was configured with; requests are rebased onto the attested router. */
  configuredBaseUrl: string;
  /** Re-verify the enclave after this long. */
  maxAgeMs: number;
  /** Per-gateway prompt-cache scoping secret; never shared across gateways. */
  userCacheSecret?: string;
  createClient?: (options: { userCacheSecret?: string }) => Promise<TinfoilSecureClientLike>;
  now?: () => number;
  record?: (event: PrivacyAuditEvent) => void;
};

export type TinfoilAttestedTransport = {
  ensureAttested(): Promise<AttestationRecord>;
  fetch: typeof fetch;
  /** Last successful attestation, or undefined before the first one. */
  lastAttestation(): AttestationRecord | undefined;
};

export const TINFOIL_DEFAULT_ATTESTATION_MAX_AGE_MS = 15 * 60_000;

async function createDefaultClient(options: {
  userCacheSecret?: string;
}): Promise<TinfoilSecureClientLike> {
  const { SecureClient } = await import("tinfoil");
  return new SecureClient(
    options.userCacheSecret ? { userCacheSecret: options.userCacheSecret } : {},
  );
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTinfoilAttestedTransport(
  options: TinfoilAttestedTransportOptions,
): TinfoilAttestedTransport {
  const now = options.now ?? (() => Date.now());
  const record =
    options.record ?? ((event: PrivacyAuditEvent) => void recordPrivacyAuditEvent(event));
  const createClient = options.createClient ?? createDefaultClient;
  const configuredBase = trimTrailingSlash(options.configuredBaseUrl.trim());

  let client: TinfoilSecureClientLike | undefined;
  let attestedAt = 0;
  let last: AttestationRecord | undefined;
  let inFlight: Promise<AttestationRecord> | undefined;

  const attest = async (): Promise<AttestationRecord> => {
    const next = client ?? (await createClient({ userCacheSecret: options.userCacheSecret }));
    if (client) {
      // Existing client: force a fresh verification instead of the memoized one.
      client.reset();
    }
    try {
      await next.ready();
    } catch (error) {
      client = undefined;
      const failure: AttestationRecord = {
        provider: "tinfoil",
        ok: false,
        at: new Date(now()).toISOString(),
        error: errorMessage(error),
      };
      last = failure;
      record({ kind: "attestation", provider: "tinfoil", ok: false, error: failure.error });
      throw error;
    }
    const document = next.getVerificationDocument();
    if (document.securityVerified !== true) {
      client = undefined;
      const failure: AttestationRecord = {
        provider: "tinfoil",
        ok: false,
        at: new Date(now()).toISOString(),
        error: "verification document reports securityVerified=false",
      };
      last = failure;
      record({ kind: "attestation", provider: "tinfoil", ok: false, error: failure.error });
      throw new Error(`Tinfoil attestation not verified: ${failure.error}`);
    }
    client = next;
    attestedAt = now();
    const success: AttestationRecord = {
      provider: "tinfoil",
      ok: true,
      at: document.verifiedAt ?? new Date(attestedAt).toISOString(),
      enclaveHost: document.enclaveHost,
      measurement: document.codeFingerprint || document.enclaveFingerprint,
      releaseDigest: document.releaseDigest,
      verifierVersion: document.verifier?.version,
    };
    last = success;
    record({
      kind: "attestation",
      provider: "tinfoil",
      ok: true,
      enclaveHost: success.enclaveHost,
      measurement: success.measurement,
      releaseDigest: success.releaseDigest,
      verifierVersion: success.verifierVersion,
    });
    return success;
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

  const rebase = (rawUrl: string): string => {
    const attestedBase = client?.getBaseURL();
    if (!attestedBase) {
      throw new Error("Tinfoil attested base URL unavailable; refusing to send");
    }
    const url = rawUrl.trim();
    if (url !== configuredBase && !url.startsWith(`${configuredBase}/`)) {
      throw new Error(
        `Tinfoil transport refuses request outside its configured base (${configuredBase})`,
      );
    }
    return `${trimTrailingSlash(attestedBase)}${url.slice(configuredBase.length)}`;
  };

  const attestedFetch: typeof fetch = async (input, init) => {
    await ensureAttested();
    if (input instanceof Request) {
      const rebased = new Request(rebase(input.url), input);
      return await client!.fetch(rebased, init);
    }
    const rawUrl = input instanceof URL ? input.toString() : String(input);
    return await client!.fetch(rebase(rawUrl), init);
  };

  return {
    ensureAttested,
    fetch: attestedFetch,
    lastAttestation: () => last,
  };
}
