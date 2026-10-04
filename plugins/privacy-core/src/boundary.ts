// The door's edge filter: what a private gateway may answer to an external caller.
//
// `summary_only` keeps the agent's own prose and drops everything that looks
// like raw material: fenced blocks (tool output, code, logs), quoted lines
// (email bodies), untrusted-content envelopes (fetched pages, wrapped tool
// results), long base64 runs (attachments), then caps the length. `block`
// answers nothing. This stops bulk and accidental leakage; it cannot stop a
// private model that was tricked into repeating a secret in its own prose.
import { BOUNDARY_DEFAULT_MAX_CHARS } from "../../../shared/rules/settings.js";
export type BoundaryMode = "summary_only" | "block";

export type BoundaryFilterResult = {
  text: string;
  bytesIn: number;
  bytesOut: number;
  dropped: {
    fenced: number;
    quoted: number;
    untrusted: number;
    base64: number;
    truncated: boolean;
  };
};

const FENCED_BLOCK_RE = /```[\s\S]*?(?:```|$)/gu;
const UNTRUSTED_ENVELOPE_RE =
  /<<<\s*EXTERNAL[\s_]+UNTRUSTED[\s_]+CONTENT[^>]*>>>[\s\S]*?(?:<<<\s*END[\s_]+EXTERNAL[\s_]+UNTRUSTED[\s_]+CONTENT[^>]*>>>|$)/giu;
const UNTRUSTED_TAG_RE =
  /<(?:untrusted|external_content|tool_result|function_results?)[^>]*>[\s\S]*?<\/(?:untrusted|external_content|tool_result|function_results?)>/giu;
const BASE64_RUN_RE = /(?:[A-Za-z0-9+/]{64,}={0,2})/gu;
const QUOTED_LINE_RE = /^\s*>.*$/gmu;

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

export function filterOutboundText(
  input: string,
  options: { mode: BoundaryMode; maxChars?: number },
): BoundaryFilterResult | null {
  const bytesIn = Buffer.byteLength(input, "utf8");
  if (options.mode === "block") {
    return null;
  }
  const maxChars = options.maxChars ?? BOUNDARY_DEFAULT_MAX_CHARS;
  let text = input;
  const dropped = { fenced: 0, quoted: 0, untrusted: 0, base64: 0, truncated: false };
  dropped.untrusted =
    countMatches(text, UNTRUSTED_ENVELOPE_RE) + countMatches(text, UNTRUSTED_TAG_RE);
  text = text.replace(UNTRUSTED_ENVELOPE_RE, "[external content removed]");
  text = text.replace(UNTRUSTED_TAG_RE, "[external content removed]");
  dropped.fenced = countMatches(text, FENCED_BLOCK_RE);
  text = text.replace(FENCED_BLOCK_RE, "[raw output removed]");
  dropped.quoted = countMatches(text, QUOTED_LINE_RE);
  text = text.replace(QUOTED_LINE_RE, "[quoted text removed]");
  dropped.base64 = countMatches(text, BASE64_RUN_RE);
  text = text.replace(BASE64_RUN_RE, "[attachment removed]");
  text = text.replace(/\n{3,}/gu, "\n\n").trim();
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars).trimEnd()}\n[answer truncated at ${maxChars} characters by the private gateway]`;
    dropped.truncated = true;
  }
  return { text, bytesIn, bytesOut: Buffer.byteLength(text, "utf8"), dropped };
}

export function agentIdFromSessionKey(sessionKey: string | undefined): string {
  const match = /^agent:([^:]+):/u.exec(sessionKey ?? "");
  return match?.[1] ?? "";
}
