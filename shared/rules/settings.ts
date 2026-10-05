// privacy-core settings, read from plugins.entries.privacy-core.config.
// Shared so the attested relays can enforce the same rules without privacy-core.
import type { MailProviderId } from "../mail.js";

/** Maximum characters of an answer that may leave a private gateway by default. */
export const BOUNDARY_DEFAULT_MAX_CHARS = 4000;

/** CEL action policy as configured; privacy-core fills the defaults. */
export type ConfiguredActionPolicy = {
  mode?: "enforce" | "dry-run";
  deny?: string[];
  approve?: string[];
  allow?: string[];
};

export type ProviderRegion = "us" | "eu" | "local";

export type PrivacySettings = {
  /** `private` turns this gateway into the private house; `standard` changes nothing. */
  mode: "standard" | "private";
  /** `eu` restricts every agent to providers whose region is `eu` or `local`. */
  residency: "any" | "eu";
  /** Operator-declared regions for providers this pack has no trust entry for. */
  providers: Record<string, { region: ProviderRegion }>;
  egress: {
    /** Extra hosts a private gateway may reach, on top of the providers in use. */
    allow: string[];
    /** Loopback port of the egress proxy; `proxy.proxyUrl` must point here. */
    proxyPort: number;
  };
  boundary: { mode: "summary_only" | "block"; maxChars: number };
  policy?: ConfiguredActionPolicy;
  /**
   * `required` (default): private agents run their tools in a container.
   * `off` (lite mode, no Docker): private agents may have no shell, file,
   * browser or computer tools at all.
   */
  sandbox: "required" | "off";
  /**
   * The read-only mail and calendar connector (private mode only). The password
   * and calendar link are secret-store references, never plain text.
   */
  mail?: {
    provider: MailProviderId | string;
    address: string;
    password: unknown;
    calendarUrl?: unknown;
  };
  skills: {
    /**
     * `required`: an agent run is refused while a skill folder it loads is not approved
     * by fingerprint. Always `required` in private mode; opt-in on a standard gateway.
     */
    approval: "required" | "off";
    /** Approved fingerprints (`sha256:<hex>`) per skill name, written by `privacy skills approve`. */
    approved: Record<string, string[]>;
  };
};

export const DEFAULT_EGRESS_PROXY_PORT = 19930;

export function egressProxyUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

type RawSettings = {
  mode?: unknown;
  residency?: unknown;
  providers?: unknown;
  egress?: { allow?: unknown; proxyPort?: unknown };
  boundary?: { mode?: unknown; maxChars?: unknown };
  policy?: unknown;
  skills?: { approval?: unknown; approved?: unknown };
  sandbox?: unknown;
  mail?: { provider?: unknown; address?: unknown; password?: unknown; calendarUrl?: unknown };
};

export function resolvePrivacySettings(raw: unknown): PrivacySettings {
  const value = (raw ?? {}) as RawSettings;
  const providers: PrivacySettings["providers"] = {};
  if (value.providers && typeof value.providers === "object") {
    for (const [id, entry] of Object.entries(value.providers as Record<string, unknown>)) {
      const region = (entry as { region?: unknown } | undefined)?.region;
      if (region === "us" || region === "eu" || region === "local") {
        providers[id.toLowerCase()] = { region };
      }
    }
  }
  const allow = Array.isArray(value.egress?.allow)
    ? value.egress.allow.filter((host): host is string => typeof host === "string")
    : [];
  const proxyPort =
    typeof value.egress?.proxyPort === "number"
      ? value.egress.proxyPort
      : DEFAULT_EGRESS_PROXY_PORT;
  const maxChars =
    typeof value.boundary?.maxChars === "number"
      ? value.boundary.maxChars
      : BOUNDARY_DEFAULT_MAX_CHARS;
  const mode = value.mode === "private" ? "private" : "standard";
  // No prototype: a skill may be named "constructor" or "__proto__".
  const approved: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const rawApproved = value.skills?.approved;
  if (rawApproved && typeof rawApproved === "object" && !Array.isArray(rawApproved)) {
    for (const [name, list] of Object.entries(rawApproved as Record<string, unknown>)) {
      if (Array.isArray(list)) {
        approved[name] = list.filter((entry): entry is string => typeof entry === "string");
      }
    }
  }
  return {
    mode,
    residency: value.residency === "eu" ? "eu" : "any",
    providers,
    egress: { allow: allow.map((host) => host.trim().toLowerCase()), proxyPort },
    boundary: { mode: value.boundary?.mode === "block" ? "block" : "summary_only", maxChars },
    ...(value.policy && typeof value.policy === "object"
      ? { policy: value.policy as ConfiguredActionPolicy }
      : {}),
    sandbox: value.sandbox === "off" ? "off" : "required",
    ...(value.mail && typeof value.mail === "object"
      ? {
          mail: {
            provider: typeof value.mail.provider === "string" ? value.mail.provider : "",
            address: typeof value.mail.address === "string" ? value.mail.address.trim() : "",
            password: value.mail.password,
            ...(value.mail.calendarUrl !== undefined
              ? { calendarUrl: value.mail.calendarUrl }
              : {}),
          },
        }
      : {}),
    skills: {
      approval: mode === "private" || value.skills?.approval === "required" ? "required" : "off",
      approved,
    },
  };
}
