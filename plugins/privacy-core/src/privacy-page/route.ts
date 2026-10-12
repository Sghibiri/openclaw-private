// The Privacy tab in the dashboard sidebar and the page behind it.
//
// Stock OpenClaw shows a plugin tab's `path` in a sandboxed frame and lets the
// signed-in operator read it through the gateway's own auth; no Labs setting is
// needed. The page is read-only and script-free, so the strict CSP below holds.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PrivacyOverview } from "./overview.js";
import { renderPrivacyPage } from "./render.js";
import { loadPrivacyOverview } from "./sources.js";

export const PRIVACY_PAGE_PATH = "/plugins/privacy-core/privacy";
const PAGE_TIMEOUT_MS = 10_000;

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function createPrivacyPageHandler(deps: {
  load: (signal: AbortSignal) => Promise<PrivacyOverview>;
  clock: () => Date;
  onError: (message: string) => void;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
      res.end("Only reading is allowed here.\n");
      return true;
    }
    const closed = new AbortController();
    res.once("close", () => closed.abort());
    try {
      const now = deps.clock();
      const overview = await deps.load(
        AbortSignal.any([closed.signal, AbortSignal.timeout(PAGE_TIMEOUT_MS)]),
      );
      const html = renderPrivacyPage(overview, { now });
      res.writeHead(200, PAGE_HEADERS);
      res.end(req.method === "HEAD" ? undefined : html);
    } catch (error) {
      deps.onError(
        `privacy page could not be built: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!res.headersSent) {
        res.writeHead(500, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
      }
      res.end("The Privacy page could not be built. The gateway log says why.\n");
    }
    return true;
  };
}

export function registerPrivacyPage(
  api: OpenClawPluginApi,
  options: { mode: "standard" | "private"; currentConfig: () => unknown; clock?: () => Date },
): void {
  const clock = options.clock ?? (() => new Date());
  api.session.controls.registerControlUiDescriptor({
    id: "privacy",
    surface: "tab",
    label: "Privacy",
    description: "Who reads your email, on which model, and proof it stays private",
    slug: "privacy",
    icon: "shield",
    path: PRIVACY_PAGE_PATH,
    requiredScopes: ["operator.read"],
  });
  api.registerHttpRoute({
    path: PRIVACY_PAGE_PATH,
    auth: "gateway",
    match: "exact",
    handler: createPrivacyPageHandler({
      load: (signal) =>
        loadPrivacyOverview({
          mode: options.mode,
          ownConfig: options.currentConfig(),
          now: clock(),
          signal,
        }),
      clock,
      onError: (message) => api.logger.error(message),
    }),
  });
}
