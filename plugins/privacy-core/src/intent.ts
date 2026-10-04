// Maps OpenClaw tool calls onto the policy context: what the action does,
// rather than which tool was called. Derived here for every call so a new tool
// cannot arrive without an intent and fall outside every rule written in terms
// of one. Adapted from OpenBot's `intentOf` (MIT, (c) 2026 CopilotKit).
import type { PolicyContext, PolicyIntent } from "./policy.js";

const ACTIVATING_KEYS = new Set(["Enter", "NumpadEnter", "Space", " "]);
const BROWSER_READ_ACTIONS = new Set([
  "doctor",
  "status",
  "tabs",
  "snapshot",
  "screenshot",
  "console",
  "requests",
  "errors",
  "text",
  "pdf",
  "focus",
]);
const BROWSER_ACT_ACTIVATE_KINDS = new Set(["click", "clickCoords", "select", "drag"]);
const BROWSER_ACT_TYPE_KINDS = new Set(["type", "fill"]);
const BROWSER_ACT_READ_KINDS = new Set(["hover", "scrollIntoView", "wait", "resize"]);
const WRITE_FILE_TOOLS = new Set(["write", "edit", "apply_patch"]);
const READ_FILE_TOOLS = new Set(["read"]);
const LIST_FILE_TOOLS = new Set(["ls", "list_dir"]);
const COMMAND_TOOLS = new Set(["exec", "process", "gateway_exec", "gateway_process"]);

function readString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value : "";
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function describeFile(filePath: string): PolicyContext["file"] {
  const normalized = filePath.replace(/\\/gu, "/");
  const name = normalized.split("/").findLast((segment) => segment.length > 0) ?? "";
  const dot = name.lastIndexOf(".");
  return {
    path: filePath,
    name,
    extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
  };
}

/** MCP tool names offered by OpenClaw look like `mcp__<server>__<tool>`. */
function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  const match = /^mcp__([^_](?:.*?))__(.+)$/u.exec(toolName);
  return match ? { server: match[1] ?? "", tool: match[2] ?? "" } : null;
}

const MCP_READ_TOOL_RE = /^(get|list|read|search|fetch|find|query|describe|show|view)/iu;

export type IntentSubject = {
  intent: PolicyIntent | "";
  page: PolicyContext["page"];
  element: PolicyContext["element"];
  key: string;
  file: PolicyContext["file"];
  command: string;
  mcp: PolicyContext["mcp"];
};

const NEUTRAL: IntentSubject = {
  intent: "",
  page: { url: "", host: "" },
  element: { ref: "", role: "", name: "", type: "" },
  key: "",
  file: { path: "", name: "", extension: "" },
  command: "",
  mcp: { server: "", tool: "", effect: "" },
};

export function resolveIntentSubject(
  toolName: string,
  params: Record<string, unknown>,
  derivedPaths?: readonly string[],
): IntentSubject {
  if (toolName === "browser") {
    const action = readString(params, "action");
    const url = readString(params, "url") || readString(params, "targetUrl");
    const page = { url, host: hostOf(url) };
    const element = { ref: readString(params, "ref"), role: "", name: "", type: "" };
    if (action === "navigate" || action === "open") {
      return { ...NEUTRAL, intent: "navigate", page, element };
    }
    if (action === "act") {
      const kind = readString(params, "kind");
      const key = readString(params, "key");
      const submit = params.submit === true;
      if (kind === "press") {
        return {
          ...NEUTRAL,
          intent: ACTIVATING_KEYS.has(key) ? "activate" : "type",
          page,
          element,
          key,
        };
      }
      if (BROWSER_ACT_TYPE_KINDS.has(kind)) {
        return {
          ...NEUTRAL,
          intent: submit ? "activate" : "type",
          page,
          element,
          key: submit ? "Enter" : "",
        };
      }
      if (BROWSER_ACT_ACTIVATE_KINDS.has(kind)) {
        return { ...NEUTRAL, intent: "activate", page, element };
      }
      if (BROWSER_ACT_READ_KINDS.has(kind)) {
        return { ...NEUTRAL, intent: "read", page, element };
      }
      // evaluate, batch, close and unknown kinds are treated as activations: they can change the page.
      return { ...NEUTRAL, intent: "activate", page, element };
    }
    if (action === "upload" || action === "download" || action === "waitfordownload") {
      return { ...NEUTRAL, intent: "write_file", page, element };
    }
    if (BROWSER_READ_ACTIONS.has(action)) {
      return { ...NEUTRAL, intent: "read", page, element };
    }
    // start, stop, close, profiles, importprofile, emulate, dialog: state changes.
    return { ...NEUTRAL, intent: "activate", page, element };
  }
  if (COMMAND_TOOLS.has(toolName)) {
    return { ...NEUTRAL, intent: "run_command", command: readString(params, "command") };
  }
  if (WRITE_FILE_TOOLS.has(toolName)) {
    const path =
      readString(params, "path") || readString(params, "file") || derivedPaths?.[0] || "";
    return { ...NEUTRAL, intent: "write_file", file: describeFile(path) };
  }
  if (READ_FILE_TOOLS.has(toolName)) {
    return { ...NEUTRAL, intent: "read_file", file: describeFile(readString(params, "path")) };
  }
  if (LIST_FILE_TOOLS.has(toolName)) {
    return { ...NEUTRAL, intent: "list_files", file: describeFile(readString(params, "path")) };
  }
  const mcp = parseMcpToolName(toolName);
  if (mcp) {
    // Anything not positively known to be a read is a write.
    const effect = MCP_READ_TOOL_RE.test(mcp.tool) ? "read" : "write";
    return {
      ...NEUTRAL,
      intent: effect === "read" ? "read_tool" : "write_tool",
      mcp: { ...mcp, effect },
    };
  }
  return NEUTRAL;
}
