# AGENTS.md

OpenClaw Private is a pack of three OpenClaw plugins (`plugins/privacy-core`, `plugins/tinfoil`, `plugins/privatemode`) that runs on stock OpenClaw. Nothing here patches OpenClaw.

## Rules

- Use only public `openclaw/plugin-sdk/*` entry points. Never import OpenClaw internals. If a needed SDK entry ships without types, declare exactly what you use in `types/openclaw-sdk-untyped.d.ts`.
- Code shared by the plugins lives in `shared/`. Plugins never import each other.
- Never disable, skip or mock attestation in production code. Mocks live in tests only. `test/no-unverified-attestation.test.ts` guards the Tinfoil unverified client.
- Never add a host to an egress allowlist or a provider to the trust table (`plugins/privacy-core/src/trust.ts`) without the owner's approval.
- Never store a credential outside the OpenClaw secret store without the owner's approval.
- Audit rows are metadata only: never prompts, keys, bodies or page content.
- A plugin cannot stop the gateway from starting. Enforce at the run gate, the egress proxy, the attested relay, or the action gateway, and give every refusal a message that names the key to fix.
- Dependencies are pinned to exact versions at least seven days old.

## Checks

```bash
npm ci
npm run check     # format, typecheck, tests
```

User-visible behavior is proven against a real stock gateway: `npm ci --omit=dev` in a copy, `openclaw plugins install -l`, then a gateway run on a scratch state dir. See `docs/GO-LIVE-MAC.md` for the shape of a real install.
