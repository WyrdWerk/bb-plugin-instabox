// bb-plugin-instabox — InstaBox machines (instabox.sh) as bb machines.
//
// Experimental. Same shape as bb-plugin-boat, but the box → hub route needs no
// Tailscale and no relay: the hub holds an SSH local forward through InstaBox's
// gateway plus a chisel reverse tunnel (src/tunnel.ts). Machines must be handed
// that tunnel's loopback URL http://127.0.0.1:<boxHubPort> (default 38886): the
// plugin registers the "InstaBox tunnel" machine access for it (bb setting
// defaultMachineAccess instabox-tunnel). See README.md.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { BbPluginApi, JsonValue } from "@get-bb/plugin-sdk";
import { DEFAULT_API_URL, InstaboxApi, type FetchLike, isRunning } from "./src/instabox-api.ts";
import { ACCESS_PROVIDER_ID, type AllocationIntent, InstaboxMachineOps, inputsSchema, PROVIDER_ID, type ProviderConfig, resourceSchema, tunnelGrant } from "./src/provider.ts";
import { TunnelManager } from "./src/tunnel.ts";
import { parseOpencodeProviders } from "./src/box-scripts.ts";
import { ActivityLeases, IdleWatch } from "./src/activity.ts";
import { createDashboardHandlers, dashboardRpc, INSTABOX_CHANGED } from "./src/dashboard.ts";
import { createRepoLister, type GhRun, resolveOwners } from "./src/github-repos.ts";
import { ProjectStore } from "./src/project-store.ts";
import { hubCloneArgs, importListing, importRepo } from "./src/github-import.ts";

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
/** This plugin's bb id (from the package name bb-plugin-instabox); bb keys machine-access grants by it. */
const PLUGIN_ID = "instabox";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      label: "InstaBox API key",
      description: "An ibk_… key from the InstaBox dashboard. Required. Stored as a secret on this hub and masked after saving; there is no environment-variable or command-line fallback.",
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
      description: "Create new machines from this InstaBox snapshot instead of the template. A runner snapshot should hold no logins or keys; snapshots include /data/home.",
      default: "",
    },
    idlePauseSeconds: {
      type: "number",
      label: "Idle pause for new machines (seconds)",
      description:
        "Default autoSuspendAfterSeconds on machines this plugin creates. 300 = 5 min. 0 sends nothing and leaves InstaBox's account default alone; it does not turn the pause off. Each machine can be changed on the InstaBox page. A connected runner is paused by this plugin (through bb) once no bb thread on it has been starting or active for this long, because InstaBox counts the tunnel\'s SSH traffic as activity; the next message resumes it. While a thread works the plugin also holds an InstaBox activity lease.",
      default: 300,
      experimental_schema: z.number().int().min(0).max(86_400),
    },
    opencodeProviders: {
      type: "string",
      label: "OpenCode providers (model lists fetched live)",
      description:
        'JSON array of OpenAI-compatible providers: [{"id":"zro","baseURL":"https://zro.moonmath.ai/v1","keyEnv":"ZRO_API_KEY"}]. On each machine the plugin calls <baseURL>/models with the org Secret placeholder in that env var and writes OpenCode\'s and Pi\'s configs from the result; providers without a key are skipped. Refreshed on create, resume and provider changes. Empty: the eight providers backed by this org\'s Secrets (Z.ai, zro, coralbricks, neuralwatt, deepseek, hypercharm, singularity, runinfra).',
      experimental_multiline: true,
      default: "",
    },
    githubOwners: {
      type: "string",
      label: "GitHub owners for the repo picker",
      description: "Comma list of GitHub users/orgs whose repos the Projects editor offers (`gh repo list` on this bb server). Empty: WyrdWerk plus the account gh is logged in as.",
      default: "",
    },
    createMissingProjects: {
      type: "boolean",
      label: "Create bb projects for unmatched repos",
      description: "When a repo cloned for a project runner matches no bb project by git remote, create a bb project from the clone on the runner. Off: the clone is left unregistered (logged).",
      default: false,
    },
    hubCheckoutDir: {
      type: "string",
      label: "Hub checkout directory (Import from GitHub)",
      description: "Absolute directory on this bb server for the checkouts of repos imported as bb projects (InstaBox page → Import from GitHub). An existing <dir>/<repo> whose origin is that repo is reused; otherwise the repo is cloned there with the server's gh login (no token stored), or into <dir>/<owner>/<repo> when <dir>/<repo> holds another repo. Empty: ~/bb-github.",
      default: "",
    },
    boxHubPort: {
      type: "number",
      label: "Hub port on the machine's loopback",
      description: "The tunnel opens this port on each machine. The InstaBox tunnel machine access hands machines http://127.0.0.1:<this port>. Changing it needs a plugin reload.",
      default: 38886,
    },
  });

  const s0 = await settings.get();
  const boxHubPort = Math.round(s0.boxHubPort);
  const tunnelUrl = `http://127.0.0.1:${boxHubPort}`;

  async function configOrError(): Promise<ProviderConfig | { error: string }> {
    const s = await settings.get();
    const apiKey = s.apiKey || "";
    if (!apiKey) return { error: "Add your InstaBox API key in Settings → Plugins → InstaBox." };
    const idle = Math.round(s.idlePauseSeconds ?? 300);
    return {
      api: new InstaboxApi(apiKey, fetch as unknown as FetchLike, process.env.INSTABOX_API_URL || DEFAULT_API_URL),
      template: s.template || "agent-browser",
      snapshotId: s.snapshotId || null,
      // 0 = send nothing: InstaBox's account default. It does not mean "off".
      autoSuspendAfterSeconds: idle > 0 ? idle : null,
      opencodeProviders: parseOpencodeProviders(s.opencodeProviders ?? ""),
      createMissingProjects: s.createMissingProjects === true,
    };
  }

  async function config(): Promise<ProviderConfig> {
    const c = await configOrError();
    if ("error" in c) throw Object.assign(new Error(c.error), { name: "NeedsConfigurationError" });
    return c;
  }

  /**
   * bb hands machines the tunnel URL through this plugin's "InstaBox tunnel"
   * access, or through the older direct setting with the loopback URL. Both
   * connect machines; the older one also makes bb's web UI disable Send for new
   * InstaBox machines (it treats a loopback URL as unreachable), so it only
   * works from the CLI.
   */
  async function accessState(): Promise<"tunnel" | "legacy" | "wrong"> {
    const access = (await bb.sdk.system.config()).serverAccess;
    if (access.defaultProviderId === ACCESS_PROVIDER_ID) return "tunnel";
    return access.defaultProviderId === "direct" && access.effectiveUrl === tunnelUrl ? "legacy" : "wrong";
  }
  const chooseTunnel = `In Settings → Machines → Machine access choose "InstaBox tunnel", or run: bb settings general defaultMachineAccess ${ACCESS_PROVIDER_ID}`;

  /** Problems that stop machines from connecting: missing key, or bb not handing machines the tunnel. */
  async function setupProblem(): Promise<string | null> {
    const c = await configOrError();
    if ("error" in c) return c.error;
    return wrongAccess();
  }

  async function wrongAccess(): Promise<string | null> {
    if ((await accessState()) !== "wrong") return null;
    const access = (await bb.sdk.system.config()).serverAccess;
    return `bb is handing machines ${access.effectiveUrl ?? "(no URL)"} (${access.defaultProviderId ?? "no provider"}), not the InstaBox tunnel ${tunnelUrl}. ${chooseTunnel}`;
  }

  /** For the InstaBox page: also flags the older setting that only works from the CLI. */
  async function hubWarning(): Promise<string | null> {
    if ((await accessState()) === "legacy") {
      return `Machine access is "Manual" with ${tunnelUrl}. Machines connect, but bb's New thread screen treats a loopback address as unreachable and disables Send for InstaBox machines. ${chooseTunnel}`;
    }
    return wrongAccess();
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

  // Project runners: plugin-owned projects and the gh-backed repo/branch picker.
  const projectStore = new ProjectStore(bb.storage.kv);
  const runGh: GhRun = (args) =>
    new Promise((resolve, reject) => {
      execFile("gh", args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(err);
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  const github = createRepoLister({
    runGh,
    now: () => Date.now(),
    owners: async () =>
      resolveOwners((await settings.get()).githubOwners ?? "", async () => {
        const r = await runGh(["api", "user", "--jq", ".login"]);
        return r.code === 0 ? r.stdout.trim() || null : null;
      }),
  });
  type BbProject = { id: string; name: string; gitRemoteUrl: string | null; sources?: { hostId: string; path: string }[] };

  // Import from GitHub: bb projects backed by checkouts on the hub (bb creates
  // projects only from a local path, and reads the git remote from it).
  const git = (args: string[], cwd?: string) =>
    new Promise<string>((resolve, reject) => {
      execFile("git", args, { cwd, timeout: 600_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) =>
        err ? reject(new Error(String(stderr).trim().split("\n").pop() || err.message)) : resolve(String(stdout)),
      );
    });
  const checkoutDir = async () => {
    const d = ((await settings.get()).hubCheckoutDir ?? "").trim();
    return d.startsWith("/") ? d : join(homedir(), "bb-github");
  };
  const bbProjects = async () => ((await bb.sdk.projects.list()) as unknown as BbProject[]).map((p) => ({ id: p.id, name: p.name, gitRemoteUrl: p.gitRemoteUrl }));
  const githubImport = {
    async list(force: boolean) {
      const r = await github.repos(force);
      if (r.status !== "ok") return r;
      return { status: "ok" as const, checkoutDir: await checkoutDir(), repos: importListing(r.repos, await bbProjects()) };
    },
    async run(repos: { owner: string; name: string }[]) {
      const listed = await github.repos(false);
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      const dir = await checkoutDir();
      const results = [];
      for (const r of repos) {
        // Only repos the picker offers (configured owners, visible to gh).
        if (listed.status !== "ok" || !listed.repos.some((x) => x.owner.toLowerCase() === r.owner.toLowerCase() && x.name === r.name)) {
          results.push({ repo: `${r.owner}/${r.name}`, status: "failed" as const, message: "not in the repo list for the configured GitHub owners" });
          continue;
        }
        if (!hostId) {
          results.push({ repo: `${r.owner}/${r.name}`, status: "failed" as const, message: "bb has no primary host to keep the checkout on" });
          continue;
        }
        const res = await importRepo(
          { owner: r.owner, name: r.name, url: `https://github.com/${r.owner}/${r.name}.git` },
          {
            checkoutDir: dir,
            listProjects: bbProjects,
            originOf: async (path) => {
              if (!existsSync(path)) return null;
              return (await git(["-C", path, "remote", "get-url", "origin"]).catch(() => "")).trim();
            },
            clone: async (url, path) => {
              await mkdir(dirname(path), { recursive: true });
              await git(hubCloneArgs(url, path));
            },
            createProject: async ({ name, path }) => ({ id: ((await bb.sdk.projects.create({ name, source: { type: "local_path", hostId, path } })) as unknown as { id: string }).id }),
            sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)),
          },
        );
        bb.log.info(`github import ${res.repo}: ${res.status}${res.status === "created" ? ` (${res.checkout} checkout ${res.path}, ${res.projectId})` : res.status === "failed" ? ` (${res.message})` : ""}`);
        results.push(res);
      }
      return results;
    },
  };

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
    projects: {
      getProject: (name) => projectStore.get(name),
      listProjects: async () =>
        ((await bb.sdk.projects.list()) as unknown as BbProject[]).map((p) => ({
          id: p.id,
          name: p.name,
          gitRemoteUrl: p.gitRemoteUrl,
          sources: (p.sources ?? []).map((x) => ({ hostId: x.hostId, path: x.path })),
        })),
      addProjectSource: async ({ projectId, hostId, path }) => void (await bb.sdk.projects.sources.add({ projectId, type: "local_path", hostId, path })),
      createProject: async ({ name, hostId, path }) => ({ id: ((await bb.sdk.projects.create({ name, source: { type: "local_path", hostId, path } })) as unknown as { id: string }).id }),
    },
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

  // Machine access: hands InstaBox machines the tunnel's loopback URL. Make it
  // the default with `bb settings general defaultMachineAccess instabox-tunnel`.
  bb.experimental_serverAccess.register({
    id: ACCESS_PROVIDER_ID,
    displayName: "InstaBox tunnel",
    description: `InstaBox machines reach this hub through the plugin's SSH tunnel at ${tunnelUrl} on the machine. Other machines are refused.`,
    async availability() {
      const c = await configOrError();
      return "error" in c ? { status: "setup-required", message: c.error } : { status: "available", serverUrl: tunnelUrl };
    },
    async acquire({ key, hostId }) {
      return tunnelGrant(PLUGIN_ID, key, hostId, tunnelUrl);
    },
    // Nothing to release: the tunnel is torn down with the machine.
    async release() {},
  });

  for (const c of COMPOSITIONS) bb.experimental_environments.register({ ...c, icon: "./instabox.svg", machineProviderId: PROVIDER_ID });

  // Supervisor: keep a tunnel up for every running InstaBox machine bb knows
  // (after a bb restart, a dropped SSH session, or a certificate near expiry),
  // and hold an InstaBox activity lease while a bb thread is working on it.
  // A machine InstaBox paused on its own (idle pause) is marked suspended in
  // bb, so bb resumes it through this provider when it is needed again.
  const leases = new ActivityLeases();
  const idle = new IdleWatch();
  let busy = false;
  const busyThreads = async (hostId: string) =>
    (await bb.sdk.threads.count({ hostId, status: "starting" })).total + (await bb.sdk.threads.count({ hostId, status: "active" })).total;
  const supervise = async () => {
    if (busy) return;
    busy = true;
    const ours = new Set<string>();
    try {
      const c = await config();
      for (const h of await bb.sdk.hosts.list()) {
        if (h.machineProviderId !== PROVIDER_ID) continue;
        const parsed = resourceSchema.safeParse(await bb.experimental_machines.getResource(h.id));
        if (!parsed.success) continue;
        const id = parsed.data.machineId;
        const phase = h.lifecycle.phase;
        if (phase === "destroyed" || phase === "removing") {
          leases.forget(id);
          idle.forget(id);
          continue;
        }
        ours.add(id);
        if (phase !== "active") {
          // creating/suspending/resuming: the provider call owns the tunnel and
          // there is no turn to protect. Any lease we held expires by itself.
          leases.forget(id);
          idle.forget(id);
          continue;
        }
        const m = await c.api.findMachine(id);
        if (m && isRunning(m)) {
          await tunnels.ensure(c.api, id).catch((err) => bb.log.warn(`tunnel ${id}: ${message(err)}`));
          const n = await busyThreads(h.id);
          await leases.sync(c.api, id, h.id, n > 0).catch((err) => bb.log.warn(`activity lease ${id}: ${message(err)}`));
          if (idle.observe(id, n > 0, m.autoSuspendAfterSeconds, Date.now())) {
            idle.forget(id);
            bb.log.info(`${id}: no bb thread busy for ${m.autoSuspendAfterSeconds}s (its idle pause); pausing ${h.id}`);
            await bb.sdk.hosts.experimental_suspend({ hostId: h.id }).catch((err) => bb.log.warn(`idle pause ${h.id}: ${message(err)}`));
            bb.realtime.publish(INSTABOX_CHANGED, {});
          }
        } else if (m && (m.state === "suspended" || m.state === "stopped")) {
          leases.forget(id);
          idle.forget(id);
          tunnels.stop(id);
          bb.log.info(`${id} is ${m.state} on InstaBox (idle pause?); marking ${h.id} suspended in bb`);
          await bb.sdk.hosts.experimental_suspend({ hostId: h.id }).catch((err) => bb.log.warn(`suspend ${h.id}: ${message(err)}`));
          bb.realtime.publish(INSTABOX_CHANGED, {});
        }
      }
      // Orphans only: a create or resume in progress owns its tunnel even before bb lists its resource.
      for (const id of tunnels.active()) if (!ours.has(id) && !ops.inFlight.has(id)) tunnels.stop(id);
      leases.retain(ours);
      idle.retain(ours);
    } catch (err) {
      if ((err as Error).name !== "NeedsConfigurationError") bb.log.warn(`InstaBox supervisor: ${message(err)}`);
    } finally {
      busy = false;
    }
  };
  // Provider list changed: rewrite Pi's and OpenCode's configs on every running InstaBox machine.
  settings.onChange((next, prev) => {
    if (next.opencodeProviders === prev.opencodeProviders) return;
    void (async () => {
      for (const h of await bb.sdk.hosts.list()) {
        if (h.machineProviderId !== PROVIDER_ID || h.lifecycle.phase !== "active") continue;
        const parsed = resourceSchema.safeParse(await bb.experimental_machines.getResource(h.id));
        if (!parsed.success) continue;
        await ops
          .applyAgentConfig(parsed.data.machineId, AbortSignal.timeout(120_000))
          .then((line) => bb.log.info(`${h.id}: ${line}`))
          .catch((err) => bb.log.warn(`agent config ${h.id}: ${message(err)}`));
      }
      bb.realtime.publish(INSTABOX_CHANGED, {});
    })();
  });

  const timer = setInterval(() => void supervise(), SUPERVISE_MS);
  setTimeout(() => void supervise(), 2000);
  bb.onDispose(() => {
    clearInterval(timer);
    leases.clear();
    tunnels.stopAll();
  });

  // InstaBox page (app.tsx): data and actions over typed RPC; the key never
  // leaves the server, and exec output is redacted before it does.
  bb.rpc.register(
    dashboardRpc,
    createDashboardHandlers({
      client: async () => {
        const c = await configOrError();
        return "error" in c ? c : { api: c.api };
      },
      settings: async () => {
        const s = await settings.get();
        return {
          apiKey: s.apiKey || "",
          snapshotId: s.snapshotId ?? "",
          template: s.template || "agent-browser",
          idlePauseSeconds: Math.round(s.idlePauseSeconds ?? 300),
        };
      },
      hosts: async () =>
        (await bb.sdk.hosts.list()).map((h) => ({
          id: h.id,
          name: h.name,
          status: h.status,
          machineProviderId: h.machineProviderId,
          phase: h.lifecycle.phase,
        })),
      getResource: (hostId) => bb.experimental_machines.getResource(hostId),
      createMachine: async ({ key, inputs }) => {
        const h = await bb.sdk.hosts.experimental_create({ machineProviderId: PROVIDER_ID, key, inputs: inputs as JsonValue, wait: false });
        return { hostId: h.id, name: h.name ?? null };
      },
      publish: () => bb.realtime.publish(INSTABOX_CHANGED, {}),
      now: () => Date.now(),
      hubWarning,
      projectStore,
      github,
      githubImport,
    }),
  );

  const c = await configOrError();
  if ("error" in c) bb.status.needsConfiguration(c.error);
}
