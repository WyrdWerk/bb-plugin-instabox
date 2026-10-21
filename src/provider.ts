// bb machine provider backed by InstaBox machines. Resource operations only: bb
// core owns enrollment (bootstrap), checkouts, retries and the machine record.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { MachineBootstrapApi, MachineExecutor } from "@get-bb/plugin-sdk";
import { agentEnvContent, agentEnvScript, hubHealthScript, identityResetScript, staleConnectionsScript, tunnelSetupScript } from "./box-scripts.ts";
import { InstaboxExecutor, runScript } from "./executor.ts";
import { type InstaboxApi, isNotFound, isRunning, type Machine, type Operation, STOPPED_STATES, SUSPENDED_STATES } from "./instabox-api.ts";
import type { TunnelManager } from "./tunnel.ts";

export const PROVIDER_ID = "instabox";

export interface Progress {
  step(text: string): void;
  log(text: string): void;
}

/** Persisted by core and readable by every plugin: ids only, never secrets. */
export const resourceSchema = z.object({ machineId: z.string(), key: z.string() });
export type InstaboxResource = z.infer<typeof resourceSchema>;

/** Non-secret per-machine overrides of the plugin settings. */
export const inputsSchema = z
  .object({
    template: z.string().min(1).optional(),
    snapshotId: z.string().min(1).optional(),
  })
  .strict();
export type InstaboxInputs = z.infer<typeof inputsSchema>;

export interface ProviderConfig {
  api: InstaboxApi;
  template: string;
  snapshotId: string | null;
  /** KEY=value pairs for the bb daemon (agent credentials). */
  agentEnv: Record<string, string>;
}

/** Recorded before the create call so a crash in between can still be cleaned up. */
export interface AllocationIntent {
  operationId: string | null;
  machineId: string | null;
}

export interface ProviderDeps {
  config(): Promise<ProviderConfig>;
  tunnels: TunnelManager;
  boxHubPort: number;
  bootstrap: MachineBootstrapApi["bootstrap"];
  intents: {
    get(key: string): Promise<AllocationIntent | undefined>;
    set(key: string, v: AllocationIntent): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /** Per-machine chisel credential store (plugin kv). */
  tunnelAuth: { get(machineId: string): Promise<string>; delete(machineId: string): Promise<void> };
  log(m: string): void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Polling interval and bounds (tests shorten them). */
  pollMs?: number;
  stateTimeoutMs?: number;
  hubGateMs?: number;
}

export const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");
/** InstaBox names are unique per account: derive one from bb's stable key. */
export const machineNameFor = (key: string) => `bb-${keyHash(key).slice(0, 12)}`;
export const metadataFor = (key: string) => ({ "bb-provider": PROVIDER_ID, "bb-key": keyHash(key).slice(0, 32) });

export class InstaboxMachineOps {
  private readonly d: ProviderDeps;
  constructor(deps: ProviderDeps) {
    this.d = deps;
  }

  private get pollMs() {
    return this.d.pollMs ?? 2000;
  }

  async create(key: string, inputs: InstaboxInputs | null, checkpoint: (r: InstaboxResource) => Promise<void>, report: Progress, signal: AbortSignal) {
    const c = await this.d.config();
    const snapshotId = inputs?.snapshotId ?? c.snapshotId;
    const template = inputs?.template ?? c.template;
    report.step(snapshotId ? `Creating an InstaBox machine from snapshot ${snapshotId}` : `Creating an InstaBox machine from template ${template}`);
    const prior = await this.d.intents.get(key);
    await this.d.intents.set(key, { operationId: prior?.operationId ?? null, machineId: prior?.machineId ?? null });
    let machineId = prior?.machineId ?? null;
    if (!machineId) {
      const body = { name: machineNameFor(key), metadata: metadataFor(key), ...(snapshotId ? { snapshotId } : { templateId: template }) };
      // Same key → same Idempotency-Key → InstaBox returns the same operation on a retry.
      const op = await c.api.createMachine(body, `bb-create-${keyHash(key).slice(0, 48)}`, signal);
      await this.d.intents.set(key, { operationId: op.id, machineId: op.machineId ?? null });
      const done = await this.waitOperation(c.api, op, signal);
      if (!done.machineId) throw new Error(`InstaBox create operation ${op.id} finished without a machine id`);
      machineId = done.machineId;
      await this.d.intents.set(key, { operationId: op.id, machineId });
    }
    const resource: InstaboxResource = { machineId, key };
    await checkpoint(resource);
    report.step(`Waiting for ${machineId} to run`);
    const machine = await this.waitFor(c.api, machineId, isRunning, signal);
    const executor = new InstaboxExecutor(c.api, machineId);
    const reset = await runScript(executor, identityResetScript(), signal, { what: "identity reset" });
    report.log(lastLine(reset));
    await this.prepare(c, executor, machineId, report, signal);
    await this.connect(c, machineId, executor, report, signal);
    report.step("Enrolling the machine in bb");
    await this.d.bootstrap({ key, executor, report, signal });
    return { name: machine.name, resource };
  }

