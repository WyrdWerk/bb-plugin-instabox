import assert from "node:assert/strict";
import { test } from "node:test";
import { ActivityLeases, IdleWatch, leaseIdFor } from "../src/activity.ts";
import type { InstaboxApi } from "../src/instabox-api.ts";

function fakeApi() {
  const puts: { machineId: string; leaseId: string; ttl: number }[] = [];
  const deletes: { machineId: string; leaseId: string }[] = [];
  const api = {
    putActivityLease: async (machineId: string, leaseId: string, ttl: number) => {
      puts.push({ machineId, leaseId, ttl });
      return { id: leaseId, machineId, expiresAt: new Date().toISOString() };
    },
    deleteActivityLease: async (machineId: string, leaseId: string) => {
      deletes.push({ machineId, leaseId });
    },
  } as unknown as InstaboxApi;
  return { api, puts, deletes };
}

test("lease ids are InstaBox-safe and stable per bb host", () => {
  assert.equal(leaseIdFor("host_abc123xyz0"), "bb-host_abc123xyz0");
  assert.equal(leaseIdFor("host/a b"), "bb-host_a_b");
  assert.equal(leaseIdFor("x".repeat(100)).length, 64);
});

test("a busy thread holds and renews a lease; an idle machine releases it once", async () => {
  const { api, puts, deletes } = fakeApi();
  const leases = new ActivityLeases();
  assert.equal(await leases.sync(api, "m_1", "host_1", true), "held");
  assert.equal(await leases.sync(api, "m_1", "host_1", true), "held");
  assert.deepEqual(puts, [
    { machineId: "m_1", leaseId: "bb-host_1", ttl: 180 },
    { machineId: "m_1", leaseId: "bb-host_1", ttl: 180 },
  ]);
  assert.equal(deletes.length, 0);
  assert.equal(await leases.sync(api, "m_1", "host_1", false), "released");
  assert.equal(await leases.sync(api, "m_1", "host_1", false), "none");
  assert.deepEqual(deletes, [{ machineId: "m_1", leaseId: "bb-host_1" }]);
});

test("an idle machine this process never leased is left to InstaBox's own timer", async () => {
  const { api, deletes } = fakeApi();
  const leases = new ActivityLeases();
  assert.equal(await leases.sync(api, "m_1", "host_1", false), "none");
  assert.equal(deletes.length, 0);
});

test("forget/retain drop local leases without a DELETE", async () => {
  const { api, deletes } = fakeApi();
  const leases = new ActivityLeases();
  await leases.sync(api, "m_1", "host_1", true);
  await leases.sync(api, "m_2", "host_2", true);
  leases.forget("m_1");
  leases.retain(new Set(["m_2"]));
  assert.equal(await leases.sync(api, "m_1", "host_1", false), "none");
  assert.equal(await leases.sync(api, "m_2", "host_2", false), "released");
  assert.deepEqual(deletes, [{ machineId: "m_2", leaseId: "bb-host_2" }]);
});

test("IdleWatch pauses only after a full idle period with no busy thread, and never when idle pause is off", () => {
  const w = new IdleWatch();
  const s = 1000;
  // First sighting starts the clock, even if already idle (e.g. after a bb restart).
  assert.equal(w.observe("m", false, 300, 0), false);
  assert.equal(w.observe("m", false, 300, 299 * s), false);
  // A busy observation restarts the full period.
  assert.equal(w.observe("m", true, 300, 200 * s), false);
  assert.equal(w.observe("m", false, 300, 499 * s), false);
  assert.equal(w.observe("m", false, 300, 500 * s), true);
  // The machine's own (changed) idle time applies.
  assert.equal(w.observe("m", false, 600, 500 * s), false);
  // Off (null or 0) never pauses.
  const off = new IdleWatch();
  off.observe("x", false, null, 0);
  assert.equal(off.observe("x", false, null, 10_000 * s), false);
  assert.equal(off.observe("x", false, 0, 10_000 * s), false);
  // forget() starts over.
  w.forget("m");
  assert.equal(w.observe("m", false, 300, 10_000 * s), false);
});
