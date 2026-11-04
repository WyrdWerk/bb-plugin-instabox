import assert from "node:assert/strict";
import { test } from "node:test";
import { createDashboardHandlers, redactText, secretValues } from "../src/dashboard.ts";
import type { InstaboxApi, Machine, Me, Snapshot, Template, Usage } from "../src/instabox-api.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const REQ = "11111111-1111-4111-8111-111111111111";

const me: Me = {
  login: "owner@example.com",
  email: "owner@example.com",
  org: { id: "org_1", name: "owner@example.com", tier: "pro", kind: "personal" },
  manualLifecycle: false,
  alwaysOnAllowed: true,
  machineMetrics: true,
  idleChoicesSeconds: [300, 600, 900, 1200, 1500, 1800],
  allowedSpecs: [{ vcpus: 4, memMiB: 8192, persistentDiskGiB: 20 }],
  plans: [{ tier: "pro", monthlyFeeUSD: 20, maxMachines: 500, maxRunning: 100, maxVCPUs: 8, maxDiskGiB: 200 }],
  csrfToken: "csrf-secret",
};

const usage: Usage = {
  computedAt: "2026-11-04T11:00:00Z",
  logicalBytes: 519_691_042_816,
  storedBytes: 6_647_501_846,
  machines: 2,
  snapshots: 14,
  allocatedDiskGiB: 40,
  limits: {
    maxMachines: 500,
    maxSnapshots: 0,
    maxStoredGiB: 0,
    unlimited: ["maxSnapshots", "maxStoredGiB"],
    machineSpec: { vcpus: 4, memMiB: 8192, persistentDiskGiB: 20 },
  },
  cost: {
    periodStart: "2026-11-01T00:00:00Z",
    periodEnd: "2026-12-01T00:00:00Z",
    machines: 0,
    freeMachines: 0,
    freeSandboxHours: 0,
    snapshots: 14,
    vcpuHours: 49.737,
    memGiBHours: 99.474,
    storageGiBHours: 972.278,
    egressGiB: 0,
    runtimeUSD: 0.422,
    vcpuUSD: 0.198,
    memUSD: 0.223,
    storageUSD: 0.106,
    egressUSD: 0,
    costUSD: 0.529,
    allowanceUSD: 20,
    creditRemainingUSD: 19.47,
    overageUSD: 0,
    remainingUSD: 0,
    ratedUntil: "2026-11-04T11:00:00Z",
    billableDiskGiB: 0,
    allocatedDiskGiB: 0,
  },
};

const machines: Machine[] = [
  {
    id: "m_one",
    name: "bb-one",
    state: "running",
    operationId: null,
    runtime: { ready: true },
    metadata: { "bb-provider": "instabox", "bb-key": "hash", team: "old" },
    spec: { vcpus: 4, memMiB: 8192, persistentDiskGiB: 20 },
    storage: { sizeGiB: 20, mountPath: "/data", persistent: true, synced: true },
    template: { id: "agent-browser", version: "2026-11-01.3", digest: "sha256:x" },
    autoSuspendAfterSeconds: 300,
    createdAt: "2026-11-04T10:00:00Z",
    free: false,
    // Fields a future API could add; the DTO must not carry them.
    ...({ certificate: "SECRET-CERT", desktopUrl: "https://desk/SECRET", host: "gateway", port: 2222 } as object),
  },
  {
    id: "m_two",
    name: "bb-two",
    state: "suspended",
    operationId: null,
    runtime: { ready: false },
    metadata: { source: "bb-dashboard" },
    spec: { vcpus: 2, memMiB: 4096, persistentDiskGiB: 20 },
    template: { id: "agent-browser", version: "2026-11-01.3", digest: "sha256:x" },
    autoSuspendAfterSeconds: 900,
    autoSuspendedAt: "2026-11-04T11:30:00Z",
    createdAt: "2026-11-04T09:00:00Z",
    free: false,
  },
  {
    id: "m_three",
    name: "bb-three",
    state: "deleting",
    operationId: "op_x",
    runtime: { ready: false },
    metadata: {},
    template: { id: "agent-browser", version: "2026-11-01.3", digest: "sha256:x" },
    autoSuspendAfterSeconds: null,
    createdAt: "2026-11-04T08:00:00Z",
    free: false,
  },
];

