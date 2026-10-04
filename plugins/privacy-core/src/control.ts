// Take-the-wheel control state, per agent.
//
// Ported from OpenBot (https://github.com/CopilotKit/OpenBot,
// agent-computer/src/control.ts). Portions Copyright (c) 2026 CopilotKit, MIT
// License. The agent may ask for help or for a secret; it can never hand
// itself over. While a person holds the wheel, agent actions are refused, not
// queued: a queued click lands after the person has moved on.
export type ControlState = {
  holder: "agent" | "human";
  since: string;
  reason?: string;
  requested: boolean;
  requestedAt?: string;
  secretWanted?: string;
  secretRef?: string;
};

export class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlError";
  }
}

export class ControlRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlRequestError";
  }
}

export const HELP_REQUEST_TTL_MS = 10 * 60 * 1000;
export const SECRET_REQUEST_TTL_MS = HELP_REQUEST_TTL_MS;
export const HUMAN_HAS_CONTROL =
  "A person has control of this agent's computer right now. Wait for them to hand it back before acting.";
export const TAKE_CONTROL_FIRST = "Take control before driving the computer yourself.";

export function createControl(now: () => string = () => new Date().toISOString()) {
  let state: ControlState = { holder: "agent", since: now(), requested: false };
  let secretRequestedAt: string | undefined;

  function dropStaleSecret(): void {
    if (!state.secretWanted || !secretRequestedAt) {
      return;
    }
    if (Date.parse(now()) - Date.parse(secretRequestedAt) <= SECRET_REQUEST_TTL_MS) {
      return;
    }
    secretRequestedAt = undefined;
    state = { ...state, secretWanted: undefined, secretRef: undefined };
  }

  return {
    get(): ControlState {
      if (
        state.requested &&
        state.holder === "agent" &&
        state.requestedAt &&
        Date.parse(now()) - Date.parse(state.requestedAt) > HELP_REQUEST_TTL_MS
      ) {
        const { reason: _reason, requestedAt: _at, ...rest } = state;
        state = { ...rest, requested: false };
      }
      dropStaleSecret();
      return { ...state };
    },
    requestHelp(reason: unknown): ControlState {
      state = {
        ...state,
        requested: true,
        requestedAt: now(),
        reason:
          typeof reason === "string" && reason.trim()
            ? reason.trim().slice(0, 500)
            : "The agent needs a person to continue.",
      };
      return this.get();
    },
    requestSecret(input: { label?: unknown; ref?: unknown }): ControlState {
      if (typeof input.ref !== "string" || !input.ref.trim()) {
        throw new ControlRequestError(
          "Say which field the value goes in, using a ref from your snapshot.",
        );
      }
      secretRequestedAt = now();
      state = {
        ...state,
        secretWanted:
          typeof input.label === "string" && input.label.trim()
            ? input.label.trim().slice(0, 500)
            : "the value this page is asking for",
        secretRef: input.ref.trim(),
      };
      return this.get();
    },
    pendingSecret(): { ref: string } | null {
      dropStaleSecret();
      return state.secretWanted && state.secretRef ? { ref: state.secretRef } : null;
    },
    secretSupplied(): void {
      secretRequestedAt = undefined;
      state = { ...state, secretWanted: undefined, secretRef: undefined };
    },
    take(): ControlState {
      secretRequestedAt = undefined;
      state = { holder: "human", since: now(), reason: state.reason, requested: false };
      return this.get();
    },
    release(): ControlState {
      secretRequestedAt = undefined;
      state = { holder: "agent", since: now(), requested: false };
      return this.get();
    },
    assertAgentMayAct(): void {
      if (state.holder === "human") {
        throw new ControlError(HUMAN_HAS_CONTROL);
      }
    },
    humanMayDrive(): boolean {
      return state.holder === "human";
    },
  };
}

export type Control = ReturnType<typeof createControl>;

/** One control per agent id, created on first use. */
export function createControlRegistry(now?: () => string) {
  const controls = new Map<string, Control>();
  return {
    for(agentId: string): Control {
      let control = controls.get(agentId);
      if (!control) {
        control = createControl(now);
        controls.set(agentId, control);
      }
      return control;
    },
    list(): Array<{ agentId: string; state: ControlState }> {
      return [...controls.entries()].map(([agentId, control]) => ({
        agentId,
        state: control.get(),
      }));
    },
  };
}

export type ControlRegistry = ReturnType<typeof createControlRegistry>;
