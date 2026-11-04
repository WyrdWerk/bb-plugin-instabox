// Server side of the InstaBox page: a typed RPC contract and its handlers.
//
// The InstaBox API key stays here. Every output is built from an explicit zod
// schema, so connection certificates, SSH tokens, public-port URLs, desktop
// stream URLs and CSRF tokens cannot reach the frontend even if the API starts
// returning them. The one place output is passed through is the run-command
// box; it is redacted with every secret value this plugin injected before it
// leaves the server.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { idlePolicy, normalizeIdleSeconds } from "./idle.ts";
import { type InstaboxApi, InstaboxApiError, isNotFound, isRunning, type Machine, type MachineMetric, STOPPED_STATES, SUSPENDED_STATES, TRANSITIONAL_STATES } from "./instabox-api.ts";
import type { BranchListResult, RepoListResult } from "./github-repos.ts";
import type { ProjectStore } from "./project-store.ts";
import { PROJECT_NAME_RE, repoInputSchema } from "./projects.ts";
import { PROVIDER_ID } from "./provider.ts";

/** Realtime channel the page and sidebar badge listen on; published after every change. */
export const INSTABOX_CHANGED = "instabox-changed";

const machineId = z.string().regex(/^m_[A-Za-z0-9]+$/, "not an InstaBox machine id");
const snapshotId = z.string().regex(/^(sn|im)_[A-Za-z0-9]+$/, "not an InstaBox snapshot id");
const machineName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lowercase letters, digits and dashes, starting with a letter or digit");
const requestId = z.string().uuid();
const labelKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/, "letters, digits, _ . -");

const machineBbDto = z.object({
  hostId: z.string(),
  name: z.string(),
  status: z.string(),
  phase: z.string(),
});

const machineMetricsDto = z.object({
  at: z.string(),
  cpuUsedPct: z.number(),
  cpuCount: z.number(),
  memUsed: z.number(),
  memTotal: z.number(),
  diskUsed: z.number().nullable(),
  diskTotal: z.number().nullable(),
});

export const machineDto = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  free: z.boolean(),
  ready: z.boolean(),
  templateId: z.string().nullable(),
  templateVersion: z.string().nullable(),
  snapshotId: z.string().nullable(),
  vcpus: z.number().nullable(),
  memMiB: z.number().nullable(),
  diskGiB: z.number().nullable(),
  rootDiskGiB: z.number().nullable(),
  /** Seconds; null = InstaBox's account default. 0 = off. */
  autoSuspendAfterSeconds: z.number().nullable(),
  autoSuspendedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  runStartedAt: z.string().nullable(),
  cooldownUntil: z.string().nullable(),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
  metadata: z.record(z.string(), z.string()),
  bbMachine: machineBbDto.nullable(),
  metrics: machineMetricsDto.nullable(),
});
export type MachineDto = z.infer<typeof machineDto>;

export const snapshotDto = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  sourceMachineId: z.string(),
  dataSizeBytes: z.number().nullable(),
  rootSizeBytes: z.number().nullable(),
  createdAt: z.string().nullable(),
  templateId: z.string().nullable(),
  description: z.string().nullable(),
  error: z.string().nullable(),
  /** This snapshot is the plugin's configured runner source. */
  configured: z.boolean(),
});
export type SnapshotDto = z.infer<typeof snapshotDto>;

export const templateDto = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().nullable(),
  vcpus: z.number().nullable(),
  memMiB: z.number().nullable(),
  diskGiB: z.number().nullable(),
  default: z.boolean(),
});
export type TemplateDto = z.infer<typeof templateDto>;

export const accountDto = z.object({
  login: z.string(),
  orgName: z.string(),
  tier: z.string(),
  manualLifecycle: z.boolean(),
  alwaysOnAllowed: z.boolean(),
  canDisableIdle: z.boolean(),
  idleChoicesSeconds: z.array(z.number()),
  defaultIdleSeconds: z.number().nullable(),
  maxMachines: z.number().nullable(),
  maxRunning: z.number().nullable(),
  maxSnapshots: z.number().nullable(),
  maxStoredGiB: z.number().nullable(),
  machinesUsed: z.number(),
  snapshotsUsed: z.number(),
  storedBytes: z.number().nullable(),
  logicalBytes: z.number().nullable(),
  allocatedDiskGiB: z.number().nullable(),
  vcpuHours: z.number().nullable(),
  memGiBHours: z.number().nullable(),
  storageGiBHours: z.number().nullable(),
  egressGiB: z.number().nullable(),
  costUSD: z.number().nullable(),
  allowanceUSD: z.number().nullable(),
  creditRemainingUSD: z.number().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
});
export type AccountDto = z.infer<typeof accountDto>;