const snapshots: Snapshot[] = [
  {
    id: "sn_cfg",
    name: "bb-runner-basic-v1",
    status: "ready",
    sourceMachineId: "m_build",
    sourceSnapshotSeq: 0,
    orgId: "org_1",
    template: { id: "agent-browser", version: "v", digest: "d" },
    rootSizeBytes: 1024,
    dataSizeBytes: 2048,
    createdAt: "2026-11-01T00:00:00Z",
    description: "runner",
  },
  {
    id: "sn_other",
    name: "other-snap",
    status: "ready",
    sourceMachineId: "m_other",
    sourceSnapshotSeq: 0,
    orgId: "org_1",
    template: { id: "agent-browser", version: "v", digest: "d" },
    rootSizeBytes: 1024,
    createdAt: "2026-11-02T00:00:00Z",
    // Secret-bearing fields a snapshot response must never leak to the page.
    ...({ certificate: "SECRET-CERT", token: "SECRET-TOKEN" } as object),
  },
];

const templates: Template[] = [
  {
    id: "agent-browser",
    version: "2026-11-01.3",
    digest: "sha256:x",
    arch: "x86_64",
    description: "agents",
    defaultSpec: { vcpus: 4, memMiB: 8192, persistentDiskGiB: 20 },
    creatable: true,
    hidden: false,
    default: true,
    capabilities: ["identity-reset"],
  },
  {
    id: "base",
    version: "old",
    digest: "sha256:y",
    arch: "x86_64",
    defaultSpec: { vcpus: 2, memMiB: 2048, persistentDiskGiB: 20 },
    creatable: false,
    hidden: true,
  },
];

function setup(opts: { failMachines?: boolean; linked?: boolean } = {}) {
  const calls: { op: string; [k: string]: unknown }[] = [];
  const api = {
    me: async () => me,
    usage: async () => usage,
    listAllMachines: async () => {
      if (opts.failMachines) throw new Error("InstaBox API 503 unavailable");
      return machines;
    },
    listSnapshots: async () => snapshots,
    listTemplates: async () => templates,
    metrics: async (id: string) => {
      calls.push({ op: "metrics", id });
      return {
        metrics: [
          {
            timestamp: "2026-11-04T11:59:30Z",
            cpuUsedPct: 12.5,
            cpuCount: 4,
            memUsed: 1073741824,
            memTotal: 8589934592,
            diskTotal: 20 * 1024 * 1024 * 1024,
            diskUsed: 100,
          },
        ],
      };
    },
    findMachine: async (id: string) => machines.find((m) => m.id === id) ?? null,
    createMachine: async (body: unknown, key: string) => {
      calls.push({ op: "create", body, key });
      return { id: "op_create", machineId: "m_new", type: "create", state: "queued", error: null };
    },
    updateMachine: async (id: string, body: unknown, key: string) => {
      calls.push({ op: "update", id, body, key });
      return { ...machines[0]!, id, ...(body as object) };
    },
    lifecycle: async (id: string, action: string, _signal?: AbortSignal, key?: string) => {
      calls.push({ op: "lifecycle", id, action, key });
      return { id: "op_life", machineId: id, type: action, state: "queued", error: null };
    },
    createSnapshot: async (id: string, body: { name: string }, key: string) => {
      calls.push({ op: "snapshot", id, body, key });
      return {
        id: "sn_new",
        name: body.name,
        status: "pending",
        sourceMachineId: id,
        sourceSnapshotSeq: 0,
        orgId: "org_1",
        template: { id: "agent-browser", version: "v", digest: "d" },
        rootSizeBytes: 1024,
        createdAt: "2026-11-04T12:00:00Z",
      } satisfies Snapshot;
    },
    deleteSnapshot: async (id: string, confirm: string, key: string) => {
      calls.push({ op: "deleteSnapshot", id, confirm, key });
    },
    deleteMachine: async (id: string, _signal?: AbortSignal, o?: { idempotencyKey?: string; confirm?: string }) => {
      calls.push({ op: "deleteMachine", id, ...o });
      return null;
    },
    exec: async (id: string, req: { cmd: string; timeoutSeconds: number }) => {
      calls.push({ op: "exec", id, req });
      return {
        stdout: "token ibk-server-secret\nZAI_API_KEY=ibsec_0123456789abcdef\n",
        stderr: "other ibk_abcdefghijklmnop and ibk-server-secret\n",
        exitCode: 7,
        timedOut: false,
        truncated: false,
      };
    },
  } as unknown as InstaboxApi;

  const published: number[] = [];
  const deps = {
    client: async () => ({ api }),
    settings: async () => ({
      apiKey: "ibk-server-secret",
      snapshotId: "sn_cfg",
      template: "agent-browser",
      idlePauseSeconds: 300,
    }),
    hosts: async () => [
      { id: "host_bb1", name: "bb-one", status: "connected", machineProviderId: "instabox", phase: "active" },
      { id: "host_boat", name: "bx-old", status: "disconnected", machineProviderId: "boat", phase: "suspended" },
    ],
    getResource: async (hostId: string) => (hostId === "host_bb1" && opts.linked !== false ? { machineId: "m_one", key: "k" } : null),
    createMachine: async (args: { key: string; inputs: Record<string, unknown> }) => {
      calls.push({ op: "bbCreate", ...args });
      return { hostId: "host_new", name: "bb-new" };
    },
    publish: () => void published.push(Date.now()),
    now: () => NOW,
    hubWarning: async () => null,
    cacheMs: 0,
  };
  return { handlers: createDashboardHandlers(deps), calls, published, api, deps };
}

