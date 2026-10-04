// The config the privacy rules read: the live config as authored.
//
// The runtime snapshot has SecretRefs already resolved to their values, so a
// rule such as "no plaintext API keys" would misfire on it. The source snapshot
// is the same live config with SecretRef markers intact; before the gateway
// publishes one (CLI processes, early startup), the registration config is used.
import { getRuntimeConfigSourceSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { HostConfig } from "./validate.js";

export function authoredConfig(fallback: unknown): HostConfig {
  return (getRuntimeConfigSourceSnapshot() ?? fallback) as HostConfig;
}
