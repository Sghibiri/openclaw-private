# Privacy page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only "Privacy" sidebar page on both dashboards that says, in plain words, who reads email, on which model, whether it is protected and verified, and what came back.

**Architecture:** Privacy Core registers a tab descriptor and a gateway-authenticated HTTP route. The route reads metadata (both configs, the private audit log, the private gateway's `/readyz`) into a pure `PrivacyOverview`, renders it to script-free HTML and serves it with a strict CSP. Spec: `docs/superpowers/specs/2026-10-12-privacy-page-design.md`.

**Tech Stack:** TypeScript (strict), Node `http` types, Vitest, stock OpenClaw plugin SDK (`plugin-entry`, `state-paths`).

---

## File structure

| File                                                                                            | Responsibility                                                                        |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `plugins/privacy-core/src/privacy-page/overview.ts`                                             | Pure: configs + audit rows + reachability + clock → `PrivacyOverview`                 |
| `plugins/privacy-core/src/privacy-page/render.ts`                                               | Pure: `PrivacyOverview` + clock/time zone → HTML string                               |
| `plugins/privacy-core/src/privacy-page/sources.ts`                                              | I/O: resolve the two state dirs, read config JSON and the audit tail, probe `/readyz` |
| `plugins/privacy-core/src/privacy-page/route.ts`                                                | Registers the tab and the route; GET/HEAD → page, else 405                            |
| `plugins/privacy-core/src/privacy-page/privacy-page.test.ts`                                    | Tests for the three units above                                                       |
| `plugins/privacy-core/index.ts`                                                                 | Calls `registerPrivacyPage`                                                           |
| `test/fake-plugin-api.ts`                                                                       | Records `session.controls.registerControlUiDescriptor`                                |
| versions: root/3 plugin `package.json`, `package-lock.json` workspace entries, `src/version.ts` | 0.2.0 → 0.3.0                                                                         |
| `docs/GO-LIVE-MAC.md`, `plugins/privacy-core/README.md`                                         | Mention the page                                                                      |

## Interfaces

```ts
// overview.ts
export type ModelLabel = { provider: string; providerLabel: string; model: string };
export type PrivacyActivity =
  | { at: string; kind: "answer"; bytes: number }
  | { at: string; kind: "search" | "read" | "calendar"; count: number };
export type PrivacyOverview = {
  mainModel?: ModelLabel;
  inboxAgent: string;
  inboxModel?: ModelLabel;
  privateGateway: "running" | "not_running" | "not_set_up";
  protection: "on" | "refusing" | "unchecked";
  protectionIssues: number;
  email: { connected: true; address: string } | { connected: false };
  enclave?: { providerLabel: string; ok: boolean; at?: string };
  activity: PrivacyActivity[];
};
export function buildPrivacyOverview(input: {
  mainConfig: unknown;
  privateConfig: unknown;
  auditRows: PrivacyAuditRow[];
  privateReachable: boolean;
  now: Date;
}): PrivacyOverview;

// render.ts
export function renderPrivacyPage(
  overview: PrivacyOverview,
  options: { now: Date; timeZone?: string; locale?: string },
): string;

// sources.ts
export async function loadPrivacyOverview(params: {
  mode: "standard" | "private";
  ownConfig: unknown;
  env?: NodeJS.ProcessEnv;
  now: Date;
  signal: AbortSignal;
}): Promise<PrivacyOverview>;

// route.ts
export const PRIVACY_PAGE_PATH = "/plugins/privacy-core/privacy";
export function registerPrivacyPage(
  api: OpenClawPluginApi,
  options: { mode: "standard" | "private"; currentConfig: () => unknown; clock?: () => Date },
): void;
```

## Tasks

### Task 1: Overview builder (TDD)

- [ ] Write failing tests: tinfoil private config with mail and a recent ok attestation → all green, address, models, activity newest first; no mail → `email.connected=false`; `privateReachable=false` → `not_running`; no private config → `not_set_up`; last validation `ok:false, issues:3` → `refusing`/3; latest attestation failed → `enclave.ok=false`; rows older than 7 days excluded; at most 20 items; failed mail rows excluded; model `openai/gpt-6-astra@openai:setup-…` → OpenAI / gpt-6-astra; non-attested inbox provider → no enclave line.
- [ ] Run `npx vitest run plugins/privacy-core/src/privacy-page` → FAIL (module missing).
- [ ] Implement `overview.ts` reusing `resolveAgentPrimaryModel` and `resolveProviderTrust`.
- [ ] Run → PASS.

### Task 2: Renderer (TDD)

- [ ] Failing tests: escapes `<script>` in address and model; no `<script` in output; not-connected line contains `openclaw privacy mail connect`; not-running line contains `openclaw --profile private gateway start`; refusing line contains `openclaw --profile private privacy status`; relative time "4 minutes ago" with injected clock; activity time formatted in the given time zone.
- [ ] Run → FAIL. Implement `render.ts`. Run → PASS.

### Task 3: Sources and route (TDD)

- [ ] Failing tests: `registerPrivacyPage` registers one tab descriptor (`surface: "tab"`, `slug: "privacy"`, `path: PRIVACY_PAGE_PATH`, `requiredScopes: ["operator.read"]`) and one route (`auth: "gateway"`, `match: "exact"`); handler GET → 200, `text/html`, CSP with `default-src 'none'` and `frame-ancestors 'self'`, `cache-control: no-store`; POST → 405 with `allow: GET, HEAD`; `loadPrivacyOverview` on temp state dirs reads the audit tail and both configs and treats unreadable files as missing.
- [ ] Run → FAIL. Implement `sources.ts`, `route.ts`; extend `test/fake-plugin-api.ts`; wire `index.ts`. Run → PASS.

### Task 4: Release and docs

- [ ] Bump to 0.3.0 (four `package.json`, five lock entries, `PACK_VERSION`); mention the page in `docs/GO-LIVE-MAC.md` and the plugin README.
- [ ] `npm run check` → all green.

### Task 5: Prove and deploy (live)

- [ ] Isolated copy: `npm ci`, `npm run check`, pack, production copy `npm ci --omit=dev`.
- [ ] Scratch gateway on the production copy: tab descriptor listed, route returns the page with gateway auth, refuses without it.
- [ ] Fresh verified backups; deploy main (gateway-side install) and private (stop, cache-only install, start); live checks; screenshots of the sidebar and page on both dashboards.

Commits are left to the owner.
