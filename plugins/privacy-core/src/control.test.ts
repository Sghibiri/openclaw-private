import { describe, expect, it } from "vitest";
import {
  ControlError,
  ControlRequestError,
  createControl,
  HELP_REQUEST_TTL_MS,
} from "./control.js";

describe("control handoff", () => {
  it("lets the agent ask for help and expires the request", () => {
    let clock = Date.parse("2026-09-19T10:00:00.000Z");
    const control = createControl(() => new Date(clock).toISOString());
    control.requestHelp("Login wall on mail.google.com");
    expect(control.get()).toMatchObject({
      holder: "agent",
      requested: true,
      reason: "Login wall on mail.google.com",
    });
    clock += HELP_REQUEST_TTL_MS + 1;
    expect(control.get().requested).toBe(false);
  });

  it("refuses agent actions while a person drives and never times the person out", () => {
    let clock = Date.parse("2026-09-19T10:00:00.000Z");
    const control = createControl(() => new Date(clock).toISOString());
    control.requestHelp("2FA");
    control.take();
    expect(() => control.assertAgentMayAct()).toThrow(ControlError);
    clock += HELP_REQUEST_TTL_MS * 10;
    expect(control.get().holder).toBe("human");
    control.release();
    expect(() => control.assertAgentMayAct()).not.toThrow();
  });

  it("requires a ref for a secret request and clears it once supplied", () => {
    const control = createControl();
    expect(() => control.requestSecret({ label: "password" })).toThrow(ControlRequestError);
    control.requestSecret({ label: "password", ref: "e9" });
    expect(control.pendingSecret()).toEqual({ ref: "e9" });
    control.secretSupplied();
    expect(control.pendingSecret()).toBeNull();
    expect(JSON.stringify(control.get())).not.toContain("hunter2");
  });
});
