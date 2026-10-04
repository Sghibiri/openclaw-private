import { describe, expect, it } from "vitest";
import { agentIdFromSessionKey, filterOutboundText } from "./boundary.js";

const MARKER = "SECRET_MARKER_123";

describe("boundary edge filter", () => {
  it("drops fenced tool output, quoted email, untrusted envelopes and base64 attachments", () => {
    const raw = [
      "Three emails need you today.",
      "```json",
      `{"body": "${MARKER}"}`,
      "```",
      `> Original message: ${MARKER}`,
      `<<<EXTERNAL_UNTRUSTED_CONTENT id="ab12">>>page dump ${MARKER}<<<END_EXTERNAL_UNTRUSTED_CONTENT id="ab12">>>`,
      `<tool_result>${MARKER}</tool_result>`,
      `attachment: ${"QUJD".repeat(40)}`,
      "The invoice from Rossi is overdue.",
    ].join("\n");
    const result = filterOutboundText(raw, { mode: "summary_only" });
    expect(result).not.toBeNull();
    expect(result!.text).not.toContain(MARKER);
    expect(result!.text).not.toContain("QUJDQUJD");
    expect(result!.text).toContain("Three emails need you today.");
    expect(result!.text).toContain("The invoice from Rossi is overdue.");
    expect(result!.dropped).toMatchObject({
      fenced: 1,
      quoted: 1,
      untrusted: 2,
      base64: 1,
      truncated: false,
    });
    expect(result!.bytesOut).toBeLessThan(result!.bytesIn);
  });

  it("caps the answer length and reports truncation", () => {
    const result = filterOutboundText("many words ".repeat(500), {
      mode: "summary_only",
      maxChars: 1000,
    });
    expect(result!.dropped.truncated).toBe(true);
    expect(result!.text.length).toBeLessThan(1100);
    expect(result!.text).toContain("truncated at 1000");
  });

  it("answers nothing in block mode", () => {
    expect(filterOutboundText("anything", { mode: "block" })).toBeNull();
  });

  it("reads the agent id from a session key", () => {
    expect(agentIdFromSessionKey("agent:inbox:main")).toBe("inbox");
    expect(agentIdFromSessionKey(undefined)).toBe("");
  });
});
