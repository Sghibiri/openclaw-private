// Host allowlist matching shared by the egress proxy and config validation.

/** Exact lowercase hostname, optionally with a `*.` prefix for a whole domain. */
export const PRIVACY_HOSTNAME_RE =
  /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeHost(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
}

export function matchesHostPattern(hostname: string, pattern: string): boolean {
  const host = normalizeHost(hostname);
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern;
}

export function isHostAllowed(hostname: string, allow: readonly string[]): boolean {
  return allow.some((pattern) => matchesHostPattern(hostname, pattern));
}