test("overview maps the account, machines, snapshots and templates without secret-bearing fields", async () => {
  const { handlers, calls } = setup();
  const o = await handlers.instabox_overview();
  assert.equal(o.configured, true);
  assert.equal(o.account?.tier, "pro");
  assert.equal(o.account?.login, "owner@example.com");
  assert.equal(o.account?.maxMachines, 500);
  assert.equal(o.account?.maxRunning, 100);
  assert.equal(o.account?.maxSnapshots, null, "unlimited is null, not 0");
  assert.equal(o.account?.maxStoredGiB, null);
  assert.equal(o.account?.machinesUsed, 2);
  assert.equal(o.account?.snapshotsUsed, 14);
  assert.equal(o.account?.costUSD, 0.529);
  assert.equal(o.account?.canDisableIdle, false, "manualLifecycle false hides off");
  assert.deepEqual(o.account?.idleChoicesSeconds, [300, 600, 900, 1200, 1500, 1800]);
  assert.equal(o.account?.defaultIdleSeconds, 300);

  assert.equal(o.machines.items?.length, 3);
  const one = o.machines.items!.find((m) => m.id === "m_one")!;
  assert.equal(one.name, "bb-one");
  assert.equal(one.vcpus, 4);
  assert.equal(one.memMiB, 8192);
  assert.equal(one.autoSuspendAfterSeconds, 300);
  assert.equal(one.bbMachine?.hostId, "host_bb1");
  assert.equal(one.metrics?.cpuUsedPct, 12.5);
  assert.equal(one.metrics?.memUsed, 1073741824);
  const two = o.machines.items!.find((m) => m.id === "m_two")!;
  assert.equal(two.bbMachine, null);
  assert.equal(two.autoSuspendedAt, "2026-11-04T11:30:00Z");
  assert.equal(two.metrics, null, "only running machines get metrics");
  assert.ok(calls.some((c) => c.op === "metrics" && c.id === "m_one"));
  assert.ok(!calls.some((c) => c.op === "metrics" && c.id === "m_two"));

  assert.equal(o.snapshots.items?.find((s) => s.id === "sn_cfg")?.configured, true);
  assert.equal(o.snapshots.items?.find((s) => s.id === "sn_other")?.configured, false);
  assert.deepEqual(o.templates.items?.map((t) => t.id), ["agent-browser"], "hidden/retired templates are dropped");

  const text = JSON.stringify(o);
  for (const secret of ["SECRET-CERT", "SECRET-TOKEN", "csrf-secret", "desk/SECRET", "ibk-server-secret", "zai-secret", "gh-secret"]) {
    assert.ok(!text.includes(secret), `overview must not contain ${secret}`);
  }
});

test("a failing machine list degrades that section, not the page", async () => {
  const { handlers } = setup({ failMachines: true });
  const o = await handlers.instabox_overview();
  assert.equal(o.configured, true);
  assert.equal(o.machines.items, null);
  assert.match(o.machines.error ?? "", /503 unavailable/);
  assert.equal(o.account?.tier, "pro");
});

test("summary counts running+ready machines", async () => {
  const { handlers } = setup();
  assert.deepEqual(await handlers.instabox_summary(), { running: 1, total: 3 });
});

test("idle choices expose the account's list and hide off without manualLifecycle", async () => {
  const { handlers } = setup();
  const c = await handlers.instabox_idle_choices();
  assert.deepEqual(c.choices, [300, 600, 900, 1200, 1500, 1800]);
  assert.equal(c.defaultSeconds, 300);
  assert.equal(c.canDisable, false);
  assert.equal(c.error, null);
});

