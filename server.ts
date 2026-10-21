// bb-plugin-instabox — InstaBox machines (instabox.sh) as bb machines.
//
// Experimental. Same shape as bb-plugin-boat, but the box → hub route needs no
// Tailscale and no relay: the hub holds an SSH local forward through InstaBox's
// gateway plus a chisel reverse tunnel (src/tunnel.ts). bb's direct machine
// access must point machines at that tunnel: `machineServerUrl
// http://127.0.0.1:<boxHubPort>` (default 38886). See README.md.
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DEFAULT_API_URL, InstaboxApi, type FetchLike, isRunning } from "./src/instabox-api.ts";
import { type AllocationIntent, InstaboxMachineOps, inputsSchema, PROVIDER_ID, type ProviderConfig, resourceSchema } from "./src/provider.ts";
import { TunnelManager } from "./src/tunnel.ts";
import { parseAgentSecrets, parseOpencodeProviders } from "./src/box-scripts.ts";

const COMPOSITIONS = [
  {
    id: "instabox",
    displayName: "InstaBox machine",
    description: "A NEW InstaBox machine for this thread, enrolled as a bb machine, with an isolated Git worktree. Remove the machine when done.",
    environmentProviderId: "git-worktree",
  },
  {
    id: "instabox-checkout",
    displayName: "InstaBox machine (project checkout)",
    description: "A NEW InstaBox machine for this thread, working directly in the project checkout on it.",
    environmentProviderId: "project-checkout",
  },
] as const;

