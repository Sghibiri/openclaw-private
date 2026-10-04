import { describe, expect, it } from "vitest";
import { privacyConfigRefusal } from "./guard.js";

describe("privacyConfigRefusal", () => {
  it("is silent without a privacy posture", () => {
    expect(
      privacyConfigRefusal({ agents: { defaults: { model: "anthropic/claude-opus-5" } } }),
    ).toBe(undefined);
  });

  it("refuses while a private config is unsafe, reading privacy-core's settings from the host config", () => {
    const refusal = privacyConfigRefusal({
      agents: { defaults: { model: "anthropic/claude-opus-5", sandbox: { mode: "all" } } },
      plugins: {
        allow: ["privacy-core"],
        entries: {
          "privacy-core": {
            hooks: { allowConversationAccess: false },
            config: { mode: "private" },
          },
        },
      },
      proxy: { proxyUrl: "http://127.0.0.1:19930" },
      browser: { evaluateEnabled: false },
      skills: { workshop: { autonomous: { mode: "off" }, approvalPolicy: "pending" } },
    });
    expect(refusal).toMatch(/the privacy config has \d+ problems; run openclaw privacy status/u);
  });
});
