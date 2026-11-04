// Pure display helpers for the InstaBox page (no React; unit-tested).
export type Tone = "ok" | "busy" | "idle" | "warn" | "bad";

const LIVE = new Set(["running"]);
const STARTING = new Set(["creating", "starting", "resuming"]);
const STOPPING = new Set(["stopping", "suspending", "deleting"]);
const STOPPED = new Set(["stopped"]);
const PAUSED = new Set(["suspended"]);

export function stateBadge(state: string): { tone: Tone; label: string } {
  if (LIVE.has(state)) return { tone: "ok", label: "running" };
  if (PAUSED.has(state)) return { tone: "warn", label: "paused" };
  if (STOPPED.has(state)) return { tone: "idle", label: "stopped" };
  if (STARTING.has(state)) return { tone: "busy", label: state };
  if (STOPPING.has(state)) return { tone: "busy", label: state };
  if (state === "error") return { tone: "bad", label: "error" };
  return { tone: "warn", label: state };
}

export function isTransitional(state: string): boolean {
  return STARTING.has(state) || STOPPING.has(state);
}

/** "3m ago", "2h ago", "5d ago". */
export function ago(iso: string | null, now: number): string {
  if (iso === null) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172_800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function bytes(n: number | null): string {
  if (n === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${Number.isInteger(v) ? v : v.toFixed(1)} ${units[i]}`;
}

export function gib(mib: number | null): string {
  return mib === null ? "—" : `${Math.round((mib / 1024) * 10) / 10} GiB`;
}

/** Seconds → "5 min", "1 h 30 min", "off", "account default". */
export function idleText(seconds: number | null): string {
  if (seconds === null) return "account default";
  if (seconds === 0) return "off";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function specText(vcpus: number | null, memMiB: number | null): string {
  if (vcpus === null && memMiB === null) return "—";
  return [vcpus === null ? null : `${vcpus} vCPU`, memMiB === null ? null : gib(memMiB)].filter(Boolean).join(" · ");
}

export function pct(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "—" : `${Math.round(n)}%`;
}

export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

export function num(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

export function limit(n: number | null | undefined): string {
  return n === null || n === undefined ? "unlimited" : String(n);
}

/** Metadata editor text: one key=value per line, bb's own labels hidden. */
export function labelsText(metadata: Record<string, string>): string {
  return Object.entries(metadata)
    .filter(([k]) => !k.startsWith("bb-"))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

export function parseLabels(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const at = line.indexOf("=");
    if (at < 1) throw new Error(`Label line ${i + 1}: expected key=value`);
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(key)) throw new Error(`Label line ${i + 1}: invalid key ${key}`);
    if (key.startsWith("bb-")) throw new Error(`Label line ${i + 1}: ${key} is reserved by bb`);
    if (value.length > 256) throw new Error(`Label line ${i + 1}: value is longer than 256 characters`);
    out[key] = value;
  }
  return out;
}

/** A snapshot/machine name from a machine name, for the dialog's initial value. */
export function suggestSnapshotName(machine: string): string {
  const base = `snap-${machine}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return base.slice(0, 63).replace(/-$/, "");
}
