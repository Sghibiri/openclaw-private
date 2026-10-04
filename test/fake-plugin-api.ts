// Test-only stand-in for the OpenClaw plugin API: records every registration
// so plugin entries can be exercised without a running gateway.
type Registrations = Record<string, unknown[][]>;

export type CapturedPlugin = {
  calls: Registrations;
  first<T = unknown>(method: string): T;
  all<T = unknown>(method: string): T[];
  hooks: Array<{ name: string; handler: (...args: unknown[]) => unknown }>;
  logs: string[];
};

export function capturePlugin(
  entry: { register?: (api: never) => unknown },
  options: { pluginConfig?: unknown; config?: unknown } = {},
): CapturedPlugin {
  const calls: Registrations = {};
  const hooks: CapturedPlugin["hooks"] = [];
  const logs: string[] = [];
  const logger = {
    info: (m: string) => logs.push(`info ${m}`),
    warn: (m: string) => logs.push(`warn ${m}`),
    error: (m: string) => logs.push(`error ${m}`),
    debug: () => {},
  };
  const base: Record<string, unknown> = {
    id: "test",
    pluginConfig: options.pluginConfig ?? {},
    config: options.config ?? {},
    logger,
    registrationMode: "full",
    on: (name: string, handler: (...args: unknown[]) => unknown) => {
      hooks.push({ name, handler });
    },
  };
  const api = new Proxy(base, {
    get(target, prop: string) {
      if (prop in target) {
        return target[prop];
      }
      if (prop.startsWith("register")) {
        return (...args: unknown[]) => {
          (calls[prop] ??= []).push(args);
        };
      }
      return undefined;
    },
  });
  entry.register?.(api as never);
  return {
    calls,
    hooks,
    logs,
    first: <T>(method: string) => calls[method]?.[0]?.[0] as T,
    all: <T>(method: string) => (calls[method] ?? []).map((args) => args[0] as T),
  };
}
