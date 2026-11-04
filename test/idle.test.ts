import assert from "node:assert/strict";
import { test } from "node:test";
import { idleLabel, idlePolicy, normalizeIdleSeconds } from "../src/idle.ts";
import type { Me } from "../src/instabox-api.ts";

const paid: Me = {
  login: "owner@example.com",
  manualLifecycle: false,
  alwaysOnAllowed: true,
  idleChoicesSeconds: [300, 600, 900, 1200, 1500, 1800],
};

const manual: Me = { login: "x", manualLifecycle: true, alwaysOnAllowed: true, idleChoicesSeconds: [] };
const manualNoOff: Me = { login: "x", manualLifecycle: true, alwaysOnAllowed: false, idleChoicesSeconds: [] };

test("idlePolicy keeps the account's choices and gates off on manualLifecycle", () => {
  assert.deepEqual(idlePolicy(paid), { choices: [300, 600, 900, 1200, 1500, 1800], manualLifecycle: false, canDisable: false, min: 300, max: 1800 });
  // alwaysOnAllowed alone is not enough: the owner's rule is manualLifecycle.
  assert.equal(idlePolicy({ ...paid, alwaysOnAllowed: true }).canDisable, false);
  assert.equal(idlePolicy(manual).canDisable, true);
  assert.equal(idlePolicy(manualNoOff).canDisable, false);
  assert.deepEqual(idlePolicy({ login: "x", idleChoicesSeconds: [1800, 300, 300] }).choices, [300, 1800]);
});

test("normalizeIdleSeconds accepts the account's values, whole minutes in range, and refuses off without manualLifecycle", () => {
  assert.equal(normalizeIdleSeconds(paid, null), null);
  assert.equal(normalizeIdleSeconds(paid, undefined), null);
  assert.equal(normalizeIdleSeconds(paid, 300), 300);
  assert.equal(normalizeIdleSeconds(paid, 900), 900);
  // A paid plan accepts any whole minute in 300-1800; the UI offers only choices.
  assert.equal(normalizeIdleSeconds(paid, 420), 420);
  assert.throws(() => normalizeIdleSeconds(paid, 0), /manualLifecycle/);
  assert.throws(() => normalizeIdleSeconds(paid, 299), /not allowed/);
  assert.throws(() => normalizeIdleSeconds(paid, 1801), /not allowed/);
  assert.throws(() => normalizeIdleSeconds(paid, 420.5), /whole number/);
});

test("manualLifecycle accounts take 120-86400 in whole minutes, and off only with alwaysOnAllowed", () => {
  assert.equal(normalizeIdleSeconds(manual, 0), 0);
  assert.equal(normalizeIdleSeconds(manual, 120), 120);
  assert.equal(normalizeIdleSeconds(manual, 86_400), 86_400);
  assert.throws(() => normalizeIdleSeconds(manual, 90), /120-86400/);
  assert.throws(() => normalizeIdleSeconds(manual, 121), /120-86400/);
  assert.throws(() => normalizeIdleSeconds(manual, 86_460), /120-86400/);
  assert.throws(() => normalizeIdleSeconds(manualNoOff, 0), /always-on/);
});

test("a free account's fixed 1800 s is the only accepted value", () => {
  const free: Me = { login: "free@example.com", manualLifecycle: false, idleChoicesSeconds: [1800] };
  assert.equal(normalizeIdleSeconds(free, 1800), 1800);
  assert.throws(() => normalizeIdleSeconds(free, 300), /not allowed/);
});

test("idleLabel is the short UI form", () => {
  assert.equal(idleLabel(300), "5 min");
  assert.equal(idleLabel(1800), "30 min");
  assert.equal(idleLabel(0), "off");
  assert.equal(idleLabel(null), "account default");
  assert.equal(idleLabel(90), "90 s");
});