const section = <T extends z.ZodType>(item: T) => z.object({ items: item.nullable(), error: z.string().nullable() });

export const overviewDto = z.object({
  configured: z.boolean(),
  setupMessage: z.string().nullable(),
  /** bb's machineServerUrl / defaultMachineAccess do not point at this tunnel. */
  hubWarning: z.string().nullable(),
  fetchedAt: z.string(),
  account: accountDto.nullable(),
  accountError: z.string().nullable(),
  machines: section(z.array(machineDto)),
  snapshots: section(z.array(snapshotDto)),
  templates: section(z.array(templateDto)),
});
export type OverviewDto = z.infer<typeof overviewDto>;

const actionResult = z.object({ ok: z.literal(true), message: z.string() });
const createResult = actionResult.extend({ hostId: z.string().nullable() });

export const idleChoicesDto = z.object({
  choices: z.array(z.number()),
  defaultSeconds: z.number().nullable(),
  manualLifecycle: z.boolean(),
  alwaysOnAllowed: z.boolean(),
  canDisable: z.boolean(),
  error: z.string().nullable(),
});
export type IdleChoicesDto = z.infer<typeof idleChoicesDto>;

export const execResultDto = z.object({
  ok: z.literal(true),
  machineName: z.string(),
  exitCode: z.number(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  /** How many secret values the plugin injected were replaced in the output. */
  redacted: z.number(),
  /** The command ran on a paused/stopped machine, which InstaBox woke (billing). */
  woke: z.boolean(),
});
export type ExecResultDto = z.infer<typeof execResultDto>;

const projectDto = z.object({
  name: z.string(),
  repos: z.array(z.object({ name: z.string(), url: z.string(), branch: z.string().optional() })),
});
const repoListDto = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    owners: z.array(z.string()),
    repos: z.array(z.object({ owner: z.string(), name: z.string(), url: z.string(), isPrivate: z.boolean(), defaultBranch: z.string().nullable() })),
    fetchedAt: z.number(),
    cached: z.boolean(),
  }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
const branchListDto = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), defaultBranch: z.string().nullable(), branches: z.array(z.string()) }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);

export const dashboardRpc = defineRpcContract({
  // Project runners (InstaBox page → Projects). Names and URLs only; never tokens.
  projects_list: { input: z.null(), output: z.object({ projects: z.array(projectDto) }) },
  project_create: { input: z.object({ name: z.string() }), output: projectDto },
  project_rename: { input: z.object({ name: z.string(), newName: z.string() }), output: projectDto },
  project_delete: { input: z.object({ name: z.string(), confirmName: z.string() }), output: z.object({ ok: z.literal(true) }) },
  project_repo_add: { input: z.object({ project: z.string(), repo: repoInputSchema }), output: projectDto },
  project_repo_update: { input: z.object({ project: z.string(), repoName: z.string(), repo: repoInputSchema }), output: projectDto },
  project_repo_remove: { input: z.object({ project: z.string(), repoName: z.string() }), output: projectDto },
  repos_list: { input: z.object({ refresh: z.boolean() }), output: repoListDto },
  repo_branches: { input: z.object({ owner: z.string(), repo: z.string(), refresh: z.boolean() }), output: branchListDto },
  instabox_overview: { input: z.null(), output: overviewDto },
  instabox_summary: { input: z.null(), output: z.object({ running: z.number().nullable(), total: z.number().nullable() }) },
  instabox_idle_choices: { input: z.null(), output: idleChoicesDto },
  instabox_lifecycle: {
    input: z.object({ machineId, action: z.enum(["start", "stop", "suspend", "resume"]), requestId }),
    output: actionResult,
  },
  instabox_save_snapshot: {
    input: z.object({ machineId, name: machineName, description: z.string().max(500).optional(), requestId }),
    output: actionResult,
  },
  instabox_set_idle: {
    input: z.object({ machineId, seconds: z.number().int().min(0).max(86_400), requestId }),
    output: actionResult,
  },
  instabox_rename: {
    input: z.object({
      machineId,
      name: machineName,
      /** null: keep the current labels. */
      labels: z.record(labelKey, z.string().max(256)).nullable(),
      requestId,
    }),
    output: actionResult,
  },
  instabox_create_machine: {
    input: z.object({
      /** Required for a plain machine; ignored when bb names its own runner. */
      name: machineName.nullable(),
      source: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("template"), templateId: z.string().min(1).max(128) }),
        z.object({ kind: z.literal("snapshot"), snapshotId }),
      ]),
      /** null: InstaBox's account default. */
      idleSeconds: z.number().int().min(0).max(86_400).nullable(),
      asRunner: z.boolean(),
      /** bb runners only: clone this plugin project's repos and register them in bb. */
      project: z.string().regex(PROJECT_NAME_RE).nullable().optional(),
      requestId,
    }),
    output: createResult,
  },
  instabox_delete_machine: { input: z.object({ machineId, confirmName: z.string(), requestId }), output: actionResult },
  instabox_delete_snapshot: { input: z.object({ snapshotId, confirmName: z.string(), requestId }), output: actionResult },
  instabox_exec: {
    input: z.object({ machineId, cmd: z.string().min(1).max(65_536), timeoutSeconds: z.number().int().min(1).max(600).default(60) }),
    output: execResultDto,
  },
});