  async suspend(resource: InstaboxResource, report: Progress, signal: AbortSignal): Promise<InstaboxResource> {
    const { api } = await this.d.config();
    this.d.tunnels.stop(resource.machineId);
    let m = await api.findMachine(resource.machineId, signal);
    if (!m) throw new Error(`InstaBox machine ${resource.machineId} is gone; its saved state is lost`);
    if (!SUSPENDED_STATES.has(m.state) && !STOPPED_STATES.has(m.state)) {
      if (m.state !== "running") m = await this.waitFor(api, m.id, (x) => x.state === "running" || SUSPENDED_STATES.has(x.state) || STOPPED_STATES.has(x.state), signal);
      if (m.state === "running") {
        report.step(`Pausing ${m.id} (memory, files and processes are kept)`);
        await this.waitOperation(api, await api.lifecycle(m.id, "suspend", signal), signal);
      }
    }
    await this.waitFor(api, resource.machineId, (x) => SUSPENDED_STATES.has(x.state) || STOPPED_STATES.has(x.state), signal);
    return resource;
  }

  async resume(resource: InstaboxResource, report: Progress, signal: AbortSignal): Promise<InstaboxResource> {
    const c = await this.d.config();
    const { api } = c;
    let m = await api.findMachine(resource.machineId, signal);
    if (!m) throw new Error(`InstaBox machine ${resource.machineId} is gone; it cannot be resumed`);
    if (!isRunning(m) && !SUSPENDED_STATES.has(m.state) && !STOPPED_STATES.has(m.state)) {
      m = await this.waitFor(api, m.id, (x) => isRunning(x) || SUSPENDED_STATES.has(x.state) || STOPPED_STATES.has(x.state), signal);
    }
    if (SUSPENDED_STATES.has(m.state)) {
      report.step(`Resuming ${m.id}`);
      await this.waitOperation(api, await api.lifecycle(m.id, "resume", signal), signal);
    } else if (STOPPED_STATES.has(m.state)) {
      report.step(`Starting ${m.id}`);
      await this.waitOperation(api, await api.lifecycle(m.id, "start", signal), signal);
    }
    await this.waitFor(api, m.id, isRunning, signal);
    const executor = new InstaboxExecutor(api, m.id);
    report.step("Closing network connections that did not survive the pause");
    report.log(lastLine(await runScript(executor, staleConnectionsScript(), signal, { what: "stale connection reset" })));
    await this.prepare(c, executor, m.id, report, signal);
    await this.connect(c, m.id, executor, report, signal);
    // Same key: bb reconnects the existing identity rather than enrolling anew.
    await this.d.bootstrap({ key: resource.key, executor, report, signal });
    return resource;
  }

  async remove(resource: InstaboxResource, report: Progress, signal: AbortSignal): Promise<void> {
    const { api } = await this.d.config();
    this.d.tunnels.stop(resource.machineId, true);
    report.step(`Deleting InstaBox machine ${resource.machineId}`);
    await this.deleteAndWait(api, resource.machineId, signal);
    await this.d.tunnelAuth.delete(resource.machineId);
    await this.d.intents.delete(resource.key);
  }

  /** Find and delete whatever an interrupted create left, by bb's key only. */
  async reconcileCleanup(key: string, signal: AbortSignal): Promise<void> {
    const { api } = await this.d.config();
    const intent = await this.d.intents.get(key);
    const ids = new Set<string>();
    if (intent?.machineId) ids.add(intent.machineId);
    if (!intent?.machineId && intent?.operationId) {
      const op = await api.getOperation(intent.operationId, signal).catch((e) => (isNotFound(e) ? null : Promise.reject(e)));
      if (op?.machineId) ids.add(op.machineId);
    }
    // Belt and braces: anything labelled with this key.
    for (const m of await api.listMachines(metadataFor(key), signal)) ids.add(m.id);
    for (const id of ids) {
      this.d.tunnels.stop(id, true);
      await this.deleteAndWait(api, id, signal);
      await this.d.tunnelAuth.delete(id);
      this.d.log(`cleanup ${key}: deleted ${id}`);
    }
    await this.d.intents.delete(key);
  }

