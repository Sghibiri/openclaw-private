import { describe, expect, it, vi } from "vitest";
import type { PrivacyAuditEvent } from "../../../shared/audit.js";
import { listControls, releaseControl, takeControl } from "./control-methods.js";
import { createControlRegistry } from "./control.js";
import { createRequestHelpTool } from "./request-help-tool.js";

function harness() {
  const events: PrivacyAuditEvent[] = [];
  const controls = createControlRegistry();
  const deps = { controls, record: (event: PrivacyAuditEvent) => void events.push(event) };
  return { events, controls, deps };
}

describe("take-the-wheel gateway methods", () => {
  it("lets an operator take and release control, recording each transition once", () => {
    const { events, controls, deps } = harness();
    const respond = vi.fn();
    takeControl(deps, { params: { agentId: "browser" }, respond });
    expect(respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ agentId: "browser", changed: true }),
    );
    expect(controls.for("browser").humanMayDrive()).toBe(true);
    takeControl(deps, { params: { agentId: "browser" }, respond });
    expect(respond).toHaveBeenLastCalledWith(true, expect.objectContaining({ changed: false }));
    releaseControl(deps, { params: { agentId: "browser" }, respond });
    expect(controls.for("browser").humanMayDrive()).toBe(false);
    releaseControl(deps, { params: { agentId: "browser" }, respond });
    expect(events).toEqual([
      { kind: "control", agentId: "browser", event: "taken", by: "operator" },
      { kind: "control", agentId: "browser", event: "released", by: "operator" },
    ]);
    listControls(deps, { respond });
    expect(respond).toHaveBeenLastCalledWith(true, {
      controls: [{ agentId: "browser", state: expect.objectContaining({ holder: "agent" }) }],
    });
  });

  it("rejects a missing or malformed agent id without touching state", () => {
    const { controls, deps } = harness();
    const respond = vi.fn();
    takeControl(deps, { params: {}, respond });
    takeControl(deps, { params: { agentId: "../etc" }, respond });
    expect(respond).toHaveBeenCalledTimes(2);
    for (const call of respond.mock.calls) {
      expect(call[0]).toBe(false);
      expect(call[2]).toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(controls.list()).toEqual([]);
  });
});

describe("request_help tool", () => {
  it("raises the agent's hand, records it, and never changes the holder", async () => {
    const { events, controls } = harness();
    const tool = createRequestHelpTool({
      agentId: "browser",
      controls,
      record: (event) => void events.push(event),
    });
    const result = await tool.execute("call-1", { reason: "Login page needs the owner" });
    expect(result.details).toMatchObject({ ok: true, agentId: "browser", holder: "agent" });
    expect(controls.for("browser").get()).toMatchObject({
      holder: "agent",
      requested: true,
      reason: "Login page needs the owner",
    });
    expect(events).toEqual([
      { kind: "control", agentId: "browser", event: "help_requested", by: "agent" },
    ]);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("openclaw privacy control take browser"),
    });
  });

  it("refuses without an agent context", async () => {
    const { controls } = harness();
    const tool = createRequestHelpTool({ agentId: undefined, controls, record: () => {} });
    const result = await tool.execute("call-1", { reason: "x" });
    expect(result.details).toEqual({ ok: false, reason: "no_agent" });
    expect(controls.list()).toEqual([]);
  });
});