test("set idle validates against the account and PATCHes the machine", async () => {
  const { handlers, calls } = setup();
  const r = await handlers.instabox_set_idle({ machineId: "m_two", seconds: 1200, requestId: REQ });
  assert.match(r.message, /20 min/);
  const call = calls.find((c) => c.op === "update")!;
  assert.equal(call.id, "m_two");
  assert.deepEqual(call.body, { autoSuspendAfterSeconds: 1200 });
  assert.equal(call.key, REQ);

  await assert.rejects(handlers.instabox_set_idle({ machineId: "m_two", seconds: 0, requestId: REQ }), /manualLifecycle/);
  await assert.rejects(handlers.instabox_set_idle({ machineId: "m_two", seconds: 425, requestId: REQ }), /not allowed/);
});

test("plain create sends the requested idle pause and uses the request id as Idempotency-Key", async () => {
  const { handlers, calls } = setup();
  const r = await handlers.instabox_create_machine({
    name: "new-box",
    source: { kind: "template", templateId: "agent-browser" },
    idleSeconds: 300,
    asRunner: false,
    requestId: REQ,
  });
  assert.equal(r.hostId, null);
  const call = calls.find((c) => c.op === "create")!;
  assert.equal(call.key, REQ);
  assert.deepEqual(call.body, {
    name: "new-box",
    metadata: { source: "bb-dashboard" },
    secrets: "all",
    templateId: "agent-browser",
    autoSuspendAfterSeconds: 300,
  });
});

test("a plain create cannot turn the idle pause off on a non-manual account", async () => {
  const { handlers, calls } = setup();
  await assert.rejects(
    handlers.instabox_create_machine({ name: "new-box", source: { kind: "template", templateId: "agent-browser" }, idleSeconds: 0, asRunner: false, requestId: REQ }),
    /manualLifecycle/,
  );
  assert.ok(!calls.some((c) => c.op === "create"));
});

test("create as bb runner goes through bb core with a stable key and the idle input", async () => {
  const { handlers, calls } = setup();
  const r = await handlers.instabox_create_machine({
    name: null,
    source: { kind: "snapshot", snapshotId: "sn_other" },
    idleSeconds: 600,
    asRunner: true,
    requestId: REQ,
  });
  assert.equal(r.hostId, "host_new");
  const call = calls.find((c) => c.op === "bbCreate")!;
  assert.equal(call.key, `instabox-page-${REQ}`);
  assert.deepEqual(call.inputs, { snapshotId: "sn_other", autoSuspendAfterSeconds: 600 });
  assert.ok(!calls.some((c) => c.op === "create"), "bb core owns the create");
});

test("delete machine needs the exact name and refuses a machine bb still uses", async () => {
  const { handlers, calls } = setup();
  await assert.rejects(handlers.instabox_delete_machine({ machineId: "m_one", confirmName: "bb-one", requestId: REQ }), /bb machine bb-one/);
  assert.ok(!calls.some((c) => c.op === "deleteMachine"));
  await assert.rejects(handlers.instabox_delete_machine({ machineId: "m_two", confirmName: " bb-two", requestId: REQ }), /does not match/);
  assert.ok(!calls.some((c) => c.op === "deleteMachine"));
});

test("an unlinked machine deletes with the confirmation header value and idempotency key", async () => {
  const { handlers, calls } = setup();
  const r = await handlers.instabox_delete_machine({ machineId: "m_two", confirmName: "bb-two", requestId: REQ });
  assert.match(r.message, /Deleting bb-two/);
  const call = calls.find((c) => c.op === "deleteMachine")!;
  assert.equal(call.id, "m_two");
  assert.equal(call.confirm, "m_two");
  assert.equal(call.idempotencyKey, REQ);
});

test("delete snapshot needs the exact name and warns when it is the runner source", async () => {
  const { handlers, calls } = setup();
  await assert.rejects(handlers.instabox_delete_snapshot({ snapshotId: "sn_cfg", confirmName: "wrong", requestId: REQ }), /does not match/);
  assert.ok(!calls.some((c) => c.op === "deleteSnapshot"));
  const r = await handlers.instabox_delete_snapshot({ snapshotId: "sn_cfg", confirmName: "bb-runner-basic-v1", requestId: REQ });
  assert.match(r.message, /configured runner snapshot/);
  const call = calls.find((c) => c.op === "deleteSnapshot")!;
  assert.equal(call.confirm, "bb-runner-basic-v1");
  assert.equal(call.key, REQ);
});

