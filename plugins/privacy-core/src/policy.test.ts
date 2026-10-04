import { describe, expect, it } from "vitest";
import {
  evaluateActionPolicy,
  PRIVATE_DEFAULT_ACTION_POLICY,
  resolveActionPolicy,
  STANDARD_DEFAULT_ACTION_POLICY,
  type PolicyContext,
} from "./policy.js";

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    tool: { name: "browser" },
    agent: { id: "browser" },
    page: { url: "https://mail.google.com/", host: "mail.google.com" },
    element: { ref: "e12", role: "button", name: "Send", type: "" },
    key: "",
    intent: "activate",
    file: { path: "", name: "", extension: "" },
    command: "",
    mcp: { server: "", tool: "", effect: "" },
    approval: { granted: false },
    initiator: { kind: "person", id: "" },
    ...overrides,
  };
}

describe("evaluateActionPolicy", () => {
  it("denies when no policy exists", () => {
    const decision = evaluateActionPolicy(null, context());
    expect(decision).toMatchObject({ allowed: false, forward: false, source: "default" });
  });

  it("evaluates deny before allow and names the rule", () => {
    const decision = evaluateActionPolicy(
      { mode: "enforce", deny: ['contains(element.name, "send")'], approve: [], allow: ["true"] },
      context(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.matched).toBe('contains(element.name, "send")');
    expect(decision.reason).toContain('"Send" on mail.google.com');
  });

  it("dry-run records the refusal and still forwards", () => {
    const decision = evaluateActionPolicy(
      { mode: "dry-run", deny: ["true"], approve: [], allow: [] },
      context(),
    );
    expect(decision).toMatchObject({ allowed: false, forward: true, source: "deny" });
  });

  it("treats a broken or non-boolean deny as a match and a broken allow as no match", () => {
    const problems: string[] = [];
    const broken = evaluateActionPolicy(
      { mode: "enforce", deny: ['"Submit order"'], approve: [], allow: ["true"] },
      context(),
      { onExpressionProblem: (problem) => problems.push(problem.error) },
    );
    expect(broken.source).toBe("deny");
    const unbound = evaluateActionPolicy(
      { mode: "enforce", deny: [], approve: [], allow: ["nonexistent == 1"] },
      context(),
    );
    expect(unbound.source).toBe("default");
    expect(problems[0]).toContain("expected a true or false answer");
  });

  it("asks for approval on write-shaped actions in the private default and not for reads", () => {
    const write = evaluateActionPolicy(PRIVATE_DEFAULT_ACTION_POLICY, context());
    expect(write).toMatchObject({ needsApproval: true, forward: false, source: "approve" });
    const read = evaluateActionPolicy(PRIVATE_DEFAULT_ACTION_POLICY, context({ intent: "read" }));
    expect(read).toMatchObject({ allowed: true, needsApproval: false });
    const granted = evaluateActionPolicy(
      PRIVATE_DEFAULT_ACTION_POLICY,
      context({ approval: { granted: true } }),
    );
    expect(granted).toMatchObject({ allowed: true, needsApproval: false });
  });

  it("standard default permits and a command rule can still refuse a shell", () => {
    expect(evaluateActionPolicy(STANDARD_DEFAULT_ACTION_POLICY, context()).allowed).toBe(true);
    const decision = evaluateActionPolicy(
      resolveActionPolicy({
        privateMode: false,
        configured: { deny: ['contains(command, "rm -rf")'] },
      }),
      context({ tool: { name: "exec" }, intent: "run_command", command: "rm -rf /" }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("rm -rf /");
    // A rule naming `command` must not refuse a click: fields are neutral, never absent.
    expect(
      evaluateActionPolicy(
        resolveActionPolicy({
          privateMode: false,
          configured: { deny: ['contains(command, "rm -rf")'] },
        }),
        context(),
      ).allowed,
    ).toBe(true);
  });

  it("matches() with a broken regex fails closed on deny", () => {
    const decision = evaluateActionPolicy(
      { mode: "enforce", deny: ['matches(page.host, "[")'], approve: [], allow: ["true"] },
      context(),
    );
    expect(decision.source).toBe("deny");
  });
});
