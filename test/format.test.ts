import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, bytes, gib, idleText, labelsText, limit, parseLabels, pct, specText, stateBadge, suggestSnapshotName } from "../ui/format.ts";

test("stateBadge names InstaBox states and their tone", () => {
  assert.deepEqual(stateBadge("running"), { tone: "ok", label: "running" });
  assert.deepEqual(stateBadge("suspended"), { tone: "warn", label: "paused" });
  assert.deepEqual(stateBadge("stopped"), { tone: "idle", label: "stopped" });
  assert.deepEqual(stateBadge("resuming"), { tone: "busy", label: "resuming" });
  assert.deepEqual(stateBadge("deleting"), { tone: "busy", label: "deleting" });
  assert.deepEqual(stateBadge("error"), { tone: "bad", label: "error" });
  assert.deepEqual(stateBadge("new-state"), { tone: "warn", label: "new-state" });
});

test("idleText is the per-machine control's label", () => {
  assert.equal(idleText(null), "account default");
  assert.equal(idleText(0), "off");
  assert.equal(idleText(300), "5 min");
  assert.equal(idleText(1800), "30 min");
  assert.equal(idleText(3600), "1 h");
  assert.equal(idleText(5400), "1 h 30 min");
});

test("size and metric formatting", () => {
  assert.equal(specText(4, 8192), "4 vCPU · 8 GiB");
  assert.equal(specText(2, 4096), "2 vCPU · 4 GiB");
  assert.equal(specText(null, null), "—");
  assert.equal(gib(8192), "8 GiB");
  assert.equal(gib(4096), "4 GiB");
  assert.equal(gib(null), "—");
  assert.equal(pct(12.5), "13%");
  assert.equal(pct(null), "—");
  assert.equal(bytes(0), "0 B");
  assert.equal(bytes(2048), "2 KB");
  assert.equal(bytes(null), "—");
  assert.equal(limit(null), "unlimited");
  assert.equal(limit(500), "500");
});

test("ago is relative and handles bad input", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  assert.equal(ago("2026-11-04T11:59:00Z", now), "60s ago");
  assert.equal(ago("2026-11-04T11:55:00Z", now), "5m ago");
  assert.equal(ago("2026-11-04T09:00:00Z", now), "3h ago");
  assert.equal(ago("2026-10-30T12:00:00Z", now), "5d ago");
  assert.equal(ago(null, now), "—");
  assert.equal(ago("nope", now), "—");
});

test("labels parse one key=value per line and keep bb's labels out of the editor", () => {
  assert.deepEqual(parseLabels("team=agents\nowner=yash\n\n  env = prod  "), { team: "agents", owner: "yash", env: "prod" });
  assert.throws(() => parseLabels("noequals"), /expected key=value/);
  assert.throws(() => parseLabels("bb-provider=instabox"), /reserved/);
  assert.throws(() => parseLabels("bad key=x"), /invalid key/);
  assert.throws(() => parseLabels("k=" + "x".repeat(257)), /longer than 256/);
  assert.equal(labelsText({ "bb-provider": "instabox", "bb-key": "h", team: "agents", owner: "yash" }), "team=agents\nowner=yash");
});

test("suggestSnapshotName is a valid InstaBox name and fits 63 chars", () => {
  const n = suggestSnapshotName("BB_One With Spaces!");
  assert.equal(n, "snap-bb-one-with-spaces");
  assert.match(n, /^[a-z0-9][a-z0-9-]{0,62}$/);
  const long = suggestSnapshotName("x".repeat(100));
  assert.equal(long.length, 63);
  assert.match(long, /^[a-z0-9][a-z0-9-]{0,62}$/);
  assert.ok(!long.endsWith("-"));
});
