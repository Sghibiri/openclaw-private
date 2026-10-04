// The main side of the door: ask a private agent a question over A2A and
// receive only its text answer. This is the one way a standard agent reaches
// a private one. Raw email, tool output and attachments never cross; the
// private gateway strips them before answering.
import { randomUUID } from "node:crypto";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { Type } from "typebox";

export type DoorPeer = { name: string; url: string; outboundToken?: string };

export type AskPrivateAgentToolOptions = {
  peers: DoorPeer[];
  timeoutMs?: number;
  maxAnswerChars?: number;
  fetchImpl?: typeof fetch;
};

export const ASK_PRIVATE_AGENT_TOOL_NAME = "ask_private_agent";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ANSWER_CHARS = 8000;
const MAX_RESPONSE_BYTES = 1_048_576;

const AskPrivateAgentSchema = Type.Object({
  agent: Type.String({ description: "Private agent to ask (a configured door peer name)." }),
  question: Type.String({
    description: "What you need from it. It answers with a short text summary only.",
  }),
});

type A2aTaskResponse = {
  result?: {
    task?: {
      status?: { state?: string };
      artifacts?: Array<{ parts?: Array<{ text?: unknown }> }>;
    };
  };
  error?: { code?: number; message?: string };
};

function extractAnswer(response: A2aTaskResponse): { state: string; text: string } {
  const task = response.result?.task;
  const state = task?.status?.state ?? "unknown";
  const text = (task?.artifacts ?? [])
    .flatMap((artifact) => artifact.parts ?? [])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  return { state, text };
}

export function createAskPrivateAgentTool(options: AskPrivateAgentToolOptions): AnyAgentTool {
  const peers = new Map(options.peers.map((peer) => [peer.name, peer]));
  const peerNames = [...peers.keys()].toSorted();
  return {
    label: "Ask private agent",
    name: ASK_PRIVATE_AGENT_TOOL_NAME,
    description:
      "Ask one of the private agents (they hold email, logins and documents you cannot see) a question. " +
      `You receive a short text answer only; never raw data. Available: ${peerNames.join(", ") || "none configured"}.`,
    parameters: AskPrivateAgentSchema,
    execute: async (_toolCallId, args) => {
      const params = args as { agent?: unknown; question?: unknown };
      const agent = typeof params.agent === "string" ? params.agent.trim() : "";
      const question = typeof params.question === "string" ? params.question.trim() : "";
      const peer = peers.get(agent);
      if (!peer) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown private agent "${agent}". Configured: ${peerNames.join(", ") || "none"}.`,
            },
          ],
          details: { ok: false, reason: "unknown_peer" },
        };
      }
      if (!question) {
        return {
          content: [{ type: "text", text: "Ask a question." }],
          details: { ok: false, reason: "empty_question" },
        };
      }
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const request = {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "SendMessage",
        params: {
          message: {
            messageId: randomUUID(),
            role: "ROLE_USER",
            contextId: `ctx-oc-door-${peer.name}`,
            parts: [{ text: question }],
          },
        },
      };
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (peer.outboundToken) {
        headers.authorization = `Bearer ${peer.outboundToken}`;
      }
      const { response, release } = await fetchWithSsrFGuard({
        url: peer.url,
        timeoutMs,
        policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(peer.url),
        auditContext: "privacy.door.ask",
        maxRedirects: 0,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        init: { method: "POST", headers, body: JSON.stringify(request) },
      });
      try {
        if (!response.ok) {
          throw new Error(`private gateway "${peer.name}" answered HTTP ${response.status}`);
        }
        const raw = await response.text();
        if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
          throw new Error(`private gateway "${peer.name}" answered with an oversized response`);
        }
        const parsed = JSON.parse(raw) as A2aTaskResponse;
        if (parsed.error) {
          throw new Error(
            `private gateway "${peer.name}" refused: ${parsed.error.message ?? "error"}`,
          );
        }
        const { state, text } = extractAnswer(parsed);
        const maxChars = options.maxAnswerChars ?? DEFAULT_MAX_ANSWER_CHARS;
        const answer = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
        return {
          content: [
            {
              type: "text",
              text:
                answer || `The private agent "${peer.name}" gave no answer (task state ${state}).`,
            },
          ],
          details: { ok: Boolean(answer), agent: peer.name, state, chars: answer.length },
        };
      } finally {
        await release();
      }
    },
  };
}
