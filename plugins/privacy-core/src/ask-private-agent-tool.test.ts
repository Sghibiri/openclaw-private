import { describe, expect, it, vi } from "vitest";
import { createAskPrivateAgentTool } from "./ask-private-agent-tool.js";

const MARKER = "SECRET_MARKER_123";

function a2aResponse(text: string, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      result: {
        task: {
          id: "t1",
          status: { state: "TASK_STATE_COMPLETED" },
          artifacts: [{ artifactId: "a", parts: [{ text }, { data: { raw: MARKER } }] }],
          ...extra,
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("ask_private_agent tool", () => {
  it("sends a blocking A2A task and returns only the text answer", async () => {
    const fetchImpl = vi.fn(async () =>
      a2aResponse("Two urgent emails: Rossi invoice, Bianchi contract."),
    );
    const tool = createAskPrivateAgentTool({
      peers: [{ name: "inbox", url: "http://127.0.0.1:19789/a2a/v1", outboundToken: "tok" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await tool.execute("call-1", { agent: "inbox", question: "What is urgent?" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:19789/a2a/v1");
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params: { message: { parts: unknown[] }; configuration?: unknown };
    };
    expect(body.method).toBe("SendMessage");
    expect(body.params.configuration).toBeUndefined();
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
    expect(result.content).toEqual([
      { type: "text", text: "Two urgent emails: Rossi invoice, Bianchi contract." },
    ]);
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it("refuses unknown peers without sending anything", async () => {
    const fetchImpl = vi.fn();
    const tool = createAskPrivateAgentTool({
      peers: [{ name: "inbox", url: "http://127.0.0.1:19789/a2a/v1" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await tool.execute("call-2", { agent: "browser", question: "hi" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ ok: false, reason: "unknown_peer" });
  });
});