const SUPERVISE_MS = 30_000;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      label: "InstaBox API key",
      description: "An ibk_… key from the InstaBox dashboard. Stored as a secret. Empty: the bb server's INSTABOX_API_KEY environment variable.",
      secret: true,
    },
    template: {
      type: "string",
      label: "Template",
      description: "InstaBox template for new machines (the free plan allows agent-browser only).",
      default: "agent-browser",
    },
    snapshotId: {
      type: "string",
      label: "Snapshot id (optional)",
      description: "Create new machines from this InstaBox snapshot instead of the template.",
      default: "",
    },
    zaiApiKey: {
      type: "string",
      label: "Z.ai API key for Claude Code",
      description:
        "Given to the bb daemon on each machine as ANTHROPIC_AUTH_TOKEN, with ANTHROPIC_BASE_URL set to the Z.ai endpoint, so the claude-code provider runs on Z.ai's GLM models. Stored as a secret. Empty: the bb server's ZAI_API_KEY environment variable.",
      secret: true,
    },
    agentSecrets: {
      type: "string",
      label: "Extra secrets for agents on every machine",
      description:
        'One-line JSON object of NAME → value, e.g. {"GH_TOKEN":"…","OPENAI_API_KEY":"…"}. Written to each machine\'s bb daemon environment (0600 file) on create and resume, and re-applied to running machines when changed, which restarts their bb daemon. Stored as a secret. Per-project values: use bb machine env set --project instead.',
      secret: true,
    },
    opencodeProviders: {
      type: "string",
      label: "OpenCode providers (model lists fetched live)",
      description:
        'JSON array of OpenAI-compatible providers: [{"id":"zro","baseURL":"https://zro.moonmath.ai/v1","keyEnv":"ZRO_API_KEY"}]. On each machine the plugin calls <baseURL>/models with the key from that env var (Z.ai key or agentSecrets) and writes OpenCode\'s config from the result; providers without a key are skipped. Refreshed on create, resume and credential changes. Empty: Z.ai coding plan, zro, coralbricks, neuralwatt.',
      experimental_multiline: true,
      default: "",
    },
    zaiBaseUrl: {
      type: "string",
      label: "Z.ai Anthropic-compatible endpoint",
      default: "https://api.z.ai/api/anthropic",
    },
    boxHubPort: {
      type: "number",
      label: "Hub port on the machine's loopback",
      description: "The tunnel opens this port on each machine. bb's machineServerUrl must be http://127.0.0.1:<this port>. Changing it needs a plugin reload.",
      default: 38886,
    },
  });

  const s0 = await settings.get();
  const boxHubPort = Math.round(s0.boxHubPort);
  const tunnelUrl = `http://127.0.0.1:${boxHubPort}`;

  async function config(): Promise<ProviderConfig> {
    const s = await settings.get();
    const apiKey = s.apiKey || process.env.INSTABOX_API_KEY || "";
    if (!apiKey) throw Object.assign(new Error("Set the InstaBox API key in the plugin settings."), { name: "NeedsConfigurationError" });
    const zai = s.zaiApiKey || process.env.ZAI_API_KEY || "";
    return {
      api: new InstaboxApi(apiKey, fetch as unknown as FetchLike, process.env.INSTABOX_API_URL || DEFAULT_API_URL),
      template: s.template || "agent-browser",
      snapshotId: s.snapshotId || null,
      // ZAI_API_KEY too, so pi and OpenCode can use their built-in Z.ai providers. User secrets win.
      agentEnv: {
        ...(zai ? { ANTHROPIC_BASE_URL: s.zaiBaseUrl, ANTHROPIC_AUTH_TOKEN: zai, API_TIMEOUT_MS: "3000000", ZAI_API_KEY: zai } : {}),
        ...parseAgentSecrets(s.agentSecrets ?? ""),
      },
      opencodeProviders: parseOpencodeProviders(s.opencodeProviders ?? ""),
    };
  }

  /** Setup problems a user can fix: missing key, or bb not pointing machines at the tunnel. */
  async function setupProblem(): Promise<string | null> {
    const s = await settings.get();
    if (!s.apiKey && !process.env.INSTABOX_API_KEY) return "Set the InstaBox API key in the plugin settings.";
    const access = (await bb.sdk.system.config()).serverAccess;
    if (access.defaultProviderId !== "direct" || access.effectiveUrl !== tunnelUrl) {
      return `InstaBox machines reach this hub through a tunnel at ${tunnelUrl}. Run: bb settings general defaultMachineAccess direct && bb settings general machineServerUrl ${tunnelUrl}`;
    }
    return null;
  }

  const authKey = (machineId: string) => `tunnel-auth/${machineId}`;
  const tunnelAuth = {
    get: async (machineId: string) => {
      const have = await bb.storage.kv.get<string>(authKey(machineId));
      if (have) return have;
      const fresh = TunnelManager.newAuth();
      await bb.storage.kv.set(authKey(machineId), fresh);
      return fresh;
    },
    delete: (machineId: string) => bb.storage.kv.delete(authKey(machineId)),
  };

  const dir = join(bb.server.experimental_dataDir, "plugins", bb.pluginId, "runtime");
  const tunnels = new TunnelManager({
    dir,
    hubPort: () => Number(new URL(bb.server.loopbackBaseUrl).port || 80),
    boxHubPort,
    log: (m) => bb.log.info(m),
    fetch,
    auth: tunnelAuth.get,
  });

  const intentKey = (key: string) => `alloc/${key}`;
  const ops = new InstaboxMachineOps({
    config,
    tunnels,
    boxHubPort,
    bootstrap: (req) => bb.experimental_machines.bootstrap(req),
    intents: {
      get: (key) => bb.storage.kv.get<AllocationIntent>(intentKey(key)),
      set: (key, v) => bb.storage.kv.set(intentKey(key), v),
      delete: (key) => bb.storage.kv.delete(intentKey(key)),
    },
    tunnelAuth,
    log: (m) => bb.log.info(m),
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
      }),
  });

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  bb.experimental_machines.register({
    id: PROVIDER_ID,
    displayName: "InstaBox",
    description: "Run bb threads on InstaBox machines, connected through InstaBox's SSH gateway (no Tailscale).",
    icon: "./instabox.svg",
    ephemeral: false,
    inputs: inputsSchema,
    async availability() {
      const p = await setupProblem();
      return p ? { status: "setup-required", message: p } : { status: "available" };
    },
    async create({ inputs, key, checkpoint, report, signal }) {
      try {
        const p = await setupProblem();
        if (p) return { status: "failed", message: p };
        const { name, resource } = await ops.create(key, inputs ?? null, checkpoint, report, signal);
        return { status: "created", name, resource };
      } catch (err) {
        signal.throwIfAborted();
        return { status: "failed", message: message(err) };
      }
    },
    async reconcileCleanup({ key, signal }) {
      try {
        await ops.reconcileCleanup(key, signal);
        return { status: "removed" };
      } catch (err) {
        signal.throwIfAborted();
        return { status: "failed", message: `InstaBox cleanup failed: ${message(err)}` };
      }
    },
    async suspend({ resource, report, signal }) {
      return { resource: await ops.suspend(resourceSchema.parse(resource), report, signal) };
    },
    async resume({ resource, report, signal }) {
      return { resource: await ops.resume(resourceSchema.parse(resource), report, signal) };
    },
    async remove({ resource, report, signal }) {
      try {
        await ops.remove(resourceSchema.parse(resource), report, signal);
        return { status: "removed" };
      } catch (err) {
        signal.throwIfAborted();
        return { status: "failed", message: `InstaBox remove failed: ${message(err)}` };
      }
    },
  });

  for (const c of COMPOSITIONS) bb.experimental_environments.register({ ...c, icon: "./instabox.svg", machineProviderId: PROVIDER_ID });

  // Supervisor: keep a tunnel up for every running InstaBox machine bb knows
  // (after a bb restart, a dropped SSH session, or a certificate near expiry).
  // A machine InstaBox paused on its own (idle pause) is marked suspended in bb,
  // so bb resumes it through this provider when it is needed again.
  let busy = false;
  const supervise = async () => {
    if (busy) return;
    busy = true;
    try {
      const c = await config();
      const ours = new Set<string>();
      for (const h of await bb.sdk.hosts.list()) {
        if (h.machineProviderId !== PROVIDER_ID) continue;
        const parsed = resourceSchema.safeParse(await bb.experimental_machines.getResource(h.id));
        if (!parsed.success) continue;
        const id = parsed.data.machineId;
        const phase = h.lifecycle.phase;
        if (phase === "destroyed" || phase === "removing") continue;
        ours.add(id);
        if (phase !== "active") continue; // creating/suspending/resuming: the provider call owns the tunnel
        const m = await c.api.findMachine(id);
        if (m && isRunning(m)) {
          await tunnels.ensure(c.api, id).catch((err) => bb.log.warn(`tunnel ${id}: ${message(err)}`));
        } else if (m && (m.state === "suspended" || m.state === "stopped")) {
          tunnels.stop(id);
          bb.log.info(`${id} is ${m.state} on InstaBox (idle pause?); marking ${h.id} suspended in bb`);
          await bb.sdk.hosts.experimental_suspend({ hostId: h.id }).catch((err) => bb.log.warn(`suspend ${h.id}: ${message(err)}`));
        }
      }
      for (const id of tunnels.active()) if (!ours.has(id)) tunnels.stop(id);
    } catch (err) {
      if ((err as Error).name !== "NeedsConfigurationError") bb.log.warn(`InstaBox supervisor: ${message(err)}`);
    } finally {
      busy = false;
    }
  };
  // Credential settings changed: re-apply the agent env on every running InstaBox machine.
  settings.onChange((next, prev) => {
    if (next.agentSecrets === prev.agentSecrets && next.zaiApiKey === prev.zaiApiKey && next.zaiBaseUrl === prev.zaiBaseUrl && next.opencodeProviders === prev.opencodeProviders) return;
    void (async () => {
      for (const h of await bb.sdk.hosts.list()) {
        if (h.machineProviderId !== PROVIDER_ID || h.lifecycle.phase !== "active") continue;
        const parsed = resourceSchema.safeParse(await bb.experimental_machines.getResource(h.id));
        if (!parsed.success) continue;
        await ops
          .applyAgentEnv(parsed.data.machineId, AbortSignal.timeout(120_000))
          .then((line) => bb.log.info(`${h.id}: ${line}`))
          .catch((err) => bb.log.warn(`agent env ${h.id}: ${message(err)}`));
      }
    })();
  });

  const timer = setInterval(() => void supervise(), SUPERVISE_MS);
  setTimeout(() => void supervise(), 2000);
  bb.onDispose(() => {
    clearInterval(timer);
    tunnels.stopAll();
  });

  if (!s0.apiKey && !process.env.INSTABOX_API_KEY) bb.status.needsConfiguration("Set the InstaBox API key in the plugin settings.");
}
