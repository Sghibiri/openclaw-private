// Privatemode plugin registration: provider on the loopback relay, relay as a service.
import { describe, expect, it } from "vitest";
import { capturePlugin } from "../../test/fake-plugin-api.js";
import plugin from "./index.js";
import { PRIVATEMODE_BASE_URL } from "./models.js";

describe("privatemode provider plugin", () => {
  it("serves the provider from the loopback relay, never straight from Privatemode", () => {
    const captured = capturePlugin(plugin);
    const provider = captured.first<{ id: string; label: string; createModelFetch?: unknown }>(
      "registerProvider",
    );
    expect(provider.id).toBe("privatemode");
    expect(provider.label).toBe("Privatemode");
    expect(provider.createModelFetch).toBeUndefined();
    expect(PRIVATEMODE_BASE_URL).toBe("http://127.0.0.1:19932/v1");
    expect(captured.all<{ id: string }>("registerService").map((s) => s.id)).toEqual([
      "privatemode-attested-relay",
    ]);
  });
});