  /** Rewrite the agent env on a running machine (after a settings change). Returns the script's last line. */
  async applyAgentEnv(machineId: string, signal: AbortSignal): Promise<string> {
    const c = await this.d.config();
    const executor = new InstaboxExecutor(c.api, machineId);
    return lastLine(await runScript(executor, agentEnvScript(), signal, { stdin: agentEnvContent(c.agentEnv), what: "agent env" }));
  }

  /** Box side of the tunnel plus the agent credentials. Idempotent. */
  private async prepare(c: ProviderConfig, executor: MachineExecutor, machineId: string, report: Progress, signal: AbortSignal) {
    report.step("Setting up the tunnel endpoint on the machine");
    const auth = await this.d.tunnelAuth.get(machineId);
    report.log(lastLine(await runScript(executor, tunnelSetupScript(), signal, { stdin: `AUTH=${auth}\n`, what: "tunnel setup", timeoutMs: 180_000 })));
    const names = Object.keys(c.agentEnv);
    report.step(`Giving the bb daemon its agent credentials (${names.length ? names.join(", ") : "none configured"})`);
    report.log(lastLine(await runScript(executor, agentEnvScript(), signal, { stdin: agentEnvContent(c.agentEnv), what: "agent env" })));
  }

  /** Open the hub-side tunnel and require the hub's /health from inside the box. */
  private async connect(c: ProviderConfig, machineId: string, executor: MachineExecutor, report: Progress, signal: AbortSignal) {
    report.step("Opening the tunnel through InstaBox's SSH gateway");
    await this.d.tunnels.ensure(c.api, machineId, signal);
    const until = Date.now() + (this.d.hubGateMs ?? 90_000);
    for (;;) {
      const { exitCode } = await executor.exec({ command: ["bash", "-c", hubHealthScript(this.d.boxHubPort)], stdin: "", timeoutMs: 15_000, signal, onOutput: () => {} });
      if (exitCode === 0) {
        report.log(`The machine reaches the bb hub at http://127.0.0.1:${this.d.boxHubPort} (tunnel)`);
        return;
      }
      if (Date.now() > until) throw new Error(`The machine cannot reach the bb hub through the tunnel (http://127.0.0.1:${this.d.boxHubPort}/health)`);
      await this.d.tunnels.ensure(c.api, machineId, signal);
      await this.d.sleep(3000, signal);
    }
  }

  private async deleteAndWait(api: InstaboxApi, machineId: string, signal: AbortSignal) {
    try {
      await api.deleteMachine(machineId, signal);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    const until = Date.now() + 3 * 60_000;
    while ((await api.findMachine(machineId, signal)) !== null) {
      if (Date.now() > until) throw new Error(`InstaBox machine ${machineId} still exists 3 min after delete`);
      await this.d.sleep(this.pollMs, signal);
    }
  }

  private async waitOperation(api: InstaboxApi, op: Operation, signal: AbortSignal): Promise<Operation> {
    const until = Date.now() + (this.d.stateTimeoutMs ?? 10 * 60_000);
    let cur = op;
    for (;;) {
      if (cur.state === "succeeded") return cur;
      if (cur.state === "failed" || cur.state === "canceled" || cur.state === "cancelled") {
        throw new Error(`InstaBox ${cur.type} operation ${cur.id} ${cur.state}: ${cur.error?.code ?? ""} ${cur.error?.message ?? ""}`.trim());
      }
      if (Date.now() > until) throw new Error(`InstaBox ${cur.type} operation ${cur.id} still ${cur.state}`);
      await this.d.sleep(this.pollMs, signal);
      cur = await api.getOperation(op.id, signal);
    }
  }

  private async waitFor(api: InstaboxApi, machineId: string, ok: (m: Machine) => boolean, signal: AbortSignal): Promise<Machine> {
    const until = Date.now() + (this.d.stateTimeoutMs ?? 10 * 60_000);
    for (;;) {
      const m = await api.findMachine(machineId, signal);
      if (!m) throw new Error(`InstaBox machine ${machineId} disappeared`);
      if (ok(m)) return m;
      if (m.state === "error") throw new Error(`InstaBox machine ${machineId} is in state error`);
      if (Date.now() > until) throw new Error(`InstaBox machine ${machineId} stuck in ${m.state}`);
      await this.d.sleep(this.pollMs, signal);
    }
  }
}

function lastLine(s: string) {
  return s.trim().split("\n").pop() ?? "";
}
