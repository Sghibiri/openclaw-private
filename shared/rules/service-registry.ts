// Process-wide record of which pack services actually started.
//
// The relays and the egress proxy live in different plugins. If one cannot
// bind its loopback port (another process already holds it), traffic meant for
// it would reach whatever is listening there. The run gate refuses runs until
// every service a private gateway depends on has reported that it is up. Kept
// on globalThis so separately loaded copies of this module share one record.
export type PackServiceId =
  | "privacy-egress-proxy"
  | "tinfoil-attested-relay"
  | "privatemode-attested-relay";

type ServiceState = { up: boolean; url?: string; error?: string };

const REGISTRY_KEY = Symbol.for("openclaw-private.service-registry");

function registry(): Map<PackServiceId, ServiceState> {
  const holder = globalThis as { [REGISTRY_KEY]?: Map<PackServiceId, ServiceState> };
  holder[REGISTRY_KEY] ??= new Map();
  return holder[REGISTRY_KEY];
}

export function markServiceUp(id: PackServiceId, url: string): void {
  registry().set(id, { up: true, url });
}

export function markServiceDown(id: PackServiceId, error?: string): void {
  registry().set(id, { up: false, ...(error ? { error } : {}) });
}

export function serviceState(id: PackServiceId): ServiceState | undefined {
  return registry().get(id);
}

/** Test seam: forget every service. */
export function resetServiceRegistryForTest(): void {
  registry().clear();
}
