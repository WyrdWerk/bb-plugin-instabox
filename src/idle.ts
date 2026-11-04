// The account's idle-pause rules, shared by machine create, the dashboard's
// per-machine control and the machine-inputs picker.
//
// InstaBox's plans differ: a free account always pauses after 30 minutes, a
// paid account takes 300-1800 s in whole minutes, and an account with
// `manualLifecycle` (an admin grant) takes 120-86400 s or 0 (off) when its plan
// also allows always-on machines. `GET /v1/me` reports the choices, so this
// module never hard-codes them.
import type { Me } from "./instabox-api.ts";

export interface IdlePolicy {
  /** The seconds the account's own UI offers; empty when the server reports none. */
  choices: number[];
  manualLifecycle: boolean;
  /** 0 is accepted only here. */
  canDisable: boolean;
  min: number;
  max: number;
}

export function idlePolicy(me: Me): IdlePolicy {
  const manualLifecycle = me.manualLifecycle === true;
  const choices = [...new Set((me.idleChoicesSeconds ?? []).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  return {
    choices,
    manualLifecycle,
    canDisable: manualLifecycle && me.alwaysOnAllowed === true,
    min: manualLifecycle ? 120 : (choices[0] ?? 300),
    max: manualLifecycle ? 86400 : (choices[choices.length - 1] ?? 1800),
  };
}

/**
 * Validate a requested idle pause against the account. Returns the seconds to
 * send, or null for "leave InstaBox's own default alone" (only when the request
 * itself is null/undefined).
 *
 * 0 means off. It is refused unless the account reports manualLifecycle and
 * alwaysOnAllowed: offering "off" to an account that ignores it is worse than
 * not offering it.
 */
export function normalizeIdleSeconds(me: Me, requested: number | null | undefined): number | null {
  if (requested === null || requested === undefined) return null;
  const p = idlePolicy(me);
  if (!Number.isInteger(requested) || requested < 0) throw new Error(`Idle pause must be a whole number of seconds, not ${requested}.`);
  if (requested === 0) {
    if (!p.manualLifecycle) throw new Error("This InstaBox account does not allow turning the idle pause off (manualLifecycle is off). Pick one of its idle times.");
    if (!p.canDisable) throw new Error("This InstaBox account does not allow always-on machines. Pick one of its idle times.");
    return 0;
  }
  if (p.manualLifecycle) {
    if (requested < 120 || requested > 86_400 || requested % 60 !== 0) throw new Error("Idle pause must be 120-86400 seconds in whole minutes on this account.");
    return requested;
  }
  if (p.choices.includes(requested)) return requested;
  // Paid plans accept any whole minute in the offered range; the dashboard
  // offers only idleChoicesSeconds, but a stored plugin setting may predate a
  // plan change, so accept the documented range too.
  if (requested >= p.min && requested <= p.max && requested % 60 === 0) return requested;
  const list = p.choices.length ? p.choices.map((s) => `${s / 60} min`).join(", ") : `${p.min / 60}-${p.max / 60} min in whole minutes`;
  throw new Error(`Idle pause ${requested}s is not allowed on this InstaBox account. Choose ${list}.`);
}

/** Human label used by the page and the plugin settings summary. */
export function idleLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "account default";
  if (seconds === 0) return "off";
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}
