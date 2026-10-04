// One refusal check for every component that can move data: the attested
// relays, the egress proxy and the action gateway. It reads privacy-core's
// settings straight from the host config, so it keeps working when privacy-core's
// conversation hooks are not delivered or privacy-core did not load.
import { resolvePrivacySettings, type PrivacySettings } from "./settings.js";
import { validatePrivacyConfig, type HostConfig } from "./validate.js";

export function privacySettingsFromConfig(config: HostConfig): PrivacySettings {
  return resolvePrivacySettings(config.plugins?.entries?.["privacy-core"]?.config);
}

/** A refusal message while the privacy config is unsafe, otherwise undefined. */
export function privacyConfigRefusal(config: HostConfig): string | undefined {
  const settings = privacySettingsFromConfig(config);
  if (settings.mode !== "private" && settings.residency !== "eu") {
    return undefined;
  }
  const issues = validatePrivacyConfig(config, settings);
  return issues.length === 0
    ? undefined
    : `the privacy config has ${issues.length} problem${issues.length === 1 ? "" : "s"}; run openclaw privacy status`;
}