export type DashboardRpc = typeof dashboardRpc;

export interface DashboardHost {
  id: string;
  name: string;
  status: string;
  machineProviderId: string | null;
  phase: string;
}

export interface DashboardSettings {
  /** The plugin's InstaBox API key, for redaction only. */
  apiKey: string;
  snapshotId: string;
  template: string;
  /** Default idle pause for new machines; 0 means "do not send one". */
  idlePauseSeconds: number;
}

export interface DashboardDeps {
  /** Configured client, or the setup message to show. */
  client(): Promise<{ api: InstaboxApi } | { error: string }>;
  settings(): Promise<DashboardSettings>;
  hosts(): Promise<DashboardHost[]>;
  getResource(hostId: string): Promise<unknown | null>;
  /** bb core create, so a "new machine as bb runner" goes through enrollment. */
  createMachine?(args: { key: string; inputs: Record<string, unknown> }): Promise<{ hostId: string; name: string | null }>;
  publish(): void;
  now(): number;
  hubWarning?(): Promise<string | null>;
  cacheMs?: number;
  projectStore?: ProjectStore;
  github?: { repos(force: boolean): Promise<RepoListResult>; branches(owner: string, repo: string, force: boolean): Promise<BranchListResult> };
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isConfigured = (v: { error: string } | { api: InstaboxApi }): v is { api: InstaboxApi } => "api" in v;

export interface SecretValue {
  name: string;
  value: string;
}

/** Secret values the hub knows, for output redaction. Runners only ever hold Secret placeholders. */
export function secretValues(s: Pick<DashboardSettings, "apiKey">): SecretValue[] {
  return [{ name: "INSTABOX_API_KEY", value: s.apiKey }].filter((v) => v.value.length >= 4);
}

/** Replace every occurrence of a known secret; longest first, never echo it. */
export function redactText(text: string, secrets: SecretValue[]): { text: string; count: number } {
  let out = text;
  let count = 0;
  const seen = new Set<string>();
  for (const { name, value } of [...secrets].sort((a, b) => b.value.length - a.value.length)) {
    if (value.length < 4 || seen.has(value)) continue;
    seen.add(value);
    const parts = out.split(value);
    if (parts.length > 1) {
      count += parts.length - 1;
      out = parts.join(`[redacted ${name}]`);
    }
  }
  // Any other InstaBox API key, and the org Secret placeholders the guest sees.
  out = out.replace(/\bib(k|sec)_[A-Za-z0-9_-]{8,}/g, (_m, kind: string) => {
    count++;
    return kind === "k" ? "[redacted InstaBox key]" : "[redacted Secret placeholder]";
  });
  return { text: out, count };
}

function toMachineDto(m: Machine, bb: MachineDto["bbMachine"], metric: MachineMetric | null): MachineDto {
  return machineDto.parse({
    id: m.id,
    name: m.name,
    state: m.state,
    free: m.free === true,
    ready: m.runtime?.ready !== false && m.state === "running",
    templateId: m.template?.id ?? null,
    templateVersion: m.template?.version ?? null,
    snapshotId: m.snapshot?.id ?? null,
    vcpus: m.spec?.vcpus ?? null,
    memMiB: m.spec?.memMiB ?? null,
    diskGiB: m.spec?.persistentDiskGiB ?? null,
    rootDiskGiB: m.spec?.rootDiskGiB ?? null,
    autoSuspendAfterSeconds: m.autoSuspendAfterSeconds ?? null,
    autoSuspendedAt: m.autoSuspendedAt ?? null,
    createdAt: m.createdAt ?? null,
    runStartedAt: m.runStartedAt ?? null,
    cooldownUntil: m.cooldownUntil ?? null,
    lastError: m.lastError ? { code: String(m.lastError.code ?? "error"), message: String(m.lastError.message ?? "") } : null,
    metadata: m.metadata ?? {},
    bbMachine: bb,
    metrics: metric
      ? {
          at: metric.timestamp,
          cpuUsedPct: metric.cpuUsedPct,
          cpuCount: metric.cpuCount,
          memUsed: metric.memUsed,
          memTotal: metric.memTotal,
          diskUsed: metric.diskUsed ?? null,
          diskTotal: metric.diskTotal ?? null,
        }
      : null,
  });
}

function toSnapshotDto(s: Awaited<ReturnType<InstaboxApi["listSnapshots"]>>[number], configuredId: string): SnapshotDto {
  return snapshotDto.parse({
    id: s.id,
    name: s.name,
    status: s.status,
    sourceMachineId: s.sourceMachineId,
    dataSizeBytes: s.dataSizeBytes ?? null,
    rootSizeBytes: s.rootSizeBytes ?? null,
    createdAt: s.createdAt ?? null,
    templateId: s.template?.id ?? null,
    description: s.description ?? null,
    error: s.error ?? null,
    configured: configuredId !== "" && s.id === configuredId,
  });
}

/** InstaBox machine id → the bb machine using it (provider resource, never names). */
async function machineIndex(deps: DashboardDeps): Promise<Map<string, NonNullable<MachineDto["bbMachine"]>>> {
  const index = new Map<string, NonNullable<MachineDto["bbMachine"]>>();
  for (const h of await deps.hosts()) {
    if (h.machineProviderId !== PROVIDER_ID || h.phase === "destroyed") continue;
    const r = (await deps.getResource(h.id)) as { machineId?: unknown } | null;
    if (r && typeof r.machineId === "string") index.set(r.machineId, { hostId: h.id, name: h.name, status: h.status, phase: h.phase });
  }
  return index;
}

export function createDashboardHandlers(deps: DashboardDeps) {
  const cacheMs = deps.cacheMs ?? 8_000;
  let cache: { at: number; value: OverviewDto } | null = null;

  async function configured() {
    const c = await deps.client();
    if (!isConfigured(c)) throw new Error(c.error);
    return c;
  }

  async function mustGet(api: InstaboxApi, id: string): Promise<Machine> {
    const m = await api.findMachine(id);
    if (!m) throw new Error(`InstaBox machine ${id} not found`);
    return m;
  }

  function changed() {
    cache = null;
    deps.publish();
  }

  async function overview(): Promise<OverviewDto> {
    if (cache && deps.now() - cache.at < cacheMs) return cache.value;
    const fetchedAt = new Date(deps.now()).toISOString();
    const empty = { items: null, error: null };
    const settings = await deps.settings();
    const c = await deps.client();
    if (!isConfigured(c)) {
      return overviewDto.parse({
        configured: false,
        setupMessage: c.error,
        hubWarning: null,
        fetchedAt,
        account: null,
        accountError: null,
        machines: empty,
        snapshots: empty,
        templates: empty,
      });
    }
    const { api } = c;
    const [me, usage, machines, snapshots, templates, index, hubWarning] = await Promise.allSettled([
      api.me(),
      api.usage(),
      api.listAllMachines(),
      api.listSnapshots(),
      api.listTemplates(),
      machineIndex(deps),
      deps.hubWarning ? deps.hubWarning() : Promise.resolve(null),
    ]);

    if (me.status === "rejected" && me.reason instanceof InstaboxApiError && (me.reason.status === 401 || me.reason.status === 403)) {
      return overviewDto.parse({
        configured: false,
        setupMessage: `InstaBox rejected the API key: ${msg(me.reason)}`,
        hubWarning: null,
        fetchedAt,
        account: null,
        accountError: null,
        machines: empty,
        snapshots: empty,
        templates: empty,
      });
    }

    const machineRows = machines.status === "fulfilled" ? machines.value : [];
    const metricMap = new Map<string, MachineMetric>();
    if (machines.status === "fulfilled") {
      const running = machineRows.filter((m) => isRunning(m)).slice(0, 12);
      await Promise.all(
        running.map(async (m) => {
          try {
            const r = await api.metrics(m.id, undefined, AbortSignal.timeout(4_000));
            const last = r.metrics[r.metrics.length - 1];
            if (last) metricMap.set(m.id, last);
          } catch {
            // Metrics are decoration; the machine list is the page.
          }
        }),
      );
    }
    const indexMap = index.status === "fulfilled" ? index.value : new Map();

    let account: AccountDto | null = null;
    let accountError: string | null = null;
    if (me.status === "rejected") accountError = msg(me.reason);
    else if (usage.status === "rejected") accountError = msg(usage.reason);
    else {
      const u = usage.value;
      const limits = u.limits;
      const unlimited = new Set(limits.unlimited ?? []);
      const limit = (key: string, value: number | undefined) => (unlimited.has(key) ? null : (value ?? null));
      const policy = idlePolicy(me.value);
      const plan = me.value.plans?.find((p) => p.tier === me.value.org?.tier) ?? null;
      const cost = u.cost;
      account = accountDto.parse({
        login: me.value.login,
        orgName: me.value.org?.name ?? me.value.login,
        tier: me.value.org?.tier ?? "unknown",
        manualLifecycle: policy.manualLifecycle,
        alwaysOnAllowed: me.value.alwaysOnAllowed === true,
        canDisableIdle: policy.canDisable,
        idleChoicesSeconds: policy.choices,
        defaultIdleSeconds: settings.idlePauseSeconds > 0 ? settings.idlePauseSeconds : null,
        maxMachines: limit("maxMachines", limits.maxMachines),
        maxRunning: plan?.maxRunning ?? null,
        maxSnapshots: limit("maxSnapshots", limits.maxSnapshots),
        maxStoredGiB: limit("maxStoredGiB", limits.maxStoredGiB),
        machinesUsed: u.machines,
        snapshotsUsed: u.snapshots,
        storedBytes: u.storedBytes ?? null,
        logicalBytes: u.logicalBytes ?? null,
        allocatedDiskGiB: u.allocatedDiskGiB ?? null,
        vcpuHours: cost?.vcpuHours ?? null,
        memGiBHours: cost?.memGiBHours ?? null,
        storageGiBHours: cost?.storageGiBHours ?? null,
        egressGiB: cost?.egressGiB ?? null,
        costUSD: cost?.costUSD ?? null,
        allowanceUSD: cost?.allowanceUSD ?? null,
        creditRemainingUSD: cost?.creditRemainingUSD ?? null,
        periodStart: cost?.periodStart ?? null,
        periodEnd: cost?.periodEnd ?? null,
      });
    }

    const value = overviewDto.parse({
      configured: true,
      setupMessage: null,
      hubWarning: hubWarning.status === "fulfilled" ? hubWarning.value : null,
      fetchedAt,
      account,
      accountError,
      machines:
        machines.status === "fulfilled"
          ? { items: machineRows.map((m) => toMachineDto(m, indexMap.get(m.id) ?? null, metricMap.get(m.id) ?? null)), error: null }
          : { items: null, error: msg(machines.reason) },
      snapshots:
        snapshots.status === "fulfilled"
          ? { items: snapshots.value.map((s) => toSnapshotDto(s, settings.snapshotId)), error: null }
          : { items: null, error: msg(snapshots.reason) },
      templates:
        templates.status === "fulfilled"
          ? {
              items: templates.value
                .filter((t) => t.hidden !== true && t.creatable !== false)
                .map((t) =>
                  templateDto.parse({
                    id: t.id,
                    version: t.version,
                    description: t.description ?? null,
                    vcpus: t.defaultSpec?.vcpus ?? null,
                    memMiB: t.defaultSpec?.memMiB ?? null,
                    diskGiB: t.defaultSpec?.persistentDiskGiB ?? null,
                    default: t.default === true || t.latest === true,
                  }),
                ),
              error: null,
            }
          : { items: null, error: msg(templates.reason) },
    });
    cache = { at: deps.now(), value };
    return value;
  }

  const withStore = async <T>(fn: (s: ProjectStore) => Promise<T>): Promise<T> => {
    if (!deps.projectStore) throw new Error("Project storage is not available in this plugin build");
    const r = await fn(deps.projectStore);
    deps.publish();
    return r;
  };
  const github = () => {
    if (!deps.github) throw new Error("The GitHub repo picker is not available in this plugin build");
    return deps.github;
  };

  return {
    projects_list: async () => ({ projects: deps.projectStore ? await deps.projectStore.list() : [] }),
    project_create: async ({ name }: { name: string }) => withStore((s) => s.create(name)),
    project_rename: async ({ name, newName }: { name: string; newName: string }) => withStore((s) => s.rename(name, newName)),
    project_delete: async ({ name, confirmName }: { name: string; confirmName: string }) => {
      await withStore((s) => s.delete(name, confirmName));
      return { ok: true as const };
    },
    project_repo_add: async ({ project, repo }: { project: string; repo: { name: string; url: string; branch?: string } }) => withStore((s) => s.addRepo(project, repo)),
    project_repo_update: async ({ project, repoName, repo }: { project: string; repoName: string; repo: { name: string; url: string; branch?: string } }) =>
      withStore((s) => s.updateRepo(project, repoName, repo)),
    project_repo_remove: async ({ project, repoName }: { project: string; repoName: string }) => withStore((s) => s.removeRepo(project, repoName)),
    repos_list: async ({ refresh }: { refresh: boolean }) => github().repos(refresh),
    repo_branches: async ({ owner, repo, refresh }: { owner: string; repo: string; refresh: boolean }) => github().branches(owner, repo, refresh),

    instabox_overview: async () => overview(),

    instabox_summary: async () => {
      const o = await overview();
      const items = o.machines.items;
      return items === null ? { running: null, total: null } : { running: items.filter((m) => m.state === "running" && m.ready).length, total: items.length };
    },

    instabox_idle_choices: async (): Promise<IdleChoicesDto> => {
      const s = await deps.settings();
      const c = await deps.client();
      const fallback = {
        choices: [] as number[],
        defaultSeconds: s.idlePauseSeconds > 0 ? s.idlePauseSeconds : null,
        manualLifecycle: false,
        alwaysOnAllowed: false,
        canDisable: false,
        error: null as string | null,
      };
      if (!isConfigured(c)) return idleChoicesDto.parse({ ...fallback, error: c.error });
      try {
        const me = await c.api.me();
        const p = idlePolicy(me);
        return idleChoicesDto.parse({
          choices: p.choices,
          defaultSeconds: s.idlePauseSeconds > 0 ? s.idlePauseSeconds : null,
          manualLifecycle: p.manualLifecycle,
          alwaysOnAllowed: me.alwaysOnAllowed === true,
          canDisable: p.canDisable,
          error: null,
        });
      } catch (err) {
        return idleChoicesDto.parse({ ...fallback, error: msg(err) });
      }
    },

    instabox_lifecycle: async ({ machineId: id, action, requestId: req }: { machineId: string; action: "start" | "stop" | "suspend" | "resume"; requestId: string }) => {
      const { api } = await configured();
      const m = await mustGet(api, id);
      if (TRANSITIONAL_STATES.has(m.state)) throw new Error(`${m.name} is ${m.state}; wait for that operation to finish`);
      const verb = { start: "Starting", stop: "Stopping", suspend: "Pausing", resume: "Resuming" }[action];
      if (action === "start") {
        if (m.state === "running") return { ok: true as const, message: `${m.name} is already running` };
        await api.lifecycle(id, "start", undefined, req);
        changed();
        return { ok: true as const, message: `Starting ${m.name}${m.state === "suspended" ? " (resuming the paused machine)" : ""}` };
      }
      if (action === "resume") {
        if (m.state === "running") return { ok: true as const, message: `${m.name} is already running` };
        if (!SUSPENDED_STATES.has(m.state)) throw new Error(`${m.name} is ${m.state}; Resume is only for a paused machine (use Start)`);
        await api.lifecycle(id, "resume", undefined, req);
        changed();
        return { ok: true as const, message: `Resuming ${m.name}` };
      }
      if (action === "suspend") {
        if (m.state === "suspended") return { ok: true as const, message: `${m.name} is already paused` };
        if (STOPPED_STATES.has(m.state)) throw new Error(`${m.name} is stopped; Start it before pausing`);
        if (m.state !== "running") throw new Error(`${m.name} is ${m.state}; Pause needs a running machine`);
        await api.lifecycle(id, "suspend", undefined, req);
        changed();
        return { ok: true as const, message: `Pausing ${m.name} (memory and processes are kept)` };
      }
      if (m.state === "suspended") throw new Error(`${m.name} is paused. InstaBox refuses Stop on a paused machine (409); Start it first, then Stop.`);
      if (m.state === "stopped") return { ok: true as const, message: `${m.name} is already stopped` };
      if (m.state !== "running") throw new Error(`${m.name} is ${m.state}; Stop needs a running machine`);
      await api.lifecycle(id, "stop", undefined, req);
      changed();
      return { ok: true as const, message: `Stopping ${m.name} (processes end; files stay)` };
    },

    instabox_save_snapshot: async ({ machineId: id, name, description, requestId: req }: { machineId: string; name: string; description?: string; requestId: string }) => {
      const { api } = await configured();
      const m = await mustGet(api, id);
      if (m.state === "deleting") throw new Error(`${m.name} is being deleted`);
      const snap = await api.createSnapshot(id, { name, ...(description ? { description } : {}) }, req);
      changed();
      return {
        ok: true as const,
        message:
          snap.status === "pending"
            ? `Saving ${m.name} as snapshot ${name} (pending; includes /data/home, so logins and keys go with it)`
            : `Saved ${m.name} as snapshot ${name} (includes /data/home, so logins and keys go with it)`,
      };
    },

    instabox_set_idle: async ({ machineId: id, seconds, requestId: req }: { machineId: string; seconds: number; requestId: string }) => {
      const { api } = await configured();
      const m = await mustGet(api, id);
      const me = await api.me();
      const value = normalizeIdleSeconds(me, seconds);
      if (value === null) throw new Error("Idle pause is required");
      if (m.autoSuspendAfterSeconds === value) return { ok: true as const, message: `${m.name} already pauses after ${value === 0 ? "never (off)" : `${value / 60} min`}` };
      await api.updateMachine(id, { autoSuspendAfterSeconds: value }, req);
      changed();
      return { ok: true as const, message: `${m.name} now pauses after ${value === 0 ? "never (off)" : `${value / 60} min`} idle` };
    },

    instabox_rename: async ({ machineId: id, name, labels, requestId: req }: { machineId: string; name: string; labels: Record<string, string> | null; requestId: string }) => {
      const { api } = await configured();
      const m = await mustGet(api, id);
      let metadata = m.metadata ?? {};
      if (labels !== null) {
        // bb's own labels are not editable here: create/reconcile depend on them.
        metadata = Object.fromEntries(Object.entries(metadata).filter(([k]) => k.startsWith("bb-")));
        for (const [k, v] of Object.entries(labels)) if (!k.startsWith("bb-") && v !== "") metadata[k] = v;
      }
      await api.updateMachine(id, { name, metadata }, req);
      changed();
      return { ok: true as const, message: `Renamed ${m.name} → ${name}${labels !== null ? " and updated labels" : ""}` };
    },

    instabox_create_machine: async ({
      name,
      source,
      idleSeconds,
      asRunner,
      project,
      requestId: req,
    }: {
      name: string | null;
      source: { kind: "template"; templateId: string } | { kind: "snapshot"; snapshotId: string };
      idleSeconds: number | null;
      asRunner: boolean;
      project?: string | null;
      requestId: string;
    }) => {
      if (project && !asRunner) throw new Error("A project needs a bb runner: tick \"Create as a bb runner\"");
      if (asRunner) {
        if (!deps.createMachine) throw new Error("bb machine creation is not available in this plugin build");
        const inputs: Record<string, unknown> = source.kind === "template" ? { template: source.templateId } : { snapshotId: source.snapshotId };
        if (idleSeconds !== null) inputs.autoSuspendAfterSeconds = idleSeconds;
        if (project) {
          const p = deps.projectStore ? await deps.projectStore.get(project) : null;
          if (!p) throw new Error(`Unknown project "${project}"`);
          if (p.repos.length === 0) throw new Error(`Project "${p.name}" has no repos yet`);
          inputs.project = p.name;
        }
        const host = await deps.createMachine({ key: `instabox-page-${req}`, inputs });
        changed();
        return {
          ok: true as const,
          message: `Creating bb machine ${host.name ?? host.hostId} on InstaBox (enrollment runs in Machines).`,
          hostId: host.hostId,
        };
      }
      if (!name) throw new Error("A machine name is required");
      const { api } = await configured();
      let idle: number | null = null;
      if (idleSeconds !== null) idle = normalizeIdleSeconds(await api.me(), idleSeconds);
      const op = await api.createMachine(
        {
          name,
          metadata: { source: "bb-dashboard" },
          // Every machine this plugin creates gets all org proxy Secrets (placeholders only).
          secrets: "all" as const,
          ...(source.kind === "template" ? { templateId: source.templateId } : { snapshotId: source.snapshotId }),
          ...(idle !== null ? { autoSuspendAfterSeconds: idle } : {}),
        },
        req,
      );
      changed();
      return {
        ok: true as const,
        message: `Creating ${name}${idle !== null ? ` with a ${idle === 0 ? "disabled" : `${idle / 60} min`} idle pause` : ""}${op.machineId ? ` (${op.machineId})` : ""}`,
        hostId: null,
      };
    },

    instabox_delete_machine: async ({ machineId: id, confirmName, requestId: req }: { machineId: string; confirmName: string; requestId: string }) => {
      const { api } = await configured();
      const m = await mustGet(api, id);
      if (confirmName !== m.name) throw new Error(`Confirmation does not match: type ${m.name} exactly to delete it`);
      const index = await machineIndex(deps);
      const bb = index.get(id);
      if (bb) {
        throw new Error(`${m.name} is bb machine ${bb.name}. Remove that machine from bb first (Machines → ${bb.hostId}), so bb can tear down its environments; then delete the InstaBox machine here.`);
      }
      try {
        await api.deleteMachine(id, undefined, { idempotencyKey: req, confirm: id });
      } catch (err) {
        if (isNotFound(err)) {
          changed();
          return { ok: true as const, message: `${m.name} was already gone` };
        }
        throw err;
      }
      changed();
      return { ok: true as const, message: `Deleting ${m.name}; its snapshots are kept` };
    },

    instabox_delete_snapshot: async ({ snapshotId: id, confirmName, requestId: req }: { snapshotId: string; confirmName: string; requestId: string }) => {
      const { api } = await configured();
      const s = await deps.settings();
      const all = await api.listSnapshots();
      const snap = all.find((x) => x.id === id);
      if (!snap) throw new Error(`InstaBox snapshot ${id} not found`);
      if (confirmName !== snap.name) throw new Error(`Confirmation does not match: type ${snap.name} exactly to delete it`);
      await api.deleteSnapshot(id, snap.name, req);
      changed();
      return {
        ok: true as const,
        message:
          s.snapshotId === id
            ? `Deleted ${snap.name}. It was the configured runner snapshot; new machines will use the template until you set another snapshotId.`
            : `Deleted snapshot ${snap.name}`,
      };
    },

    instabox_exec: async ({ machineId: id, cmd, timeoutSeconds }: { machineId: string; cmd: string; timeoutSeconds: number }): Promise<ExecResultDto> => {
      const { api } = await configured();
      const before = await mustGet(api, id);
      if (before.state === "deleting" || before.state === "deleted") throw new Error(`${before.name} is being deleted`);
      const res = await api.exec(id, { cmd, timeoutSeconds });
      const settings = await deps.settings();
      const secrets = secretValues(settings);
      const out = redactText(res.stdout ?? "", secrets);
      const err = redactText(res.stderr ?? "", secrets);
      const woke = !isRunning(before);
      if (woke) changed();
      return execResultDto.parse({
        ok: true,
        machineName: before.name,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        truncated: res.truncated,
        stdout: out.text,
        stderr: err.text,
        redacted: out.count + err.count,
        woke,
      });
    },
  };
}

/** Exposed for the sidebar badge: same count the overview's summary uses. */
export function runningCount(items: MachineDto[] | null): number | null {
  return items === null ? null : items.filter((m) => m.state === "running" && m.ready).length;
}
