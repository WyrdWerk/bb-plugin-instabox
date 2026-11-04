// Hub side of the activity lease: while a bb thread is starting or active on
// an InstaBox machine, renew a short InstaBox task lease so the machine's idle
// pause (5 minutes for this experiment) does not pause a busy agent turn.
//
// The lease is renewed by the supervisor every 30 s with a 180 s TTL, and is
// released as soon as no thread is busy so the normal idle pause can happen.
import type { InstaboxApi } from "./instabox-api.ts";

export const LEASE_TTL_SECONDS = 180;

/** InstaBox lease ids are 1-64 of [A-Za-z0-9_-]; bb host ids already fit. */
export function leaseIdFor(hostId: string): string {
  return `bb-${hostId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

export class ActivityLeases {
  /** Machines we have put a lease on in this process (so idle does not DELETE blindly). */
  private readonly held = new Set<string>();

  /**
   * busy: hold/renew the lease. idle: release it once. A lease from an earlier
   * bb process expires by itself (TTL), so an idle machine we never leased is
   * left alone and InstaBox's own timer is not disturbed.
   */
  async sync(api: InstaboxApi, machineId: string, hostId: string, busy: boolean): Promise<"held" | "released" | "none"> {
    if (busy) {
      await api.putActivityLease(machineId, leaseIdFor(hostId), LEASE_TTL_SECONDS);
      this.held.add(machineId);
      return "held";
    }
    if (!this.held.has(machineId)) return "none";
    await api.deleteActivityLease(machineId, leaseIdFor(hostId));
    this.held.delete(machineId);
    return "released";
  }

  forget(machineId: string): void {
    this.held.delete(machineId);
  }

  /** Drop machines that no longer exist in bb, without calling InstaBox. */
  retain(machineIds: Set<string>): void {
    for (const id of this.held) if (!machineIds.has(id)) this.held.delete(id);
  }

  clear(): void {
    this.held.clear();
  }
}

/**
 * InstaBox counts SSH traffic as activity, and the tunnel to every connected
 * runner carries the bb daemon's heartbeats, so InstaBox never idle-pauses a
 * connected runner by itself. The plugin applies the machine's own idle time
 * instead: once no bb thread on it has been starting or active for that long,
 * the supervisor pauses it through bb (and the next message resumes it).
 */
export class IdleWatch {
  private readonly lastBusy = new Map<string, number>();

  /**
   * Record one supervisor observation. Returns true when the machine has had no
   * busy thread for its idle time and should be paused now. The first sighting
   * (also after a plugin or bb restart) starts a full idle period. null/0 idle
   * seconds mean off: never paused.
   */
  observe(machineId: string, busy: boolean, idleSeconds: number | null | undefined, now: number): boolean {
    const since = this.lastBusy.get(machineId);
    if (busy || since === undefined) {
      this.lastBusy.set(machineId, now);
      return false;
    }
    if (!idleSeconds) return false;
    return now - since >= idleSeconds * 1000;
  }

  forget(machineId: string): void {
    this.lastBusy.delete(machineId);
  }

  retain(machineIds: Set<string>): void {
    for (const id of this.lastBusy.keys()) if (!machineIds.has(id)) this.lastBusy.delete(id);
  }
}
