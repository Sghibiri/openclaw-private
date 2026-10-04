import { describe, expect, it } from "vitest";
import type { PrivacyAuditEvent } from "../../../shared/audit.js";
import { createActionGatewayPolicy } from "./action-gateway.js";
import { createControlRegistry, HUMAN_HAS_CONTROL } from "./control.js";
import { PRIVATE_DEFAULT_ACTION_POLICY, resolveActionPolicy } from "./policy.js";

function gateway(params: { privateMode: boolean; deny?: string[]; approvalGranted?: boolean }) {
  const events: PrivacyAuditEvent[] = [];
  const controls = createControlRegistry();
  const policy = createActionGatewayPolicy({
    resolvePolicy: () =>
      resolveActionPolicy({
        privateMode: params.privateMode,
        configured: params.deny ? { deny: params.deny } : undefined,
      }),
    controls,
    record: (event) => events.push(event),
    resolveApprovalGranted: () => params.approvalGranted ?? false,
  });
  return { policy, events, controls };
}

const ctx = { agentId: "inbox", toolName: "exec", sessionKey: "agent:inbox:main" };

describe("privacy action gateway", () => {
  it("refuses a write action without approval on a private gateway and names the rule", async () => {
    const { policy, events } = gateway({ privateMode: true });
    const result = await policy.evaluate(
      { toolName: "exec", params: { command: "gog gmail send --to x" } },
      ctx,
    );
    expect(result).toMatchObject({ requireApproval: { severity: "warning" } });
    expect(events).toEqual([
      expect.objectContaining({
        kind: "action",
        tool: "exec",
        intent: "run_command",
        agentId: "inbox",
        command: "gog gmail send --to x",
        outcome: "approval_required",
        rule: PRIVATE_DEFAULT_ACTION_POLICY.approve[0],
        source: "approve",
      }),
    ]);
  });

  it("records the decision before allowing a read", async () => {
    const { policy, events } = gateway({ privateMode: true });
    const result = await policy.evaluate(
      { toolName: "read", params: { path: "notes/todo.md" } },
      ctx,
    );
    expect(result).toBeUndefined();
    expect(events).toEqual([
      expect.objectContaining({ intent: "read_file", file: "notes/todo.md", outcome: "allowed" }),
    ]);
  });

  it("blocks on a deny rule with the rule in the audit row", async () => {
    const { policy, events } = gateway({
      privateMode: false,
      deny: ['intent == "navigate" && !contains(page.host, "googleapis.com")'],
    });
    const result = await policy.evaluate(
      { toolName: "browser", params: { action: "navigate", url: "https://evil.example/login" } },
      { ...ctx, toolName: "browser" },
    );
    expect(result).toMatchObject({ block: true });
    expect((result as { blockReason?: string }).blockReason).toContain("evil.example");
    expect(events[0]).toMatchObject({ outcome: "refused", host: "evil.example", source: "deny" });
  });

  it("lets approved writes through", async () => {
    const { policy } = gateway({ privateMode: true, approvalGranted: true });
    expect(
      await policy.evaluate({ toolName: "write", params: { path: "a.txt" } }, ctx),
    ).toBeUndefined();
  });

  it("refuses agent actions while a person holds the wheel, but not reads", async () => {
    const { policy, controls, events } = gateway({ privateMode: false });
    controls.for("inbox").take();
    const blocked = await policy.evaluate({ toolName: "exec", params: { command: "ls" } }, ctx);
    expect(blocked).toEqual({ block: true, blockReason: HUMAN_HAS_CONTROL });
    expect(events[0]).toMatchObject({ outcome: "human_has_control" });
    expect(
      await policy.evaluate(
        { toolName: "browser", params: { action: "snapshot" } },
        { ...ctx, toolName: "browser" },
      ),
    ).toBeUndefined();
    controls.for("inbox").release();
    expect(
      await policy.evaluate({ toolName: "exec", params: { command: "ls" } }, ctx),
    ).toBeUndefined();
  });

  it("leaves ungoverned tools alone without an audit row", async () => {
    const { policy, events } = gateway({ privateMode: true });
    expect(await policy.evaluate({ toolName: "session_status", params: {} }, ctx)).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("classifies MCP tools by effect and browser gestures by intent", async () => {
    const { policy, events } = gateway({ privateMode: true });
    await policy.evaluate({ toolName: "mcp__jira__listIssues", params: {} }, ctx);
    await policy.evaluate({ toolName: "mcp__jira__editIssue", params: {} }, ctx);
    await policy.evaluate(
      { toolName: "browser", params: { action: "act", kind: "press", key: "Enter", ref: "e3" } },
      { ...ctx, toolName: "browser" },
    );
    await policy.evaluate(
      { toolName: "browser", params: { action: "act", kind: "type", text: "hello", ref: "e3" } },
      { ...ctx, toolName: "browser" },
    );
    expect(events.map((event) => (event as { intent: string; outcome: string }).intent)).toEqual([
      "read_tool",
      "write_tool",
      "activate",
      "type",
    ]);
    expect(events.map((event) => (event as { outcome: string }).outcome)).toEqual([
      "allowed",
      "approval_required",
      "approval_required",
      "approval_required",
    ]);
    // Typed text never appears in the audit row.
    expect(JSON.stringify(events)).not.toContain("hello");
  });

  it("refuses every tool call, governed or not, while the privacy config is unsafe", async () => {
    const events: PrivacyAuditEvent[] = [];
    const policy = createActionGatewayPolicy({
      resolvePolicy: () => resolveActionPolicy({ privateMode: true }),
      controls: createControlRegistry(),
      record: (event) => events.push(event),
      refuseAll: () => "the privacy config has 1 problem; run openclaw privacy status",
    });
    for (const toolName of ["read", "exec", "web_search"]) {
      expect(await policy.evaluate({ toolName, params: {} }, ctx)).toMatchObject({
        block: true,
        blockReason: "Refused: the privacy config has 1 problem; run openclaw privacy status.",
      });
    }
  });
});
