import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  markServiceDown,
  markServiceUp,
  resetServiceRegistryForTest,
} from "../../../shared/rules/service-registry.js";
import { resolvePrivacySettings } from "../../../shared/rules/settings.js";
import type { HostConfig } from "../../../shared/rules/validate.js";
import { createRunGate } from "./run-gate.js";

const safePrivate: HostConfig = {
  agents: {
    defaults: { model: "tinfoil/gpt-oss-120b", sandbox: { mode: "all" } },
    entries: {},
  },
  plugins: {
    allow: ["tinfoil", "a2a", "privacy-core"],
    entries: { "privacy-core": { hooks: { allowConversationAccess: true } } },
  },
  channels: { a2a: { enabled: true } },
  proxy: { proxyUrl: "http://127.0.0.1:19930" },
  browser: { evaluateEnabled: false },
  skills: { workshop: { autonomous: { mode: "off" }, approvalPolicy: "pending" } },
};

const privateGate = (config: HostConfig = safePrivate, extra: Record<string, unknown> = {}) =>
  createRunGate({
    settings: resolvePrivacySettings({ mode: "private", ...extra }),
    currentConfig: () => config,
  });

describe("privacy run gate", () => {
  beforeEach(() => {
    markServiceUp("privacy-egress-proxy", "http://127.0.0.1:19930");
    markServiceUp("tinfoil-attested-relay", "http://127.0.0.1:19931/v1");
    markServiceUp("privatemode-attested-relay", "http://127.0.0.1:19932/v1");
  });
  afterEach(() => resetServiceRegistryForTest());

  it("refuses every run while the config is unsafe and reports the issues once", () => {
    const reported: number[] = [];
    let config: HostConfig = { ...safePrivate, channels: { telegram: { enabled: true } } };
    const gate = createRunGate({
      settings: resolvePrivacySettings({ mode: "private" }),
      currentConfig: () => config,
      onIssues: (issues) => reported.push(issues.length),
    });
    const first = gate({}, { agentId: "inbox" });
    expect(first).toMatchObject({ outcome: "block", reason: "privacy-config" });
    expect(first?.message).toContain("openclaw privacy status");
    gate({}, { agentId: "inbox" });
    expect(reported).toEqual([1]);
    config = safePrivate;
    expect(
      gate({}, { agentId: "inbox", modelProviderId: "tinfoil", modelId: "gpt-oss-120b" }),
    ).toBeUndefined();
  });

  it("refuses a private run on a model that is not attested or local, or names no provider", () => {
    const gate = privateGate();
    expect(gate({}, { modelProviderId: "anthropic", modelId: "claude-opus-5" })).toMatchObject({
      reason: "privacy-model",
    });
    expect(gate({}, { modelProviderId: "ollama", modelId: "llama3" })).toBeUndefined();
    expect(gate({}, { modelProviderId: "ollama", modelId: "kimi-k2.5:cloud" })).toMatchObject({
      reason: "privacy-model",
    });
    expect(gate({}, {})).toMatchObject({ reason: "privacy-model" });
  });

  it("refuses runs while the egress proxy or the provider's relay is not up", () => {
    const gate = privateGate();
    markServiceDown("tinfoil-attested-relay", "listen EADDRINUSE 127.0.0.1:19931");
    expect(gate({}, { modelProviderId: "tinfoil", modelId: "gpt-oss-120b" })).toMatchObject({
      reason: "privacy-service",
      message: expect.stringContaining("EADDRINUSE"),
    });
    markServiceUp("tinfoil-attested-relay", "http://127.0.0.1:19931/v1");
    markServiceDown("privacy-egress-proxy", "stopped");
    expect(gate({}, { modelProviderId: "tinfoil", modelId: "gpt-oss-120b" })).toMatchObject({
      reason: "privacy-service",
    });
  });

  it("refuses a US model at run time on an EU-only gateway, private or standard", () => {
    const config: HostConfig = {
      ...safePrivate,
      agents: {
        defaults: { model: "privatemode/gpt-oss-120b", sandbox: { mode: "all" } },
        entries: {},
      },
      plugins: {
        allow: ["privatemode", "a2a", "privacy-core"],
        entries: { "privacy-core": { hooks: { allowConversationAccess: true } } },
      },
    };
    const gate = privateGate(config, { residency: "eu" });
    expect(gate({}, { modelProviderId: "privatemode" })).toBeUndefined();
    expect(gate({}, { modelProviderId: "tinfoil" })).toMatchObject({ reason: "privacy-residency" });
    const standard = createRunGate({
      settings: resolvePrivacySettings({
        residency: "eu",
        providers: { mistral: { region: "eu" } },
      }),
      currentConfig: () => ({ agents: { defaults: { model: "mistral/mistral-large-latest" } } }),
    });
    expect(standard({}, { modelProviderId: "mistral" })).toBeUndefined();
    expect(standard({}, { modelProviderId: "anthropic" })).toMatchObject({
      reason: "privacy-residency",
    });
  });
});
