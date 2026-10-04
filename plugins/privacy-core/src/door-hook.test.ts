import { describe, expect, it } from "vitest";
import type { PrivacyAuditEvent } from "../../../shared/audit.js";
import { createDoorReplyHook } from "./door-hook.js";

const MARKER = "SECRET_MARKER_123";

describe("door reply hook", () => {
  it("filters only A2A replies, drops non-text payload fields, and records the crossing", () => {
    const events: PrivacyAuditEvent[] = [];
    const hook = createDoorReplyHook({
      mode: "summary_only",
      record: (event) => events.push(event),
    });
    const result = hook({
      channel: "a2a",
      kind: "final",
      sessionKey: "agent:inbox:a2a:main-inbox",
      payload: { text: `Summary.\n\`\`\`\n${MARKER}\n\`\`\``, mediaUrls: ["file:///tmp/x.pdf"] },
    } as never);
    expect(result).toEqual({ payload: { text: "Summary.\n[raw output removed]" } });
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(JSON.stringify(result)).not.toContain("x.pdf");
    expect(events).toEqual([
      { kind: "boundary_crossing", from: "inbox", to: "a2a", bytes: 29, mode: "summary_only" },
    ]);
    expect(
      hook({ channel: "telegram", kind: "final", payload: { text: MARKER } } as never),
    ).toBeUndefined();
  });

  it("cancels every A2A reply in block mode", () => {
    const events: PrivacyAuditEvent[] = [];
    const hook = createDoorReplyHook({ mode: "block", record: (event) => events.push(event) });
    const result = hook({ channel: "a2a", kind: "final", payload: { text: MARKER } } as never);
    expect(result).toMatchObject({ cancel: true });
    expect(events[0]).toMatchObject({ kind: "boundary_crossing", bytes: 0, mode: "block" });
  });
});
