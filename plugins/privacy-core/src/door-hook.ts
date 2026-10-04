import type {
  PluginHookReplyPayloadSendingEvent,
  PluginHookReplyPayloadSendingResult,
} from "openclaw/plugin-sdk/core";
// The private side of the door: every reply that leaves through the A2A
// channel passes the edge filter and is recorded as a boundary crossing.
import type { PrivacyAuditEvent } from "../../../shared/audit.js";
import { agentIdFromSessionKey, filterOutboundText, type BoundaryMode } from "./boundary.js";

export const DOOR_CHANNEL = "a2a";

export type DoorHookOptions = {
  mode: BoundaryMode;
  maxChars?: number;
  record: (event: PrivacyAuditEvent) => void;
};

export function createDoorReplyHook(options: DoorHookOptions) {
  return (
    event: PluginHookReplyPayloadSendingEvent,
  ): PluginHookReplyPayloadSendingResult | void => {
    if (event.channel !== DOOR_CHANNEL) {
      return undefined;
    }
    const from = agentIdFromSessionKey(event.sessionKey);
    const text = typeof event.payload.text === "string" ? event.payload.text : "";
    const filtered = filterOutboundText(text, { mode: options.mode, maxChars: options.maxChars });
    if (!filtered) {
      options.record({
        kind: "boundary_crossing",
        from,
        to: DOOR_CHANNEL,
        bytes: 0,
        mode: options.mode,
      });
      return {
        cancel: true,
        reason:
          "privacy.boundary.mode is block: this private gateway does not answer external callers",
      };
    }
    options.record({
      kind: "boundary_crossing",
      from,
      to: DOOR_CHANNEL,
      bytes: filtered.bytesOut,
      mode: options.mode,
    });
    // Only text leaves. Media, attachments and any other payload fields are dropped at the door.
    return { payload: { text: filtered.text } };
  };
}