test("lifecycle refuses Stop on a paused machine and Start resumes it", async () => {
  const { handlers, calls } = setup();
  await assert.rejects(handlers.instabox_lifecycle({ machineId: "m_two", action: "stop", requestId: REQ }), /409/);
  assert.ok(!calls.some((c) => c.op === "lifecycle" && c.action === "stop"));
  const r = await handlers.instabox_lifecycle({ machineId: "m_two", action: "start", requestId: REQ });
  assert.match(r.message, /resuming the paused machine/);
  const call = calls.find((c) => c.op === "lifecycle")!;
  assert.equal(call.action, "start");
  assert.equal(call.key, REQ);
});

test("save snapshot names the request and warns about /data/home", async () => {
  const { handlers, calls } = setup();
  const r = await handlers.instabox_save_snapshot({ machineId: "m_one", name: "bb-one-snap", requestId: REQ });
  assert.match(r.message, /pending/);
  assert.match(r.message, /\/data\/home/);
  const call = calls.find((c) => c.op === "snapshot")!;
  assert.equal(call.id, "m_one");
  assert.deepEqual(call.body, { name: "bb-one-snap" });
  assert.equal(call.key, REQ);
});

test("rename preserves bb's own labels and replaces user labels", async () => {
  const { handlers, calls } = setup();
  await handlers.instabox_rename({ machineId: "m_one", name: "bb-renamed", labels: { team: "agents" }, requestId: REQ });
  const call = calls.find((c) => c.op === "update")!;
  assert.equal(call.id, "m_one");
  assert.deepEqual(call.body, { name: "bb-renamed", metadata: { "bb-provider": "instabox", "bb-key": "hash", team: "agents" } });
});

test("exec redacts the hub's key, other InstaBox keys and Secret placeholders, and says it woke the machine", async () => {
  const { handlers, calls } = setup();
  const r = await handlers.instabox_exec({ machineId: "m_two", cmd: "env | grep -i key", timeoutSeconds: 30 });
  assert.equal(r.exitCode, 7);
  assert.equal(r.woke, true);
  assert.equal(r.redacted, 4);
  for (const secret of ["ibk-server-secret", "ibsec_0123456789abcdef", "ibk_abcdefghijklmnop"]) assert.ok(!`${r.stdout}${r.stderr}`.includes(secret), `${secret} leaked`);
  assert.match(r.stdout, /\[redacted INSTABOX_API_KEY\]/);
  assert.match(r.stdout, /ZAI_API_KEY=\[redacted Secret placeholder\]/);
  assert.match(r.stderr, /\[redacted InstaBox key\]/);
  const call = calls.find((c) => c.op === "exec")!;
  assert.equal(call.id, "m_two");
  assert.deepEqual(call.req, { cmd: "env | grep -i key", timeoutSeconds: 30 });
});

test("exec refuses a machine being deleted", async () => {
  const { handlers } = setup();
  await assert.rejects(handlers.instabox_exec({ machineId: "m_three", cmd: "echo hi", timeoutSeconds: 10 }), /being deleted/);
});

test("redactText replaces longest values first and counts every occurrence", () => {
  const r = redactText("a=abcd b=abcdefgh c=abcd d=abcdefgh", [
    { name: "SHORT", value: "abcd" },
    { name: "LONG", value: "abcdefgh" },
  ]);
  assert.equal(r.count, 4);
  assert.equal(r.text, "a=[redacted SHORT] b=[redacted LONG] c=[redacted SHORT] d=[redacted LONG]");
});

test("secretValues holds only the InstaBox API key", () => {
  assert.deepEqual(secretValues({ apiKey: "ibk_1234" }), [{ name: "INSTABOX_API_KEY", value: "ibk_1234" }]);
  assert.deepEqual(secretValues({ apiKey: "" }), []);
});

test("a missing key is a setup message, not an error page", async () => {
  const { deps } = setup();
  const handlers = createDashboardHandlers({ ...deps, client: async () => ({ error: "Add your InstaBox API key in Settings → Plugins → InstaBox." }) });
  const o = await handlers.instabox_overview();
  assert.equal(o.configured, false);
  assert.match(o.setupMessage ?? "", /Settings → Plugins → InstaBox/);
  assert.equal(o.machines.items, null);
});
